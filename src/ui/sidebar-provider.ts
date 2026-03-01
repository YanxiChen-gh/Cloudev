import * as vscode from 'vscode';
import { StateStore } from '../client/state';
import { Environment } from '../types';

// ---------------------------------------------------------------------------
// Tree node types
// ---------------------------------------------------------------------------

export type TreeNode = ProjectNode | EnvironmentNode | PortNode;

export class ProjectNode extends vscode.TreeItem {
  readonly kind = 'project' as const;

  constructor(
    public readonly projectName: string,
    public readonly environments: Environment[],
  ) {
    super(projectName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'project';
    this.iconPath = new vscode.ThemeIcon('repo');
    const running = environments.filter((e) => e.status === 'running').length;
    this.description = `${running}/${environments.length} running`;
  }
}

export class EnvironmentNode extends vscode.TreeItem {
  readonly kind = 'environment' as const;

  constructor(
    public readonly env: Environment,
    public readonly isForwarding: boolean,
    public readonly forwardedPorts: number[],
  ) {
    super(
      env.name || env.id,
      isForwarding && forwardedPorts.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    // Show branch + port count when forwarding
    const branchText = env.branch || '';
    if (isForwarding && forwardedPorts.length > 0) {
      this.description = `${branchText} (${forwardedPorts.length} ports)`;
    } else {
      this.description = branchText;
    }

    // Status-based icon
    switch (env.status) {
      case 'running':
        this.iconPath = new vscode.ThemeIcon(
          'circle-filled',
          new vscode.ThemeColor('testing.iconPassed'),
        );
        break;
      case 'starting':
      case 'creating':
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        break;
      case 'stopping':
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        break;
      case 'stopped':
        this.iconPath = new vscode.ThemeIcon('circle-outline');
        break;
      default:
        this.iconPath = new vscode.ThemeIcon('question');
    }

    // Context value drives inline menu actions from package.json
    if (this.isForwarding) {
      this.contextValue = 'environment-forwarding';
    } else if (env.status === 'running') {
      this.contextValue = 'environment-running';
    } else if (env.status === 'stopped') {
      this.contextValue = 'environment-stopped';
    } else {
      this.contextValue = `environment-${env.status}`;
    }

    // No TreeItem.command — single-click just selects.
    // Actions via inline icons (hover) and right-click context menu.

    this.tooltip = new vscode.MarkdownString(
      `**${env.name}**\n\n` +
        `Status: ${env.status}\n\n` +
        `Branch: ${env.branch}\n\n` +
        `Provider: ${env.provider}\n\n` +
        (this.isForwarding
          ? `**Port forwarding active** (${forwardedPorts.length} ports)\n\n`
          : '') +
        `Repository: ${env.repositoryUrl}`,
    );
  }
}

export class PortNode extends vscode.TreeItem {
  readonly kind = 'port' as const;

  constructor(
    public readonly port: number,
    public readonly label_text: string,
  ) {
    super(`localhost:${port}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'port';
    this.iconPath = new vscode.ThemeIcon('globe');
    this.description = label_text || '';
    this.tooltip = label_text
      ? `${label_text} — http://localhost:${port}`
      : `http://localhost:${port}`;

    // No click action — use inline icon or right-click to open in browser.
    // Consistent with env nodes (click just selects).
  }
}

// ---------------------------------------------------------------------------
// TreeDataProvider
// ---------------------------------------------------------------------------

export class SidebarProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: StateStore) {
    store.on('changed', () => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      // Root level: projects
      const byProject = this.store.getEnvironmentsByProject();
      const nodes: ProjectNode[] = [];
      for (const [projectName, envs] of byProject) {
        nodes.push(new ProjectNode(projectName, envs));
      }
      nodes.sort((a, b) => a.projectName.localeCompare(b.projectName));
      return nodes;
    }

    if (element instanceof ProjectNode) {
      const pf = this.store.getPortForwarding();
      return element.environments
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (env) =>
            new EnvironmentNode(
              env,
              pf.activeEnvId === env.id,
              pf.activeEnvId === env.id ? pf.ports : [],
            ),
        );
    }

    if (element instanceof EnvironmentNode && element.isForwarding) {
      const pf = this.store.getPortForwarding();
      return element.forwardedPorts.map(
        (port) => new PortNode(port, pf.portLabels[port] ?? ''),
      );
    }

    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
