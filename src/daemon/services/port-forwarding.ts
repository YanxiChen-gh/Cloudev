import { ChildProcess } from 'child_process';
import { ClientMessage, DaemonState, PortForwardingState } from '../../types';
import { DaemonService, ServiceContext } from '../service';

const DISCOVERY_INTERVAL_MS = 5_000;
const TUNNEL_KILL_DELAY_MS = 500;
const SIGKILL_DELAY_MS = 2_000;

export class PortForwardingService implements DaemonService {
  readonly id = 'port-forwarding';

  private activeEnvId: string | null = null;
  private tunnelProcess: ChildProcess | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private currentPorts: number[] = [];
  private status: PortForwardingState['status'] = 'idle';
  private error: string | undefined;
  private isDiscovering = false;

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
    // If the actively-forwarded env no longer exists or is not running, stop forwarding
    if (!this.activeEnvId) return;

    const env = fullState.environments.find((e) => e.id === this.activeEnvId);
    if (!env || (env.status !== 'running' && env.status !== 'starting')) {
      this.stopForwarding();
    }
  }

  async start(): Promise<void> {
    // No-op — forwarding starts on demand
  }

  async stop(): Promise<void> {
    await this.stopForwarding();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getPortForwardingState(): PortForwardingState {
    // Resolve env name from context
    const envName = this.activeEnvId
      ? this.ctx.getEnvironments().find((e) => e.id === this.activeEnvId)?.name ?? null
      : null;

    return {
      activeEnvId: this.activeEnvId,
      activeEnvName: envName,
      ports: this.currentPorts,
      status: this.status,
      error: this.error,
    };
  }

  private async startForwarding(envId: string): Promise<void> {
    // If already forwarding a different env, stop first
    if (this.activeEnvId && this.activeEnvId !== envId) {
      await this.stopForwarding();
      // Brief delay to let ports release (TIME_WAIT)
      await this.delay(TUNNEL_KILL_DELAY_MS);
    }
    if (this.activeEnvId === envId) return;

    const provider = this.ctx.getProvider(envId);
    if (!provider) throw new Error(`No provider found for environment ${envId}`);

    this.activeEnvId = envId;
    this.setStatus('connecting');

    // Initial port discovery
    await this.discoverAndTunnel();

    // Start periodic discovery
    this.discoveryTimer = setInterval(() => this.discoverAndTunnel(), DISCOVERY_INTERVAL_MS);
  }

  private async stopForwarding(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    this.killTunnel();
    this.activeEnvId = null;
    this.currentPorts = [];
    this.isDiscovering = false;
    this.setStatus('idle');
  }

  private async discoverAndTunnel(): Promise<void> {
    if (!this.activeEnvId) return;
    if (this.isDiscovering) return; // Prevent overlapping calls

    this.isDiscovering = true;

    try {
      const provider = this.ctx.getProvider(this.activeEnvId);
      if (!provider) {
        this.setStatus('error', 'Provider not found');
        return;
      }

      const newPorts = await provider.discoverPorts(this.activeEnvId);
      newPorts.sort((a, b) => a - b);

      // Only respawn tunnel if ports changed
      if (!this.portsEqual(newPorts, this.currentPorts)) {
        this.killTunnel();
        this.currentPorts = newPorts;

        if (newPorts.length > 0) {
          this.tunnelProcess = provider.spawnTunnel(this.activeEnvId, newPorts);
          this.setupTunnelMonitoring();
        }

        this.setStatus('active');
      } else if (this.status === 'connecting') {
        // First successful discovery — mark as active
        this.setStatus('active');
      }
    } catch (err) {
      this.setStatus('error', (err as Error).message);
    } finally {
      this.isDiscovering = false;
    }
  }

  private setupTunnelMonitoring(): void {
    if (!this.tunnelProcess) return;

    this.tunnelProcess.on('exit', (code, signal) => {
      // If we're still meant to be forwarding, the tunnel died unexpectedly.
      // The next discovery cycle will respawn it.
      if (this.activeEnvId && this.tunnelProcess) {
        this.tunnelProcess = null;
        this.setStatus('error', `Tunnel exited (code=${code}, signal=${signal})`);
      }
    });

    this.tunnelProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg && this.activeEnvId) {
        // Log SSH errors (e.g., "Address already in use") — set as error state
        this.error = msg;
      }
    });
  }

  private killTunnel(): void {
    if (!this.tunnelProcess) return;

    const proc = this.tunnelProcess;
    this.tunnelProcess = null;

    try {
      proc.kill('SIGTERM');
    } catch {
      // Already dead
    }

    // Escalate to SIGKILL after delay
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }, SIGKILL_DELAY_MS);
  }

  private portsEqual(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((p, i) => p === b[i]);
  }

  private setStatus(status: PortForwardingState['status'], error?: string): void {
    this.status = status;
    this.error = error;
    this.ctx.broadcast();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
