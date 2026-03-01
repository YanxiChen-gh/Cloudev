import { ChildProcess } from 'child_process';
import { ClientMessage, DaemonState, PortForwardingState } from '../../types';
import { DaemonService, ServiceContext } from '../service';
import { readPersistedState, writePersistedState } from '../state-file';
import { classifyPortOwner } from '../port-owner';

const DISCOVERY_INTERVAL_MS = 5_000;
const SIGKILL_DELAY_MS = 2_000;
const OWNERSHIP_CHECK_DELAY_MS = 3_000;

export class PortForwardingService implements DaemonService {
  readonly id = 'port-forwarding';

  private activeEnvId: string | null = null;
  private tunnelProcess: ChildProcess | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private currentPorts: number[] = [];
  private currentLabels: Record<number, string> = {};
  private currentUrls: Record<number, string> = {};
  private portConflicts: Record<number, string> = {};
  private status: PortForwardingState['status'] = 'idle';
  private error: string | undefined;
  private isDiscovering = false;
  private ownershipCheckScheduled = false;

  constructor(private readonly ctx: ServiceContext) {}

  handles(msgType: string): boolean {
    return msgType.startsWith('port-forwarding.');
  }

  async handleMessage(msg: ClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'port-forwarding.start': {
        const m = msg as Extract<ClientMessage, { type: 'port-forwarding.start' }>;
        await this.startForwarding(m.envId);
        return;
      }
      case 'port-forwarding.stop':
        await this.stopForwarding();
        return;
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  getState(): Partial<DaemonState> {
    return {
      portForwarding: this.getPortForwardingState(),
    };
  }

  onStateChanged(fullState: DaemonState): void {
    if (!this.activeEnvId) return;
    const env = fullState.environments.find((e) => e.id === this.activeEnvId);
    if (!env || (env.status !== 'running' && env.status !== 'starting')) {
      this.stopForwarding();
    }
  }

  async start(): Promise<void> {
    const persisted = readPersistedState();
    if (persisted.activeForwardingEnvId) {
      setTimeout(() => {
        const envs = this.ctx.getEnvironments();
        const env = envs.find((e) => e.id === persisted.activeForwardingEnvId);
        if (env && env.status === 'running') {
          console.log(`[port-forwarding] Auto-resuming forwarding for ${env.name}`);
          this.startForwarding(env.id);
        } else {
          writePersistedState({});
        }
      }, 5_000);
    }
  }

  async stop(): Promise<void> {
    await this.stopForwarding();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getPortForwardingState(): PortForwardingState {
    const envName = this.activeEnvId
      ? this.ctx.getEnvironments().find((e) => e.id === this.activeEnvId)?.name ?? null
      : null;

    return {
      activeEnvId: this.activeEnvId,
      activeEnvName: envName,
      ports: this.currentPorts,
      portLabels: this.currentLabels,
      portUrls: this.currentUrls,
      portConflicts: this.portConflicts,
      status: this.status,
      error: this.error,
    };
  }

  private async startForwarding(envId: string): Promise<void> {
    if (this.activeEnvId && this.activeEnvId !== envId) {
      await this.stopForwarding();
    }
    if (this.activeEnvId === envId) return;

    const provider = this.ctx.getProvider(envId);
    if (!provider) throw new Error(`No provider found for environment ${envId}`);

    this.activeEnvId = envId;
    this.setStatus('connecting');
    writePersistedState({ activeForwardingEnvId: envId });

    await this.discoverAndTunnel();
    this.discoveryTimer = setInterval(() => this.discoverAndTunnel(), DISCOVERY_INTERVAL_MS);
  }

  private async stopForwarding(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    await this.killTunnel();
    this.activeEnvId = null;
    this.currentPorts = [];
    this.currentLabels = {};
    this.currentUrls = {};
    this.portConflicts = {};
    this.ownershipCheckScheduled = false;
    this.isDiscovering = false;
    this.setStatus('idle');
    writePersistedState({});
  }

  private async discoverAndTunnel(): Promise<void> {
    if (!this.activeEnvId) return;
    if (this.isDiscovering) return;

    this.isDiscovering = true;

    try {
      const provider = this.ctx.getProvider(this.activeEnvId);
      if (!provider) {
        this.setStatus('error', 'Provider not found');
        return;
      }

      const result = await provider.discoverPorts(this.activeEnvId);
      const newPorts = result.ports;
      newPorts.sort((a, b) => a - b);

      this.currentLabels = result.labels;
      this.currentUrls = result.urls ?? {};

      if (!this.portsEqual(newPorts, this.currentPorts)) {
        await this.killTunnel();
        this.currentPorts = newPorts;
        this.portConflicts = {};
        this.ownershipCheckScheduled = false;

        if (newPorts.length > 0) {
          this.tunnelProcess = provider.spawnTunnel(this.activeEnvId, newPorts);
          this.setupTunnelMonitoring();

          // Schedule ownership check after tunnel has time to bind
          setTimeout(() => this.checkPortOwnership(), OWNERSHIP_CHECK_DELAY_MS);
          this.ownershipCheckScheduled = true;
        }

        this.setStatus('active');
      } else if (this.tunnelProcess && this.ownershipCheckScheduled) {
        // Periodic ownership check — who actually holds each port?
        await this.checkPortOwnership();
      } else if (this.status === 'connecting') {
        this.setStatus('active');
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[port-forwarding] Error for ${this.activeEnvId}: ${msg}`);
      this.setStatus('error', msg);
    } finally {
      this.isDiscovering = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Port ownership check — single source of truth
  // ---------------------------------------------------------------------------

  /**
   * For each forwarded port, check who actually holds the local binding.
   * Classifies as: ours (our tunnel PID), stale (another SSH tunnel),
   * other (unrelated process), or none (not bound).
   */
  private async checkPortOwnership(): Promise<void> {
    if (!this.activeEnvId || this.currentPorts.length === 0) return;

    const ourPid = this.tunnelProcess?.pid;
    const updated: Record<number, string> = {};
    let changed = false;

    await Promise.all(
      this.currentPorts.map(async (port) => {
        const result = await classifyPortOwner(port, ourPid);

        switch (result.status) {
          case 'ours':
            // Our tunnel has it — no conflict
            break;
          case 'stale':
            // Another SSH process (old tunnel or VS Code forwarder)
            updated[port] = result.description;
            break;
          case 'other':
            // Non-SSH process holds the port
            updated[port] = result.description;
            break;
          case 'none':
            // Nothing bound — port couldn't be forwarded (privileged, etc.)
            // Don't warn — SSH stderr already handles bind failures
            break;
        }
      }),
    );

    if (JSON.stringify(updated) !== JSON.stringify(this.portConflicts)) {
      this.portConflicts = updated;
      changed = true;
    }

    if (changed) {
      this.ctx.broadcast();
    }
  }

  // ---------------------------------------------------------------------------
  // Tunnel lifecycle
  // ---------------------------------------------------------------------------

  private setupTunnelMonitoring(): void {
    if (!this.tunnelProcess) return;

    this.tunnelProcess.on('exit', (code, signal) => {
      if (this.activeEnvId && this.tunnelProcess) {
        this.tunnelProcess = null;
        console.error(`[port-forwarding] Tunnel for ${this.activeEnvId} exited (code=${code}, signal=${signal})`);
        this.setStatus('error', `Tunnel exited (code=${code}, signal=${signal})`);
      }
    });

    this.tunnelProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && this.activeEnvId) {
        console.error(`[port-forwarding] SSH stderr: ${msg}`);
        this.error = msg;
      }
    });
  }

  private killTunnel(): Promise<void> {
    if (!this.tunnelProcess) return Promise.resolve();

    const proc = this.tunnelProcess;
    this.tunnelProcess = null;

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      proc.on('exit', done);

      try {
        proc.kill('SIGTERM');
      } catch {
        done();
        return;
      }

      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, SIGKILL_DELAY_MS);

      setTimeout(done, SIGKILL_DELAY_MS + 1_000);
    });
  }

  private portsEqual(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((p, i) => p === b[i]);
  }

  private setStatus(status: PortForwardingState['status'], error?: string): void {
    this.status = status;
    this.error = error;
    this.ctx.broadcast();
  }
}
