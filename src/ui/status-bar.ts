import * as vscode from 'vscode';
import { DaemonClient } from '../client/daemon-client';
import { StateStore } from '../client/state';

export type DaemonHealthStatus = 'connected' | 'disconnected' | 'connecting';

export class StatusBarManager implements vscode.Disposable {
  private portItem: vscode.StatusBarItem;
  private envCountItem: vscode.StatusBarItem;
  private daemonItem: vscode.StatusBarItem;
  private changeListener: () => void;
  private _daemonHealth: DaemonHealthStatus = 'disconnected';

  constructor(
    private readonly store: StateStore,
    private readonly client: DaemonClient,
  ) {
    // Daemon health item: left side, highest priority (always visible)
    this.daemonItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      101,
    );
    this.daemonItem.command = 'cloudev.startDaemon';

    // Port forwarding item: left side, high priority
    this.portItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.portItem.command = 'cloudev.switchPortForwarding';

    // Environment count: right side, lower priority
    this.envCountItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50,
    );
    this.envCountItem.command = 'cloudev.refreshEnvironments';

    this.changeListener = () => this.update();
    store.on('changed', this.changeListener);

    this.update();
    this.daemonItem.show();
    this.portItem.show();
    this.envCountItem.show();
  }

  setDaemonHealth(status: DaemonHealthStatus): void {
    this._daemonHealth = status;
    this.updateDaemonItem();
  }

  private update(): void {
    const pf = this.store.getPortForwarding();
    const runningCount = this.store.getRunningCount();

    // Port forwarding item
    if (pf.status === 'active' && pf.activeEnvName) {
      const countStr =
        pf.ports.length > 0 ? `${pf.ports.length} ports` : 'discovering...';
      this.portItem.text = `$(plug) ${pf.activeEnvName} (${countStr})`;
      this.portItem.backgroundColor = undefined;
      this.portItem.color = new vscode.ThemeColor(
        'statusBarItem.prominentForeground',
      );
      this.portItem.tooltip = `Forwarding ${pf.ports.length} ports for ${pf.activeEnvName}. Click to switch.`;
    } else if (pf.status === 'connecting') {
      this.portItem.text = '$(loading~spin) Ports: connecting...';
      this.portItem.backgroundColor = undefined;
      this.portItem.color = undefined;
      this.portItem.tooltip = 'Establishing port forwarding...';
    } else if (pf.status === 'error') {
      this.portItem.text = '$(error) Ports: error';
      this.portItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground',
      );
      this.portItem.color = undefined;
      this.portItem.tooltip = `Error: ${pf.error ?? 'Unknown error'}. Click to retry.`;
    } else {
      this.portItem.text = '$(debug-disconnect) Ports: none';
      this.portItem.backgroundColor = undefined;
      this.portItem.color = undefined;
      this.portItem.tooltip = 'No port forwarding active. Click to start.';
    }

    // Environment count item
    this.envCountItem.text = `$(cloud) Ona: ${runningCount} running`;
    this.envCountItem.tooltip = `${runningCount} environment(s) running. Click to refresh.`;
  }

  private updateDaemonItem(): void {
    switch (this._daemonHealth) {
      case 'connected':
        this.daemonItem.text = '$(vm-active) Cloudev';
        this.daemonItem.backgroundColor = undefined;
        this.daemonItem.color = new vscode.ThemeColor(
          'testing.iconPassed',
        );
        this.daemonItem.tooltip = 'Daemon is running. Click to reconnect.';
        break;
      case 'connecting':
        this.daemonItem.text = '$(loading~spin) Cloudev';
        this.daemonItem.backgroundColor = undefined;
        this.daemonItem.color = undefined;
        this.daemonItem.tooltip = 'Connecting to daemon...';
        break;
      case 'disconnected':
        this.daemonItem.text = '$(vm-outline) Cloudev';
        this.daemonItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground',
        );
        this.daemonItem.color = undefined;
        this.daemonItem.tooltip =
          'Daemon is not running. Click to start.';
        break;
    }
  }

  dispose(): void {
    this.store.removeListener('changed', this.changeListener);
    this.daemonItem.dispose();
    this.portItem.dispose();
    this.envCountItem.dispose();
  }
}
