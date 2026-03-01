import * as vscode from 'vscode';
import { DaemonClient } from './client/daemon-client';
import { StateStore } from './client/state';
import { SidebarProvider } from './ui/sidebar-provider';
import { StatusBarManager } from './ui/status-bar';
import { registerCommands } from './ui/commands';

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

  // 4. Subscribe to state updates
  if (client.isConnected()) {
    try {
      await client.subscribe();
    } catch (err) {
      vscode.window.showWarningMessage(
        `Cloudev: Failed to subscribe: ${(err as Error).message}`,
      );
    }
  }

  // 5. Create output channel for user-visible logs
  const output = vscode.window.createOutputChannel('Cloudev');
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

  // 9. Handle reconnection — re-subscribe to get fresh state
  client.on('reconnected', async () => {
    statusBar.setDaemonHealth('connected');
    try {
      await client.subscribe();
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

  // 11. Log forwarding errors to output channel
  let lastPfError: string | undefined;
  store.on('changed', () => {
    const pf = store.getPortForwarding();
    if (pf.status === 'error' && pf.error && pf.error !== lastPfError) {
      lastPfError = pf.error;
      const ts = new Date().toLocaleTimeString();
      output.appendLine(`[${ts}] Port forwarding error: ${pf.error}`);
    } else if (pf.status !== 'error') {
      lastPfError = undefined;
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
