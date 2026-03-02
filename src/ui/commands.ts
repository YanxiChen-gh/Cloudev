import * as vscode from 'vscode';
import { DaemonClient } from '../client/daemon-client';
import { StateStore } from '../client/state';
import { Environment, Project, MachineClass } from '../types';
import { SidebarProvider } from './sidebar-provider';

export function registerCommands(
  context: vscode.ExtensionContext,
  client: DaemonClient,
  store: StateStore,
  sidebarProvider: SidebarProvider,
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
      // Pick provider if multiple available
      const providers = store.getAvailableProviders();
      if (providers.length === 0) {
        vscode.window.showErrorMessage('No providers available.');
        return;
      }

      let providerId: string | undefined;
      if (providers.length === 1) {
        providerId = providers[0].id;
      } else {
        interface ProviderPickItem extends vscode.QuickPickItem {
          providerId: string;
        }
        const picked = await vscode.window.showQuickPick<ProviderPickItem>(
          providers.map((p) => ({ label: p.displayName, providerId: p.id })),
          { placeHolder: 'Select provider' },
        );
        if (!picked) return;
        providerId = picked.providerId;
      }

      // Provider-specific prompts
      let projectId: string | undefined;
      let branch: string | undefined;
      let machineClassId: string | undefined;

      if (providerId === 'codespaces') {
        // Codespaces: QuickPick from known repos + manual entry
        const knownRepos = [...new Set(
          store.getEnvironments()
            .filter((e) => e.provider === 'codespaces' && e.projectId)
            .map((e) => e.projectId),
        )];

        if (knownRepos.length > 0) {
          interface RepoPickItem extends vscode.QuickPickItem {
            repo?: string;
            manual?: boolean;
          }
          const items: RepoPickItem[] = knownRepos.map((r) => ({
            label: r,
            repo: r,
          }));
          items.push({ label: '$(edit) Enter repo manually...', manual: true });

          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select repository (owner/repo)',
          });
          if (!picked) return;

          if (picked.manual) {
            projectId = await vscode.window.showInputBox({
              prompt: 'Enter repository (owner/repo)',
              placeHolder: 'octocat/Hello-World',
            });
          } else {
            projectId = picked.repo;
          }
        } else {
          projectId = await vscode.window.showInputBox({
            prompt: 'Enter repository (owner/repo)',
            placeHolder: 'octocat/Hello-World',
          });
        }
        if (!projectId) return;

        branch = await vscode.window.showInputBox({
          prompt: 'Branch (leave empty for default)',
          placeHolder: 'main',
        });

        // Machine class picker (required for Codespaces — gh prompts interactively without -m)
        try {
          const classes = await client.listMachineClasses(providerId!, projectId) as MachineClass[];
          if (classes.length > 0) {
            interface ClassPickItem extends vscode.QuickPickItem {
              classId?: string;
            }
            const items: ClassPickItem[] = classes.map((c) => ({
              label: c.name,
              description: c.description || `${c.cpus} CPUs, ${c.memoryGb}GB RAM`,
              classId: c.id,
            }));

            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: 'Select machine type',
            });
            if (!picked) return;
            machineClassId = picked.classId;
          }
        } catch {
          // Skip — provider will default to basicLinux32gb
        }
      } else {
        // Ona: QuickPick from project list, with manual fallback
        try {
          const projects = await client.listProjects(providerId!) as Project[];
          if (projects.length > 0) {
            interface ProjectPickItem extends vscode.QuickPickItem {
              projectId?: string;
              manual?: boolean;
            }
            const items: ProjectPickItem[] = projects.map((p) => ({
              label: p.name,
              description: p.repositoryUrl,
              projectId: p.id,
            }));
            items.push({
              label: '$(edit) Enter ID manually...',
              manual: true,
            });

            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: 'Select project',
            });
            if (!picked) return;

            if (picked.manual) {
              projectId = await vscode.window.showInputBox({
                prompt: 'Enter project ID',
                placeHolder: 'project-xxxx-yyyy',
              });
            } else {
              projectId = picked.projectId;
            }
          } else {
            projectId = await vscode.window.showInputBox({
              prompt: 'Enter project ID',
              placeHolder: 'project-xxxx-yyyy',
            });
          }
        } catch {
          // Fall back to text input if listing fails
          projectId = await vscode.window.showInputBox({
            prompt: 'Enter project ID',
            placeHolder: 'project-xxxx-yyyy',
          });
        }
        if (!projectId) return;

        // Machine class picker (optional)
        try {
          const classes = await client.listMachineClasses(providerId!) as MachineClass[];
          if (classes.length > 0) {
            interface ClassPickItem extends vscode.QuickPickItem {
              classId?: string;
            }
            const items: ClassPickItem[] = classes.map((c) => ({
              label: c.name,
              description: c.description || `${c.cpus} CPUs, ${c.memoryGb}GB RAM`,
              classId: c.id,
            }));

            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: 'Select machine class and region',
            });
            if (!picked) return;
            machineClassId = picked.classId;
          }
        } catch {
          // Skip machine class selection if listing fails
        }
      }
      if (!projectId) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating environment...',
        },
        () => client.createEnvironment(projectId!, {
          providerId,
          branch: branch || undefined,
          machineClassId,
        }),
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
            action?: 'switch' | 'stop' | 'stop-comparing';
            removeEnvId?: string;
          }

          const comparing = pf.sideBySide.filter((s) => s.envId !== pf.activeEnvId);
          const isComparing = comparing.length > 0;

          const items: PortQuickPickItem[] = pf.ports.map((port) => {
            const label_text = pf.portLabels[port];
            return {
              label: `$(globe) localhost:${port}`,
              description: label_text || '',
              detail: 'Open in browser',
              port,
            };
          });

          // Show compared envs when in compare mode
          if (isComparing) {
            items.push(
              { label: 'Comparing', kind: vscode.QuickPickItemKind.Separator } as PortQuickPickItem,
            );
            for (const s of comparing) {
              items.push({
                label: `$(git-compare) ${s.envName}`,
                description: `${s.hostname}.localhost`,
                detail: 'Remove from compare',
                removeEnvId: s.envId,
              });
            }
          }

          items.push(
            { label: '', kind: vscode.QuickPickItemKind.Separator } as PortQuickPickItem,
            { label: '$(arrow-swap) Switch environment', action: 'switch' },
          );
          if (isComparing) {
            items.push({ label: '$(close) Stop comparing', action: 'stop-comparing' });
          }
          items.push(
            { label: '$(debug-disconnect) Stop forwarding', action: 'stop' },
          );

          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: isComparing
              ? `Ports for ${pf.activeEnvName} + ${comparing.length} comparing`
              : `Ports for ${pf.activeEnvName} (${pf.ports.length} ports)`,
          });

          if (!picked) return;
          if (picked.action === 'stop') {
            await client.stopPortForwarding();
          } else if (picked.action === 'stop-comparing') {
            // Remove all compared envs one by one, keeping primary forwarding
            for (const s of comparing) {
              await client.removeCompare(s.envId);
            }
          } else if (picked.action === 'switch') {
            await showEnvPicker();
          } else if (picked.removeEnvId) {
            await client.removeCompare(picked.removeEnvId);
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

        // Use VS Code remote URI — reuses an existing window if already connected
        const remoteAuthority = env.provider === 'codespaces'
          ? `codespaces+${env.id}`
          : `ssh-remote+${env.sshHost}`;
        const uri = vscode.Uri.parse(
          `vscode-remote://${remoteAuthority}${env.workspacePath}`,
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
        if (env.webUrl) {
          items.push({
            label: '$(globe) Open in Dashboard',
            description: env.provider === 'codespaces' ? 'GitHub' : 'Ona',
            action: 'open-dashboard',
          });
        }
        items.push({
          label: '$(terminal) Copy SSH Command',
          description: env.provider === 'codespaces'
            ? `gh codespace ssh -c ${env.id}`
            : `ssh ${env.sshHost}`,
          action: 'copy-ssh-cmd',
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
          case 'open-dashboard':
            if (env.webUrl) {
              await vscode.env.openExternal(vscode.Uri.parse(env.webUrl));
            }
            break;
          case 'copy-ssh-cmd': {
            const sshCmd = env.provider === 'codespaces'
              ? `gh codespace ssh -c ${env.id}`
              : `ssh ${env.sshHost}`;
            await vscode.env.clipboard.writeText(sshCmd);
            vscode.window.showInformationMessage('SSH command copied to clipboard');
            break;
          }
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

        const sshCmd = env.provider === 'codespaces'
          ? `gh codespace ssh -c ${env.id}`
          : `ssh ${env.sshHost}`;
        const lines = [
          `Environment: ${env.name}`,
          `Provider: ${env.provider}`,
          `Branch: ${env.branch}`,
          `SSH: ${sshCmd}`,
          `Repository: ${env.repositoryUrl}`,
          `Status: ${env.status}`,
        ];
        if (env.webUrl) {
          lines.push(`Dashboard: ${env.webUrl}`);
        }

        // Include forwarded ports + public URLs if this env is being forwarded
        const pf = store.getPortForwarding();
        if (pf.activeEnvId === env.id && pf.ports.length > 0) {
          lines.push(`Ports: ${pf.ports.map((p) => {
            const label = pf.portLabels[p];
            const url = pf.portUrls[p];
            let entry = `${p}`;
            if (label) entry += ` (${label})`;
            if (url) entry += ` — ${url}`;
            return entry;
          }).join(', ')}`);
        }

        const text = lines.join('\n');

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
        const port = typeof arg === 'number' ? arg : arg?.port;
        if (!port) return;
        // Always use localhost — tunnel is active when ports are shown
        await vscode.env.openExternal(
          vscode.Uri.parse(`http://localhost:${port}`),
        );
      },
    ),
  );

  // --- Copy Port URL ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.copyPortUrl',
      async (arg?: { port?: number }) => {
        const port = arg?.port;
        if (!port) return;
        await vscode.env.clipboard.writeText(`http://localhost:${port}`);
        vscode.window.showInformationMessage(`Copied http://localhost:${port}`);
      },
    ),
  );

  // --- Copy Port Details ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.copyPortInfo',
      async (arg?: { port?: number }) => {
        const port = arg?.port;
        if (!port) return;
        const pf = store.getPortForwarding();
        const lines = [`Port: ${port}`, `URL: http://localhost:${port}`];
        const label = pf.portLabels[port];
        if (label) lines.push(`Label: ${label}`);
        const url = pf.portUrls[port];
        if (url) lines.push(`Public: ${url}`);
        const conflict = pf.portConflicts[port];
        if (conflict) lines.push(`Warning: ${conflict}`);
        await vscode.env.clipboard.writeText(lines.join('\n'));
        vscode.window.showInformationMessage('Port details copied to clipboard');
      },
    ),
  );

  // --- Open in Dashboard ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.openInDashboard',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store));
        if (!envId) return;
        const env = store.getEnvironment(envId);
        if (!env?.webUrl) {
          vscode.window.showInformationMessage('No dashboard URL available for this environment.');
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(env.webUrl));
      },
    ),
  );

  // --- Copy SSH Command ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.copySshCommand',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'running'));
        if (!envId) return;
        const env = store.getEnvironment(envId);
        if (!env) return;
        const cmd = env.provider === 'codespaces'
          ? `gh codespace ssh -c ${env.id}`
          : `ssh ${env.sshHost}`;
        await vscode.env.clipboard.writeText(cmd);
        vscode.window.showInformationMessage('SSH command copied to clipboard');
      },
    ),
  );

  // --- Add to Favorites ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.addFavorite',
      async (arg?: { env?: Environment; envId?: string; port?: number }) => {
        if (arg?.port && arg?.envId) {
          sidebarProvider.addFavorite(`port:${arg.envId}:${arg.port}`);
        } else if (arg?.env) {
          sidebarProvider.addFavorite(`env:${arg.env.id}`);
        }
      },
    ),
  );

  // --- Remove from Favorites ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.removeFavorite',
      async (arg?: { env?: Environment; envId?: string; port?: number }) => {
        if (arg?.port && arg?.envId) {
          sidebarProvider.removeFavorite(`port:${arg.envId}:${arg.port}`);
        } else if (arg?.env) {
          sidebarProvider.removeFavorite(`env:${arg.env.id}`);
        }
      },
    ),
  );

  // --- Copy Public URL ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.copyPublicUrl',
      async (arg?: { port?: number }) => {
        const port = arg?.port;
        if (!port) return;
        const pf = store.getPortForwarding();
        const url = pf.portUrls[port];
        if (!url) {
          vscode.window.showInformationMessage('No public URL available for this port.');
          return;
        }
        await vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage(`Copied ${url}`);
      },
    ),
  );

  // --- View Daemon Log ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.viewDaemonLog',
      async () => {
        const logPath = vscode.Uri.file(
          require('path').join(require('os').homedir(), '.cloudev', 'daemon.log'),
        );
        try {
          const doc = await vscode.workspace.openTextDocument(logPath);
          await vscode.window.showTextDocument(doc);
        } catch {
          vscode.window.showInformationMessage('No daemon log found at ~/.cloudev/daemon.log');
        }
      },
    ),
  );

  // --- Side-by-Side Web Compare ---
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudev.sideBySide', async () => {
      const runningEnvs = store.getEnvironments().filter((e) => e.status === 'running');
      if (runningEnvs.length < 2) {
        vscode.window.showInformationMessage(
          'Side-by-side requires at least 2 running environments.',
        );
        return;
      }

      interface EnvPickItem extends vscode.QuickPickItem {
        envId: string;
      }

      const items: EnvPickItem[] = runningEnvs.map((env) => ({
        label: env.name,
        description: env.branch,
        envId: env.id,
        picked: true,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select environments for side-by-side comparison',
        canPickMany: true,
      });

      if (!picked || picked.length < 2) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Starting side-by-side web compare...',
        },
        () => client.startSideBySide(picked.map((p) => p.envId)),
      );

      // Show the hostname URLs for all ports
      const pf = store.getPortForwarding();
      if (pf.sideBySide.length > 0 && pf.ports.length > 0) {
        const allUrls: string[] = [];
        for (const s of pf.sideBySide) {
          for (const port of pf.ports) {
            allUrls.push(`http://${s.hostname}.localhost:${port}`);
          }
        }
        const summary = pf.sideBySide
          .map((s) => `${s.envName} → ${s.hostname}.localhost`)
          .join(', ');
        vscode.window.showInformationMessage(
          `Side-by-side active: ${summary}. Ports: ${pf.ports.join(', ')}`,
          'Copy URLs',
        ).then((action) => {
          if (action === 'Copy URLs') {
            vscode.env.clipboard.writeText(allUrls.join('\n'));
          }
        });
      }
    }),
  );

  // --- Stop Side-by-Side ---
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudev.stopSideBySide', async () => {
      await client.stopSideBySide();
      vscode.window.showInformationMessage('Side-by-side mode stopped.');
    }),
  );

  // --- Add to Compare (right-click on running env while forwarding) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.addCompare',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id ?? (await pickEnvironment(store, 'running'));
        if (!envId) return;

        const pf = store.getPortForwarding();
        if (!pf.activeEnvId) {
          vscode.window.showInformationMessage(
            'Start port forwarding on an environment first, then compare.',
          );
          return;
        }
        if (envId === pf.activeEnvId) {
          vscode.window.showInformationMessage(
            'This environment is already the active forwarding target.',
          );
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Adding ${store.getEnvironment(envId)?.name ?? envId} to compare...`,
          },
          () => client.addCompare(envId),
        );

        // Pick best web port and show actionable notification
        const updatedPf = store.getPortForwarding();
        const added = updatedPf.sideBySide.find((s) => s.envId === envId);
        const primary = updatedPf.sideBySide.find((s) => s.envId === updatedPf.activeEnvId);
        if (!added || !primary || updatedPf.ports.length === 0) return;

        const lastUsed = context.workspaceState.get<number>(LAST_COMPARE_PORT_KEY);
        const webPort = pickWebPort(updatedPf.ports, updatedPf.portLabels, lastUsed);

        // Collect all URLs for "Copy URLs" — primary first, then all compared envs
        const allUrls: string[] = [];
        for (const s of updatedPf.sideBySide) {
          for (const port of updatedPf.ports) {
            allUrls.push(`http://${s.hostname}.localhost:${port}`);
          }
        }

        const action = await vscode.window.showInformationMessage(
          `Comparing ${primary.envName} ↔ ${added.envName} (port ${webPort})`,
          'Open Both', 'Other port...', 'Copy URLs',
        );

        if (action === 'Open Both') {
          context.workspaceState.update(LAST_COMPARE_PORT_KEY, webPort);
          // Open primary first, then compared env — gives user two tabs to arrange
          await vscode.env.openExternal(
            vscode.Uri.parse(`http://${primary.hostname}.localhost:${webPort}`),
          );
          await vscode.env.openExternal(
            vscode.Uri.parse(`http://${added.hostname}.localhost:${webPort}`),
          );
        } else if (action === 'Other port...') {
          interface PortPickItem extends vscode.QuickPickItem {
            port: number;
          }
          const items: PortPickItem[] = updatedPf.ports.map((p) => ({
            label: `localhost:${p}`,
            description: updatedPf.portLabels[p] || '',
            detail: `${primary.hostname}.localhost:${p}  ↔  ${added.hostname}.localhost:${p}`,
            port: p,
          }));
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: `Pick a port to open for both environments`,
          });
          if (picked) {
            context.workspaceState.update(LAST_COMPARE_PORT_KEY, picked.port);
            await vscode.env.openExternal(
              vscode.Uri.parse(`http://${primary.hostname}.localhost:${picked.port}`),
            );
            await vscode.env.openExternal(
              vscode.Uri.parse(`http://${added.hostname}.localhost:${picked.port}`),
            );
          }
        } else if (action === 'Copy URLs') {
          await vscode.env.clipboard.writeText(allUrls.join('\n'));
        }
      },
    ),
  );

  // --- Remove from Compare ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.removeCompare',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id;
        if (!envId) return;

        await client.removeCompare(envId);
      },
    ),
  );

  // --- Open Compare (open both primary + compared env in browser) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.openCompare',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id;
        if (!envId) return;

        const pf = store.getPortForwarding();
        const entry = pf.sideBySide.find((s) => s.envId === envId);
        const primary = pf.sideBySide.find((s) => s.envId === pf.activeEnvId);
        if (!entry || !primary || pf.ports.length === 0) return;

        const lastUsed = context.workspaceState.get<number>(LAST_COMPARE_PORT_KEY);
        const webPort = pickWebPort(pf.ports, pf.portLabels, lastUsed);

        context.workspaceState.update(LAST_COMPARE_PORT_KEY, webPort);
        await vscode.env.openExternal(
          vscode.Uri.parse(`http://${primary.hostname}.localhost:${webPort}`),
        );
        await vscode.env.openExternal(
          vscode.Uri.parse(`http://${entry.hostname}.localhost:${webPort}`),
        );
      },
    ),
  );

  // --- Sync Shell History ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'cloudev.syncHistory',
      async (node?: { env?: Environment }) => {
        const envId = node?.env?.id; // undefined = all running envs
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: envId
              ? `Syncing history with ${store.getEnvironment(envId)?.name ?? envId}...`
              : 'Syncing shell history with all running environments...',
          },
          () => client.syncHistory(envId),
        );
        const state = store.getShellHistory();
        vscode.window.showInformationMessage(
          `Shell history synced (${state.entryCount} commands).`,
        );
      },
    ),
  );

  // --- Clear Shell History ---
  context.subscriptions.push(
    vscode.commands.registerCommand('cloudev.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all synced shell history? This cannot be undone.',
        { modal: true },
        'Clear',
      );
      if (confirm !== 'Clear') return;
      await client.clearHistory();
      vscode.window.showInformationMessage('Shell history cleared.');
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Web port heuristic for compare notifications
// ---------------------------------------------------------------------------

const LAST_COMPARE_PORT_KEY = 'cloudev.lastComparePort';

const WEB_KEYWORDS = [
  'nginx', 'node', 'vite', 'next', 'webpack', 'rails', 'django',
  'gunicorn', 'uvicorn', 'flask', 'express', 'http', 'web', 'app', 'server',
];

const WELL_KNOWN_WEB_PORTS = [3000, 8080, 5173, 4200, 8000, 5000, 1776];

/**
 * Pick the most likely web port from a list of forwarded ports.
 *
 * Priority:
 * 1. lastUsedPort — if it's in the current port list, reuse it.
 * 2. Process name heuristic — first port whose label contains a web-ish keyword.
 * 3. Well-known web ports — first match from a ranked list.
 * 4. Lowest port — ultimate fallback.
 */
function pickWebPort(
  ports: number[],
  labels: Record<number, string>,
  lastUsedPort?: number,
): number {
  if (ports.length === 0) return 0;

  // 1. Last used
  if (lastUsedPort !== undefined && ports.includes(lastUsedPort)) {
    return lastUsedPort;
  }

  // 2. Label heuristic
  for (const port of ports) {
    const label = (labels[port] ?? '').toLowerCase();
    if (label && WEB_KEYWORDS.some((kw) => label.includes(kw))) {
      return port;
    }
  }

  // 3. Well-known web ports
  for (const wk of WELL_KNOWN_WEB_PORTS) {
    if (ports.includes(wk)) return wk;
  }

  // 4. Lowest
  return ports[0];
}

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
