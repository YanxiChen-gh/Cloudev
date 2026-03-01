import * as vscode from 'vscode';
import { StateStore } from '../client/state';
import { Environment } from '../types';

const FAVORITES_KEY = 'cloudev.favorites'; // stores "env:{id}" and "port:{envId}:{port}" keys

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

    // Provider-aware icon and description
    const provider = environments[0]?.provider;
    this.iconPath = new vscode.ThemeIcon(provider === 'codespaces' ? 'github' : 'repo');
    const running = environments.filter((e) => e.status === 'running').length;
    const providerLabel = provider === 'codespaces' ? 'Codespaces' : 'Ona';
    this.description = `${providerLabel} · ${running}/${environments.length} running`;
  }
}

export class EnvironmentNode extends vscode.TreeItem {
  readonly kind = 'environment' as const;

  constructor(
    public readonly env: Environment,
    public readonly isForwarding: boolean,
    public readonly forwardedPorts: number[],
    isFavorite?: boolean,
  ) {
    super(
      env.name || env.id,
      isForwarding && forwardedPorts.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    // Show branch + port count when forwarding, with star prefix for favorites
    const star = isFavorite ? '★ ' : '';
    const branchText = env.branch || '';
    if (isForwarding && forwardedPorts.length > 0) {
      this.description = `${star}${branchText} (${forwardedPorts.length} ports)`;
    } else {
      this.description = `${star}${branchText}`;
    }

    // Status-based icon — forwarding env gets radio-tower, running gets green circle
    switch (env.status) {
      case 'running':
        this.iconPath = this.isForwarding
          ? new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
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

    // Context value drives menu actions. Append .fav for favorites so
    // package.json can show "Add to Favorites" vs "Remove from Favorites".
    let cv: string;
    if (this.isForwarding) {
      cv = 'environment-forwarding';
    } else if (env.status === 'running') {
      cv = 'environment-running';
    } else if (env.status === 'stopped') {
      cv = 'environment-stopped';
    } else {
      cv = `environment-${env.status}`;
    }
    this.contextValue = isFavorite ? `${cv}.fav` : cv;

    const tooltipLines = [
      `**${env.name}**`,
      '',
      `Status: ${env.status}`,
      '',
      `Branch: ${env.branch}`,
      '',
      `Provider: ${env.provider}`,
      '',
    ];
    if (this.isForwarding) {
      tooltipLines.push(`**Port forwarding active** (${forwardedPorts.length} ports)`, '');
    }
    tooltipLines.push(`Repository: ${env.repositoryUrl}`);
    if (env.webUrl) {
      tooltipLines.push('', `Dashboard: ${env.webUrl}`);
    }

    this.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
  }
}

export class PortNode extends vscode.TreeItem {
  readonly kind = 'port' as const;
  public readonly envId: string;

  constructor(
    envId: string,
    public readonly port: number,
    public readonly label_text: string,
    public readonly publicUrl?: string,
    isFavorite?: boolean,
    conflictReason?: string,
  ) {
    super(`localhost:${port}`, vscode.TreeItemCollapsibleState.None);
    this.envId = envId;

    // Context value encodes both URL availability and favorite state
    const base = publicUrl ? 'port-with-url' : 'port';
    this.contextValue = isFavorite ? `${base}.fav` : base;

    // Icon priority: conflict > favorite > default
    if (conflictReason) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else if (isFavorite) {
      this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('terminal.ansiYellow'));
    } else {
      this.iconPath = new vscode.ThemeIcon('globe');
    }

    this.description = conflictReason
      ? `⚠ ${conflictReason}`
      : label_text || '';

    const lines = [
      label_text ? `${label_text} — http://localhost:${port}` : `http://localhost:${port}`,
    ];
    if (publicUrl) {
      lines.push(`Public: ${publicUrl}`);
    }
    if (conflictReason) {
      lines.push(`⚠ ${conflictReason}`);
      if (conflictReason.includes('VS Code Remote')) {
        lines.push('This port may be forwarded to a different env.');
        lines.push('Set remote.autoForwardPorts: false to disable.');
      }
    }
    this.tooltip = lines.join('\n');
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

  constructor(
    private readonly store: StateStore,
    private readonly extensionContext: vscode.ExtensionContext,
  ) {
    store.on('changed', () => this._onDidChangeTreeData.fire());
  }

  // --- Favorite management (shared for envs and ports) ---

  private getFavorites(): Set<string> {
    return new Set(this.extensionContext.globalState.get<string[]>(FAVORITES_KEY, []));
  }

  private saveFavorites(favorites: Set<string>): void {
    this.extensionContext.globalState.update(FAVORITES_KEY, [...favorites]);
    this._onDidChangeTreeData.fire();
  }

  isEnvFavorite(envId: string): boolean {
    return this.getFavorites().has(`env:${envId}`);
  }

  isPortFavorite(envId: string, port: number): boolean {
    return this.getFavorites().has(`port:${envId}:${port}`);
  }

  addFavorite(key: string): void {
    const favorites = this.getFavorites();
    favorites.add(key);
    this.saveFavorites(favorites);
  }

  removeFavorite(key: string): void {
    const favorites = this.getFavorites();
    favorites.delete(key);
    this.saveFavorites(favorites);
  }

  // --- TreeDataProvider ---

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
      const nodes = element.environments.map(
        (env) =>
          new EnvironmentNode(
            env,
            pf.activeEnvId === env.id,
            pf.activeEnvId === env.id ? pf.ports : [],
            this.isEnvFavorite(env.id),
          ),
      );
      // Sort: favorites first, then alphabetical
      nodes.sort((a, b) => {
        const aFav = this.isEnvFavorite(a.env.id) ? 0 : 1;
        const bFav = this.isEnvFavorite(b.env.id) ? 0 : 1;
        if (aFav !== bFav) return aFav - bFav;
        return a.env.name.localeCompare(b.env.name);
      });
      return nodes;
    }

    if (element instanceof EnvironmentNode && element.isForwarding) {
      const pf = this.store.getPortForwarding();
      const envId = element.env.id;
      const portNodes = element.forwardedPorts.map(
        (port) => new PortNode(
          envId,
          port,
          pf.portLabels[port] ?? '',
          pf.portUrls[port],
          this.isPortFavorite(envId, port),
          pf.portConflicts[port],
        ),
      );
      // Sort favorites first, then by port number
      portNodes.sort((a, b) => {
        const aFav = this.isPortFavorite(envId, a.port) ? 0 : 1;
        const bFav = this.isPortFavorite(envId, b.port) ? 0 : 1;
        if (aFav !== bFav) return aFav - bFav;
        return a.port - b.port;
      });
      return portNodes;
    }

    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
