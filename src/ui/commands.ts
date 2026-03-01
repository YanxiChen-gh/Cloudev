import * as vscode from 'vscode';
import { DaemonClient } from '../client/daemon-client';
import { StateStore } from '../client/state';
import { Environment } from '../types';

export function registerCommands(
  context: vscode.ExtensionContext,
  client: DaemonClient,
  store: StateStore,
): void {
  // --- Start Environment ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.startEnvironment',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'stopped'));
        if (!envId) return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Starting environment...',
          },
          () => client.startEnvironment(envId),
        );
      },
    ),
  );

  // --- Stop Environment ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.stopEnvironment',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'running'));
        if (!envId) return;

        const env = store.getEnvironment(envId);
        const confirm = await vscode.window.showWarningMessage(
          `Stop environment "${env?.name ?? envId}"? Running processes will be terminated.`,
          { modal: true },
          'Stop',
        );
        if (confirm !== 'Stop') return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Stopping environment...',
          },
          () => client.stopEnvironment(envId),
        );
      },
    ),
  );

  // --- Restart Environment ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.restartEnvironment',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'running'));
        if (!envId) return;

        const env = store.getEnvironment(envId);
        const confirm = await vscode.window.showWarningMessage(
          `Restart environment "${env?.name ?? envId}"? This will stop and start the environment to pick up new env vars and secrets.`,
          { modal: true },
          'Restart',
        );
        if (confirm !== 'Restart') return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Restarting environment "${env?.name ?? envId}"...`,
            cancellable: false,
          },
          () => client.restartEnvironment(envId),
        );
      },
    ),
  );

  // --- Create Environment ---
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudev.createEnvironment', async () => {
      const projectId = await vscode.window.showInputBox({
        prompt: 'Enter project ID',
        placeHolder: 'project-xxxx-yyyy',
      });
      if (!projectId) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating environment...',
        },
        () => client.createEnvironment(projectId),
      );

      vscode.window.showInformationMessage('Environment created successfully.');
    }),
  );

  // --- Delete Environment ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.deleteEnvironment',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'stopped'));
        if (!envId) return;

        const env = store.getEnvironment(envId);
        const confirm = await vscode.window.showWarningMessage(
          `Delete environment "${env?.name ?? envId}"? This cannot be undone.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Deleting environment...',
          },
          () => client.deleteEnvironment(envId),
        );
      },
    ),
  );

  // --- Start Port Forwarding ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.startPortForwarding',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'running'));
        if (!envId) return;

        await client.startPortForwarding(envId);
      },
    ),
  );

  // --- Stop Port Forwarding ---
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudev.stopPortForwarding', async () => {
      await client.stopPortForwarding();
    }),
  );

  // --- Switch Port Forwarding (status bar click) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.switchPortForwarding',
      async () => {
        const pf = store.getPortForwarding();

        // If forwarding is active, show port list + management options
        if (pf.status === 'active' && pf.activeEnvId) {
          interface PortQuickPickItem extends vscode.QuickPickItem {
            port?: number;
            action?: 'switch' | 'stop';
          }

          const items: PortQuickPickItem[] = pf.ports.map((port) => {
            const label_text = pf.portLabels[port];
            return {
              label: `$(globe) localhost:${port}`,
              description: label_text || '',
              detail: 'Open in browser',
              port,
            };
          });

          items.push(
            { label: '', kind: vscode.QuickPickItemKind.Separator } as PortQuickPickItem,
            { label: '$(arrow-swap) Switch environment', action: 'switch' },
            { label: '$(debug-disconnect) Stop forwarding', action: 'stop' },
          );

          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Ports for ${pf.activeEnvName} (${pf.ports.length} ports)`,
          });

          if (!picked) return;
          if (picked.action === 'stop') {
            await client.stopPortForwarding();
          } else if (picked.action === 'switch') {
            // Fall through to env picker below
            await showEnvPicker();
          } else if (picked.port) {
            await vscode.env.openExternal(
              vscode.Uri.parse(`http://localhost:${picked.port}`),
            );
          }
          return;
        }

        // No active forwarding — show env picker
        await showEnvPicker();

        async function showEnvPicker() {
          const running = store
            .getEnvironments()
            .filter((e) => e.status === 'running');

          interface EnvQuickPickItem extends vscode.QuickPickItem {
            envId?: string;
          }

          const items: EnvQuickPickItem[] = running.map((env) => ({
            label: env.name,
            description: env.branch,
            envId: env.id,
          }));

          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select environment to forward ports',
          });

          if (picked?.envId) {
            await client.startPortForwarding(picked.envId);
          }
        }
      },
    ),
  );

  // --- Open in New Window ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.openInNewWindow',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'running'));
        if (!envId) return;

        const env = store.getEnvironment(envId);
        if (!env) return;

        const sshHost = `${envId}.gitpod.environment`;

        // Build remote path from checkoutLocation (already in env data, no SSH needed)
        const remoteWorkDir = env.checkoutLocation
          ? `/workspaces/${env.checkoutLocation}`
          : '/workspaces';

        const uri = vscode.Uri.parse(
          `vscode-remote://ssh-remote+${sshHost}${remoteWorkDir}`,
        );
        await vscode.commands.executeCommand('vscode.openFolder', uri, {
          forceNewWindow: true,
        });
      },
    ),
  );

  // --- Refresh ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.refreshEnvironments',
      async () => {
        await client.refresh();
      },
    ),
  );

  // --- Environment Actions QuickPick (single-click on tree item) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.envActions',
      async (node?: { env?: Environment; isForwarding?: boolean }) => {
        const env = node?.env;
        if (!env) return;

        const isForwarding = node?.isForwarding ?? false;

        interface ActionItem extends vscode.QuickPickItem {
          action: string;
        }

        const items: ActionItem[] = [];

        if (env.status === 'running') {
          items.push({
            label: '$(link-external) Connect',
            description: 'Open in new VS Code window',
            action: 'connect',
          });
          if (isForwarding) {
            items.push({
              label: '$(debug-disconnect) Stop Port Forwarding',
              action: 'stop-forwarding',
            });
          } else {
            items.push({
              label: '$(plug) Forward Ports',
              action: 'start-forwarding',
            });
          }
          items.push({
            label: '$(debug-restart) Restart',
            description: 'Pick up new env vars and secrets',
            action: 'restart',
          });
          items.push({
            label: '$(debug-stop) Stop',
            action: 'stop',
          });
        } else if (env.status === 'stopped') {
          items.push({
            label: '$(play) Start',
            action: 'start',
          });
          items.push({
            label: '$(trash) Delete',
            action: 'delete',
          });
        }

        // Always available
        items.push({
          label: '$(copy) Copy SSH Host',
          description: `${env.id}.gitpod.environment`,
          action: 'copy-ssh',
        });
        items.push({
          label: '$(copy) Copy Repository URL',
          description: env.repositoryUrl,
          action: 'copy-repo',
        });

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `${env.name} — ${env.branch}`,
        });
        if (!picked) return;

        switch (picked.action) {
          case 'connect':
            await vscode.commands.executeCommand('cloudev.openInNewWindow', { env });
            break;
          case 'start-forwarding':
            await client.startPortForwarding(env.id);
            break;
          case 'stop-forwarding':
            await client.stopPortForwarding();
            break;
          case 'restart':
            await vscode.commands.executeCommand('cloudev.restartEnvironment', { env });
            break;
          case 'stop':
            await vscode.commands.executeCommand('cloudev.stopEnvironment', { env });
            break;
          case 'start':
            await vscode.commands.executeCommand('cloudev.startEnvironment', { env });
            break;
          case 'delete':
            await vscode.commands.executeCommand('cloudev.deleteEnvironment', { env });
            break;
          case 'copy-ssh':
            await vscode.env.clipboard.writeText(`${env.id}.gitpod.environment`);
            vscode.window.showInformationMessage('SSH host copied to clipboard');
            break;
          case 'copy-repo':
            await vscode.env.clipboard.writeText(env.repositoryUrl);
            vscode.window.showInformationMessage('Repository URL copied to clipboard');
            break;
        }
      },
    ),
  );

  // --- Copy Environment Details (context menu) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.copyEnvInfo',
      async (node?: { env?: Environment }) => {
        const env = node?.env;
        if (!env) return;

        const text = [
          `Environment: ${env.name}`,
          `Branch: ${env.branch}`,
          `SSH Host: ${env.id}.gitpod.environment`,
          `Repository: ${env.repositoryUrl}`,
          `Status: ${env.status}`,
        ].join('\n');

        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('Environment details copied to clipboard');
      },
    ),
  );

  // --- Open Port in Browser ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.openPort',
      async (arg?: number | { port?: number }) => {
        // Called with raw port number (from QuickPick) or tree node (from inline icon)
        const port = typeof arg === 'number' ? arg : arg?.port;
        if (!port) return;
        await vscode.env.openExternal(
          vscode.Uri.parse(`http://localhost:${port}`),
        );
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pickEnvironment(
  store: StateStore,
  statusFilter?: string,
): Promise<string | undefined> {
  let envs = store.getEnvironments();
  if (statusFilter) {
    envs = envs.filter((e) => e.status === statusFilter);
  }
  if (envs.length === 0) {
    vscode.window.showInformationMessage(
      `No ${statusFilter ?? ''} environments found.`,
    );
    return undefined;
  }

  interface EnvPickItem extends vscode.QuickPickItem {
    envId: string;
  }

  const items: EnvPickItem[] = envs.map((env) => ({
    label: env.name,
    description: `${env.branch} (${env.status})`,
    envId: env.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an environment',
  });

  return picked?.envId;
}
