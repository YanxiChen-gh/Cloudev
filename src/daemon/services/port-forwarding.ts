import { ChildProcess } from 'child_process';
import { ClientMessage, DaemonState, PortForwardingState, SideBySideEnv } from '../../types';
import { PortMapping } from '../providers/types';
import { DaemonService, ServiceContext } from '../service';
import { readPersistedState, writePersistedState } from '../state-file';
import { classifyPortOwner } from '../port-owner';
import { LocalProxyManager } from '../local-proxy';

const DISCOVERY_INTERVAL_MS = 5_000;
const SIGKILL_DELAY_MS = 2_000;
const OWNERSHIP_CHECK_DELAY_MS = 3_000;

import * as net from 'net';

/** Get an OS-assigned ephemeral port by briefly binding to port 0. */
async function allocateHiddenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

interface CachedDiscovery {
  ports: number[];
  labels: Record<number, string>;
  urls: Record<number, string>;
}

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

  // Proxy: owns user-facing ports, routes to hidden tunnel ports
  private proxyManager = new LocalProxyManager();
  // Maps user-facing port → hidden tunnel port for the active env
  private portMappings = new Map<number, number>();
  // Port cache: remember last-known ports per env for instant switch
  private portCache = new Map<string, CachedDiscovery>();
  // Side-by-side state
  private sideBySideEnvs: SideBySideEnv[] = [];
  // Per-env tunnels for side-by-side mode (envId → process)
  private sideBySideTunnels = new Map<string, ChildProcess>();
  // Per-env port mappings for compare mode (envId → (remotePort → hiddenPort))
  private compareMappings = new Map<string, Map<number, number>>();

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
      case 'port-forwarding.side-by-side': {
        const m = msg as Extract<ClientMessage, { type: 'port-forwarding.side-by-side' }>;
        await this.startSideBySide(m.envIds);
        return;
      }
      case 'port-forwarding.stop-side-by-side':
        await this.stopSideBySide();
        return;
      case 'port-forwarding.add-compare': {
        const m = msg as Extract<ClientMessage, { type: 'port-forwarding.add-compare' }>;
        await this.addCompare(m.envId);
        return;
      }
      case 'port-forwarding.remove-compare': {
        const m = msg as Extract<ClientMessage, { type: 'port-forwarding.remove-compare' }>;
        await this.removeCompare(m.envId);
        return;
      }
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
      sideBySide: this.sideBySideEnvs,
    };
  }

  private async startForwarding(envId: string): Promise<void> {
    if (this.activeEnvId === envId) return;

    const provider = this.ctx.getProvider(envId);
    if (!provider) throw new Error(`No provider found for environment ${envId}`);

    // If switching from another env, do instant switch via proxy
    if (this.activeEnvId) {
      await this.switchTo(envId);
      return;
    }

    // First-time forwarding (no active env)
    this.activeEnvId = envId;
    this.setStatus('connecting');
    writePersistedState({ activeForwardingEnvId: envId });

    // Use cache for instant start if available
    const cached = this.portCache.get(envId);
    if (cached && cached.ports.length > 0) {
      await this.applyPorts(envId, cached.ports, cached.labels, cached.urls);
    }

    // Always do a fresh discovery (updates cache + corrects if stale)
    await this.discoverAndTunnel();
    this.discoveryTimer = setInterval(() => this.discoverAndTunnel(), DISCOVERY_INTERVAL_MS);
  }

  /**
   * Instant switch: spawn new tunnel → switch proxies → kill old tunnel in background.
   * The proxy never releases the user-facing port — just changes upstream.
   */
  private async switchTo(newEnvId: string): Promise<void> {
    const provider = this.ctx.getProvider(newEnvId);
    if (!provider) throw new Error(`No provider found for environment ${newEnvId}`);

    // Stop discovery timer for old env
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    const oldTunnel = this.tunnelProcess;
    this.tunnelProcess = null;

    // Update active env immediately
    this.activeEnvId = newEnvId;
    this.setStatus('connecting');
    writePersistedState({ activeForwardingEnvId: newEnvId });

    // Use cached ports for new env if available — instant UI update
    const cached = this.portCache.get(newEnvId);
    if (cached && cached.ports.length > 0) {
      await this.applyPorts(newEnvId, cached.ports, cached.labels, cached.urls);
      this.setStatus('active');
    }

    // Start fresh discovery + tunnel for new env (verifies cache, finds new ports)
    await this.discoverAndTunnel();
    this.discoveryTimer = setInterval(() => this.discoverAndTunnel(), DISCOVERY_INTERVAL_MS);

    // Kill old tunnel in background (fire-and-forget, doesn't block switch)
    if (oldTunnel) {
      this.killProcess(oldTunnel);
    }
  }

  private async stopForwarding(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    // Clean up any active compare session
    if (this.sideBySideEnvs.length > 0) {
      for (const [, tunnel] of this.sideBySideTunnels) {
        this.killProcess(tunnel);
      }
      this.sideBySideTunnels.clear();
      this.compareMappings.clear();
      this.sideBySideEnvs = [];
    }
    await this.killTunnel();
    await this.proxyManager.removeAll();
    this.portMappings.clear();
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

  /**
   * Apply a port list: allocate hidden ports, spawn tunnel, create/update proxies.
   * Used both for cached ports (instant) and fresh discovery.
   */
  private async applyPorts(
    envId: string,
    ports: number[],
    labels: Record<number, string>,
    urls: Record<number, string>,
  ): Promise<void> {
    const provider = this.ctx.getProvider(envId);
    if (!provider) return;

    // Kill existing tunnel if any (for this env)
    await this.killTunnel();

    this.currentPorts = ports;
    this.currentLabels = labels;
    this.currentUrls = urls;
    this.portConflicts = {};
    this.ownershipCheckScheduled = false;

    if (ports.length === 0) {
      await this.proxyManager.removeAll();
      this.portMappings.clear();
      return;
    }

    // Allocate hidden ports (OS-assigned to avoid collisions)
    const mappings: PortMapping[] = [];
    for (const remotePort of ports) {
      mappings.push({ remote: remotePort, local: await allocateHiddenPort() });
    }

    this.portMappings.clear();
    for (const m of mappings) {
      this.portMappings.set(m.remote, m.local);
    }

    // Spawn tunnel to hidden ports
    this.tunnelProcess = provider.spawnTunnel(envId, mappings);
    this.setupTunnelMonitoring();

    // Create/update proxies
    for (const m of mappings) {
      try {
        await this.proxyManager.ensureProxy(m.remote, m.local);
      } catch (err) {
        console.error(`[port-forwarding] Failed to create proxy for port ${m.remote}: ${(err as Error).message}`);
        this.portConflicts[m.remote] = `Failed to bind: ${(err as Error).message}`;
      }
    }

    // Remove proxies for ports no longer forwarded
    for (const proxiedPort of this.proxyManager.getProxiedPorts()) {
      if (!ports.includes(proxiedPort)) {
        await this.proxyManager.removeProxy(proxiedPort);
      }
    }

    // Schedule ownership check
    setTimeout(() => this.checkPortOwnership(), OWNERSHIP_CHECK_DELAY_MS);
    this.ownershipCheckScheduled = true;
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
      const newPorts = result.ports.filter((p) => p >= 1024);
      newPorts.sort((a, b) => a - b);

      const newLabels = result.labels;
      const newUrls = result.urls ?? {};

      // Update cache
      this.portCache.set(this.activeEnvId, {
        ports: newPorts,
        labels: newLabels,
        urls: newUrls,
      });

      if (!this.portsEqual(newPorts, this.currentPorts)) {
        await this.applyPorts(this.activeEnvId, newPorts, newLabels, newUrls);
        this.setStatus('active');
      } else {
        // Ports unchanged — just update labels/urls and check ownership
        this.currentLabels = newLabels;
        this.currentUrls = newUrls;
        if (this.tunnelProcess && this.ownershipCheckScheduled) {
          await this.checkPortOwnership();
        } else if (this.status === 'connecting') {
          this.setStatus('active');
        }
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
  // Port ownership check
  // ---------------------------------------------------------------------------

  private async checkPortOwnership(): Promise<void> {
    if (!this.activeEnvId || this.currentPorts.length === 0) return;

    const ourPid = process.pid;
    const updated: Record<number, string> = {};

    await Promise.all(
      this.currentPorts.map(async (port) => {
        const result = await classifyPortOwner(port, ourPid);

        switch (result.status) {
          case 'ours':
            break;
          case 'stale':
            updated[port] = result.description;
            break;
          case 'other':
            updated[port] = result.description;
            break;
          case 'none':
            break;
        }
      }),
    );

    if (JSON.stringify(updated) !== JSON.stringify(this.portConflicts)) {
      this.portConflicts = updated;
      this.ctx.broadcast();
    }
  }

  // ---------------------------------------------------------------------------
  // Tunnel lifecycle
  // ---------------------------------------------------------------------------

  private setupTunnelMonitoring(): void {
    if (!this.tunnelProcess) return;

    // Capture reference — only react if this is still the active tunnel
    const proc = this.tunnelProcess;

    proc.on('exit', (code, signal) => {
      if (this.tunnelProcess === proc) {
        this.tunnelProcess = null;
        console.error(`[port-forwarding] Tunnel for ${this.activeEnvId} exited (code=${code}, signal=${signal})`);
        this.setStatus('error', `Tunnel exited (code=${code}, signal=${signal})`);
      }
      // else: old tunnel from before a switch — ignore
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (this.tunnelProcess !== proc) return; // stale tunnel
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
    return this.killProcess(proc);
  }

  /** Kill a process with SIGTERM → SIGKILL fallback. Fire-and-forget safe. */
  private killProcess(proc: ChildProcess): Promise<void> {
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

  // ---------------------------------------------------------------------------
  // Side-by-side mode
  // ---------------------------------------------------------------------------

  /**
   * Start side-by-side mode: forward ports from multiple envs simultaneously.
   * HTTP proxy routes by hostname: env-name.localhost:port → correct tunnel.
   * Requires all envs to be running.
   */
  private async startSideBySide(envIds: string[]): Promise<void> {
    // Stop any existing forwarding first
    if (this.activeEnvId) await this.stopForwarding();
    if (this.sideBySideEnvs.length > 0) await this.stopSideBySide();

    this.setStatus('connecting');

    const envs = this.ctx.getEnvironments();
    const sbsEnvs: SideBySideEnv[] = [];

    // Build hostname mapping: use env name sanitized as hostname prefix
    const usedHostnames = new Set<string>();
    for (const envId of envIds) {
      const env = envs.find((e) => e.id === envId);
      if (!env || env.status !== 'running') continue;
      let hostname = env.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      // Ensure uniqueness — append branch or index if collision
      if (usedHostnames.has(hostname)) {
        const branch = env.branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        hostname = `${hostname}-${branch}`;
      }
      let suffix = 2;
      while (usedHostnames.has(hostname)) {
        hostname = `${env.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${suffix++}`;
      }
      usedHostnames.add(hostname);
      sbsEnvs.push({ envId, envName: env.name, hostname });
    }

    if (sbsEnvs.length < 2) {
      this.setStatus('error', 'Side-by-side requires at least 2 running environments');
      return;
    }

    // Discover ports for all envs
    const envPorts = new Map<string, number[]>();
    const envMappings = new Map<string, Map<number, number>>(); // envId → (remotePort → hiddenPort)

    await Promise.allSettled(
      sbsEnvs.map(async (sbs) => {
        const provider = this.ctx.getProvider(sbs.envId);
        if (!provider) return;

        const result = await provider.discoverPorts(sbs.envId);
        const ports = result.ports.filter((p) => p >= 1024);
        envPorts.set(sbs.envId, ports);

        // Allocate hidden ports
        const mappings = new Map<number, number>();
        const portMappingList: PortMapping[] = [];
        for (const port of ports) {
          const hidden = await allocateHiddenPort();
          mappings.set(port, hidden);
          portMappingList.push({ remote: port, local: hidden });
        }
        envMappings.set(sbs.envId, mappings);

        // Spawn tunnel
        const tunnel = provider.spawnTunnel(sbs.envId, portMappingList);
        this.sideBySideTunnels.set(sbs.envId, tunnel);
      }),
    );

    // Find all unique ports across all envs
    const allPorts = new Set<number>();
    for (const ports of envPorts.values()) {
      for (const p of ports) allPorts.add(p);
    }

    // For each port, create an HTTP proxy with hostname routes
    for (const port of allPorts) {
      const routes = new Map<string, number>();
      let defaultUpstream: number | undefined;

      for (const sbs of sbsEnvs) {
        const hidden = envMappings.get(sbs.envId)?.get(port);
        if (hidden !== undefined) {
          routes.set(sbs.hostname, hidden);
          if (!defaultUpstream) defaultUpstream = hidden; // first env is default
        }
      }

      if (defaultUpstream !== undefined) {
        try {
          await this.proxyManager.ensureHttpProxy(port, routes, defaultUpstream);
        } catch (err) {
          console.error(`[port-forwarding] Failed to create HTTP proxy for port ${port}: ${(err as Error).message}`);
        }
      }
    }

    this.sideBySideEnvs = sbsEnvs;
    this.currentPorts = [...allPorts].sort((a, b) => a - b);
    this.activeEnvId = sbsEnvs[0].envId; // first env is "active" for state display
    this.setStatus('active');

    console.log(`[port-forwarding] Side-by-side active: ${sbsEnvs.map((s) => `${s.envName} → ${s.hostname}.localhost`).join(', ')}`);
  }

  /**
   * Additive compare: add a single env to compare alongside the currently forwarded env.
   * First call transitions from regular forwarding → compare mode (TCP proxies → HTTP proxies).
   * Subsequent calls add more envs to the existing compare session.
   */
  private async addCompare(envId: string): Promise<void> {
    if (!this.activeEnvId) throw new Error('No active forwarding — start forwarding first');
    if (envId === this.activeEnvId) throw new Error('Cannot compare the active forwarding environment with itself');
    if (this.sideBySideEnvs.some((s) => s.envId === envId)) throw new Error('Environment is already being compared');

    const envs = this.ctx.getEnvironments();
    const newEnv = envs.find((e) => e.id === envId);
    if (!newEnv || newEnv.status !== 'running') throw new Error('Environment is not running');

    const provider = this.ctx.getProvider(envId);
    if (!provider) throw new Error(`No provider found for environment ${envId}`);

    // Discover ports for new env
    const result = await provider.discoverPorts(envId);
    const newPorts = result.ports.filter((p) => p >= 1024);

    // Allocate hidden ports for new env
    const newMappings = new Map<number, number>();
    const portMappingList: PortMapping[] = [];
    for (const port of newPorts) {
      const hidden = await allocateHiddenPort();
      newMappings.set(port, hidden);
      portMappingList.push({ remote: port, local: hidden });
    }

    // Spawn tunnel for new env
    const tunnel = provider.spawnTunnel(envId, portMappingList);
    this.sideBySideTunnels.set(envId, tunnel);
    this.compareMappings.set(envId, newMappings);

    const usedHostnames = new Set(this.sideBySideEnvs.map((s) => s.hostname));

    if (this.sideBySideEnvs.length === 0) {
      // First compare — transition from regular forwarding to compare mode
      const activeEnv = envs.find((e) => e.id === this.activeEnvId);
      const activeHostname = this.generateHostname(activeEnv!, usedHostnames);
      usedHostnames.add(activeHostname);
      const newHostname = this.generateHostname(newEnv, usedHostnames);

      // Store active env's mappings for compare mode
      this.compareMappings.set(this.activeEnvId, new Map(this.portMappings));

      // All ports across both envs
      const allPorts = new Set([...this.currentPorts, ...newPorts]);

      // Transition each port from TCP → HTTP proxy with hostname routes
      for (const port of allPorts) {
        const routes = new Map<string, number>();
        let defaultUpstream: number | undefined;

        const activeHidden = this.portMappings.get(port);
        if (activeHidden !== undefined) {
          routes.set(activeHostname, activeHidden);
          defaultUpstream = activeHidden;
        }

        const newHidden = newMappings.get(port);
        if (newHidden !== undefined) {
          routes.set(newHostname, newHidden);
          if (!defaultUpstream) defaultUpstream = newHidden;
        }

        if (defaultUpstream !== undefined) {
          try {
            await this.proxyManager.ensureHttpProxy(port, routes, defaultUpstream);
          } catch (err) {
            console.error(`[port-forwarding] Failed to create HTTP proxy for port ${port}: ${(err as Error).message}`);
          }
        }
      }

      // Update current ports to union
      this.currentPorts = [...allPorts].sort((a, b) => a - b);

      this.sideBySideEnvs = [
        { envId: this.activeEnvId, envName: activeEnv!.name, hostname: activeHostname },
        { envId, envName: newEnv.name, hostname: newHostname },
      ];
    } else {
      // Already in compare mode — add routes for new env to existing HTTP proxies
      const newHostname = this.generateHostname(newEnv, usedHostnames);

      // Update existing HTTP proxies with new routes
      const allPorts = new Set([...this.currentPorts, ...newPorts]);
      for (const port of allPorts) {
        const existingRoutes = this.proxyManager.getHttpRoutes(port);
        const routes = existingRoutes ? new Map(existingRoutes) : new Map<string, number>();

        const newHidden = newMappings.get(port);
        if (newHidden !== undefined) {
          routes.set(newHostname, newHidden);
        }

        // Determine default upstream (active env's hidden port)
        const activeHidden = this.compareMappings.get(this.activeEnvId!)?.get(port) ?? this.portMappings.get(port);
        const defaultUpstream = activeHidden ?? routes.values().next().value;

        if (routes.size > 0 && defaultUpstream !== undefined) {
          try {
            await this.proxyManager.ensureHttpProxy(port, routes, defaultUpstream);
          } catch (err) {
            console.error(`[port-forwarding] Failed to update HTTP proxy for port ${port}: ${(err as Error).message}`);
          }
        }
      }

      this.currentPorts = [...allPorts].sort((a, b) => a - b);
      this.sideBySideEnvs.push({ envId, envName: newEnv.name, hostname: newHostname });
    }

    this.ctx.broadcast();
    console.log(`[port-forwarding] Added ${newEnv.name} to compare (${this.sideBySideEnvs.length} envs)`);
  }

  /**
   * Remove a single env from the compare session.
   * If only the active env remains, transitions back to regular forwarding (HTTP → TCP proxies).
   */
  private async removeCompare(envId: string): Promise<void> {
    if (envId === this.activeEnvId) throw new Error('Cannot remove the primary forwarding environment from compare');

    const idx = this.sideBySideEnvs.findIndex((s) => s.envId === envId);
    if (idx === -1) throw new Error('Environment is not in the compare list');

    // Kill tunnel for this env
    const tunnel = this.sideBySideTunnels.get(envId);
    if (tunnel) {
      this.killProcess(tunnel);
      this.sideBySideTunnels.delete(envId);
    }

    // Remove hostname route from all HTTP proxies
    const removedHostname = this.sideBySideEnvs[idx].hostname;
    for (const port of this.proxyManager.getProxiedPorts()) {
      const routes = this.proxyManager.getHttpRoutes(port);
      if (routes) {
        routes.delete(removedHostname);
      }
    }

    this.compareMappings.delete(envId);
    this.sideBySideEnvs.splice(idx, 1);

    // If only the active env remains, transition back to regular forwarding
    if (this.sideBySideEnvs.length <= 1) {
      this.sideBySideEnvs = [];

      // Transition HTTP proxies back to TCP proxies
      for (const port of this.currentPorts) {
        const upstream = this.portMappings.get(port);
        if (upstream !== undefined) {
          try {
            await this.proxyManager.ensureProxy(port, upstream);
          } catch (err) {
            console.error(`[port-forwarding] Failed to restore TCP proxy for port ${port}: ${(err as Error).message}`);
          }
        }
      }

      // Restore currentPorts to just the active env's ports
      this.currentPorts = [...this.portMappings.keys()].sort((a, b) => a - b);
      this.compareMappings.clear();
    }

    this.ctx.broadcast();
    console.log(`[port-forwarding] Removed env from compare (${this.sideBySideEnvs.length} envs remaining)`);
  }

  private generateHostname(env: { name: string; branch: string }, usedHostnames: Set<string>): string {
    let hostname = env.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    if (usedHostnames.has(hostname)) {
      const branch = env.branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      hostname = `${hostname}-${branch}`;
    }
    let suffix = 2;
    while (usedHostnames.has(hostname)) {
      hostname = `${env.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${suffix++}`;
    }
    return hostname;
  }

  private async stopSideBySide(): Promise<void> {
    // Kill all side-by-side tunnels
    for (const [, tunnel] of this.sideBySideTunnels) {
      this.killProcess(tunnel);
    }
    this.sideBySideTunnels.clear();
    this.compareMappings.clear();

    await this.proxyManager.removeAll();
    this.sideBySideEnvs = [];
    this.activeEnvId = null;
    this.currentPorts = [];
    this.currentLabels = {};
    this.currentUrls = {};
    this.portConflicts = {};
    this.setStatus('idle');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private portsEqual(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((p, i) => p === b[i]);
  }

  private setStatus(status: PortForwardingState['status'], error?: string): void {
    this.status = status;
    this.error = error;
    this.ctx.broadcast();
  }
}
