import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DaemonClient } from './client/daemon-client';
import { StateStore } from './client/state';
import { SidebarProvider } from './ui/sidebar-provider';
import { StatusBarManager } from './ui/status-bar';
import { registerCommands } from './ui/commands';
import { getExtensionVersion } from './version';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // 1. Create daemon client
  const client = new DaemonClient();

  // 2. Connect to daemon (spawns one if needed)
  try {
    await client.connect();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Cloudev: Failed to connect to daemon: ${(err as Error).message}`,
    );
  }

  // 3. Create state store
  const store = new StateStore(client);

  // 4. Subscribe to state updates + check daemon version
  if (client.isConnected()) {
    try {
      const { daemonVersion } = await client.subscribe();
      const extVersion = getExtensionVersion();
      if (extVersion !== 'unknown' && (!daemonVersion || daemonVersion !== extVersion)) {
        console.log(`Cloudev: daemon version mismatch (daemon=${daemonVersion ?? 'old'}, extension=${extVersion}), restarting`);
        await restartDaemon(client);
        await client.subscribe();
      }
    } catch (err) {
      vscode.window.showWarningMessage(
        `Cloudev: Failed to subscribe: ${(err as Error).message}`,
      );
    }
  }

  // 5. Create log output channel — VS Code manages rotation and level filtering
  const output = vscode.window.createOutputChannel('Cloudev', { log: true });
  context.subscriptions.push(output);

  // 6. Register sidebar tree view
  const sidebarProvider = new SidebarProvider(store, context);
  const treeView = vscode.window.createTreeView('cloudev.environments', {
    treeDataProvider: sidebarProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // 6. Register status bar (pass client for daemon health tracking)
  const statusBar = new StatusBarManager(store, client);
  context.subscriptions.push(statusBar);

  // Set initial daemon health
  statusBar.setDaemonHealth(client.isConnected() ? 'connected' : 'disconnected');

  // 7. Register commands
  registerCommands(context, client, store, sidebarProvider);

  // 8. Register startDaemon command
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudev.startDaemon', async () => {
      statusBar.setDaemonHealth('connecting');
      try {
        if (client.isConnected()) {
          await client.disconnect();
        }
        await client.connect();
        await client.subscribe();
        statusBar.setDaemonHealth('connected');
      } catch (err) {
        statusBar.setDaemonHealth('disconnected');
        vscode.window.showErrorMessage(
          `Cloudev: Failed to start daemon: ${(err as Error).message}`,
        );
      }
    }),
  );

  // 9. Handle reconnection — re-subscribe + version check
  client.on('reconnected', async () => {
    statusBar.setDaemonHealth('connected');
    try {
      const { daemonVersion } = await client.subscribe();
      const extVersion = getExtensionVersion();
      if (extVersion !== 'unknown' && (!daemonVersion || daemonVersion !== extVersion)) {
        await restartDaemon(client);
        await client.subscribe();
        statusBar.setDaemonHealth('connected');
      }
    } catch {
      // Will retry on next reconnect
    }
  });

  // 10. Connection status notifications
  client.on('disconnected', () => {
    statusBar.setDaemonHealth('disconnected');
  });
  client.on('connected', () => {
    statusBar.setDaemonHealth('connected');
  });

  store.on('connection-lost', () => {
    vscode.window.setStatusBarMessage(
      '$(warning) Cloudev: disconnected from daemon',
      5000,
    );
  });
  store.on('connection-restored', () => {
    vscode.window.setStatusBarMessage(
      '$(check) Cloudev: reconnected to daemon',
      3000,
    );
  });

  // 11. Configure shell history periodic sync from settings
  const sendHistoryConfig = () => {
    if (!client.isConnected()) return;
    const minutes = vscode.workspace
      .getConfiguration('cloudev')
      .get<number>('shellHistory.periodicSyncMinutes', 0);
    client.configureHistory(minutes).catch(() => {});
  };
  sendHistoryConfig();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cloudev.shellHistory.periodicSyncMinutes')) {
        sendHistoryConfig();
      }
    }),
  );

  // 12. Configure binary path overrides from settings
  const sendBinaryConfig = () => {
    if (!client.isConnected()) return;
    const config = vscode.workspace.getConfiguration('cloudev');
    const overrides: Record<string, string | undefined> = {
      gitpod: config.get<string>('binaryPaths.gitpod') || undefined,
      gh: config.get<string>('binaryPaths.gh') || undefined,
      ssh: config.get<string>('binaryPaths.ssh') || undefined,
      lsof: config.get<string>('binaryPaths.lsof') || undefined,
    };
    if (Object.values(overrides).some((v) => v)) {
      client.configureBinaries(overrides).catch(() => {});
    }
  };
  sendBinaryConfig();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cloudev.binaryPaths')) {
        sendBinaryConfig();
      }
    }),
  );

  // 13. Log forwarding + history errors, detect VS Code Remote conflicts
  let lastPfError: string | undefined;
  let lastHistoryError: string | undefined;
  let shownVscodeRemoteHint = false;
  let lastIsForwarding = false;
  store.on('changed', () => {
    const pf = store.getPortForwarding();

    // Update context key for "Compare with this env" menu visibility
    const isForwarding = pf.activeEnvId !== null && pf.status === 'active';
    if (isForwarding !== lastIsForwarding) {
      lastIsForwarding = isForwarding;
      vscode.commands.executeCommand('setContext', 'cloudev.isForwarding', isForwarding);
    }
    if (pf.status === 'error' && pf.error && pf.error !== lastPfError) {
      lastPfError = pf.error;
      output.error(`Port forwarding error: ${pf.error}`);
    } else if (pf.status !== 'error') {
      lastPfError = undefined;
    }

    const sh = store.getShellHistory();
    if (sh.status === 'error' && sh.error && sh.error !== lastHistoryError) {
      lastHistoryError = sh.error;
      output.error(`Shell history sync error: ${sh.error}`);
    } else if (sh.status !== 'error') {
      lastHistoryError = undefined;
    }

    // One-time hint when VS Code Remote SSH is holding forwarded ports
    if (!shownVscodeRemoteHint && pf.status === 'active') {
      const hasVscodeConflict = Object.values(pf.portConflicts).some(
        (reason) => reason.includes('VS Code Remote'),
      );
      if (hasVscodeConflict) {
        shownVscodeRemoteHint = true;
        vscode.window.showInformationMessage(
          'VS Code Remote SSH is also forwarding ports and may override Cloudev. ' +
          'To let Cloudev manage ports exclusively, disable VS Code auto-forwarding.',
          'Disable Auto-Forward', 'Dismiss',
        ).then((action) => {
          if (action === 'Disable Auto-Forward') {
            vscode.workspace.getConfiguration('remote').update(
              'autoForwardPorts', false, vscode.ConfigurationTarget.Global,
            );
            vscode.window.showInformationMessage('Auto port forwarding disabled. Reload the Remote SSH window for it to take effect.');
          }
        });
      }
    }
  });

  // 12. Clean up on deactivation
  context.subscriptions.push({
    dispose: () => {
      client.disconnect();
    },
  });
}

export function deactivate(): void {
  // Cleanup handled by context.subscriptions disposal
}

async function restartDaemon(client: DaemonClient): Promise<void> {
  // Kill old daemon via PID file
  const pidPath = path.join(os.homedir(), '.cloudev', 'daemon.pid');
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (pid > 0) {
      process.kill(pid, 'SIGTERM');
      // Wait for daemon to exit (up to 5s)
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; } // Process gone
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch {
    // PID file missing or process already gone
  }

  // Reconnect — auto-spawns new daemon
  await client.disconnect();
  await client.connect();
}
