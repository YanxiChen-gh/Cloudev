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
        const running = store
          .getEnvironments()
          .filter((e) => e.status === 'running');
        const pf = store.getPortForwarding();

        interface EnvQuickPickItem extends vscode.QuickPickItem {
          envId?: string;
          action?: 'stop';
        }

        const items: EnvQuickPickItem[] = running.map((env) => ({
          label: env.name,
          description: env.branch,
          detail:
            pf.activeEnvId === env.id
              ? '$(plug) Currently forwarding'
              : undefined,
          envId: env.id,
        }));
        items.push({
          label: '$(debug-disconnect) Stop forwarding',
          description: '',
          action: 'stop',
        });

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select environment to forward ports',
        });

        if (!picked) return;
        if (picked.action === 'stop') {
          await client.stopPortForwarding();
        } else if (picked.envId) {
          await client.startPortForwarding(picked.envId);
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
