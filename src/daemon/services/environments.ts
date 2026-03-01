import { ClientMessage, DaemonState, Environment, Project, ProviderStatus } from '../../types';
import { EnvironmentProvider } from '../providers/types';
import { DaemonService, ServiceContext } from '../service';

export class EnvironmentsService implements DaemonService {
  readonly id = 'environments';

  private environments = new Map<string, Environment>();
  private envProviderMap = new Map<string, EnvironmentProvider>();
  private providerStatuses: ProviderStatus[] = [];
  private projectNameMap = new Map<string, string>(); // projectId → name
  private pollTimer: NodeJS.Timeout | null = null;
  private sshConfigTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly providers: EnvironmentProvider[],
    private readonly ctx: ServiceContext,
    private readonly pollIntervalMs: number = 10_000,
    private readonly sshConfigIntervalMs: number = 60_000,
  ) {}

  handles(msgType: string): boolean {
    return msgType.startsWith('environments.');
  }

  async handleMessage(msg: ClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'environments.list':
        return this.getEnvironmentList();

      case 'environments.start': {
        const m = msg as Extract<ClientMessage, { type: 'environments.start' }>;
        const provider = this.envProviderMap.get(m.envId);
        if (!provider) throw new Error(`Unknown environment: ${m.envId}`);
        await provider.start(m.envId);
        await this.poll();
        return;
      }

      case 'environments.stop': {
        const m = msg as Extract<ClientMessage, { type: 'environments.stop' }>;
        const provider = this.envProviderMap.get(m.envId);
        if (!provider) throw new Error(`Unknown environment: ${m.envId}`);
        await provider.stop(m.envId);
        await this.poll();
        return;
      }

      case 'environments.create': {
        const m = msg as Extract<ClientMessage, { type: 'environments.create' }>;
        // Route to specific provider if requested, otherwise first available
        let provider: EnvironmentProvider | undefined;
        if (m.providerId) {
          provider = this.providers.find(p => p.id === m.providerId);
          if (!provider) throw new Error(`Provider not found: ${m.providerId}`);
          const status = this.providerStatuses.find(s => s.id === m.providerId);
          if (!status?.available) throw new Error(`Provider not available: ${m.providerId}`);
        } else {
          provider = this.providers.find(p =>
            this.providerStatuses.find(s => s.id === p.id)?.available,
          );
        }
        if (!provider) throw new Error('No provider available');
        const envId = await provider.create({
          projectId: m.projectId,
          machineClassId: m.machineClassId,
          branch: m.branch,
        });
        await this.poll();
        return envId;
      }

      case 'environments.delete': {
        const m = msg as Extract<ClientMessage, { type: 'environments.delete' }>;
        const provider = this.envProviderMap.get(m.envId);
        if (!provider) throw new Error(`Unknown environment: ${m.envId}`);
        await provider.delete(m.envId);
        await this.poll();
        return;
      }

      case 'environments.restart': {
        const m = msg as Extract<ClientMessage, { type: 'environments.restart' }>;
        const provider = this.envProviderMap.get(m.envId);
        if (!provider) throw new Error(`Unknown environment: ${m.envId}`);
        await provider.restart(m.envId);
        await this.poll();
        return;
      }

      case 'environments.refresh':
        await this.poll();
        return;

      case 'environments.listProjects': {
        const m = msg as Extract<ClientMessage, { type: 'environments.listProjects' }>;
        const provider = this.providers.find(p => p.id === m.providerId);
        if (!provider) throw new Error(`Provider not found: ${m.providerId}`);
        return provider.listProjects();
      }

      case 'environments.listMachineClasses': {
        const m = msg as Extract<ClientMessage, { type: 'environments.listMachineClasses' }>;
        const provider = this.providers.find(p => p.id === m.providerId);
        if (!provider) throw new Error(`Provider not found: ${m.providerId}`);
        return provider.listMachineClasses?.(m.repo) ?? [];
      }

      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  getState(): Partial<DaemonState> {
    return {
      environments: this.getEnvironmentList(),
      providers: this.providerStatuses,
    };
  }

  getEnvironmentList(): Environment[] {
    return Array.from(this.environments.values());
  }

  getProvider(envId: string): EnvironmentProvider | undefined {
    return this.envProviderMap.get(envId);
  }

  async start(): Promise<void> {
    // Check provider availability
    this.providerStatuses = await Promise.all(
      this.providers.map(async (p) => {
        const status = await p.checkAvailability();
        return {
          id: p.id,
          displayName: p.displayName,
          available: status.available,
          error: status.error,
        };
      }),
    );

    // Load projects for name resolution
    await this.loadProjects();

    // Initial poll
    await this.poll();

    // Initial SSH config sync
    this.syncSshConfigs();

    // Start periodic polling
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.sshConfigTimer = setInterval(
      () => this.syncSshConfigs(),
      this.sshConfigIntervalMs,
    );
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sshConfigTimer) {
      clearInterval(this.sshConfigTimer);
      this.sshConfigTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    const allEnvs: Environment[] = [];
    const activeProviders = this.providers.filter((p) =>
      this.providerStatuses.find((s) => s.id === p.id)?.available,
    );

    await Promise.allSettled(
      activeProviders.map(async (provider) => {
        try {
          const envs = await provider.listEnvironments();
          allEnvs.push(...envs);
        } catch {
          // Provider failed — skip
        }
      }),
    );

    // Build new maps, enriching with project names
    const newEnvMap = new Map<string, Environment>();
    const newProviderMap = new Map<string, EnvironmentProvider>();

    for (const env of allEnvs) {
      if (env.projectId && !env.projectName) {
        env.projectName = this.projectNameMap.get(env.projectId) ?? '';
      }
      // Fallback: use projectId as grouping name if no project name found
      // (Codespaces uses owner/repo as projectId, which works as a display name)
      if (!env.projectName && env.projectId) {
        env.projectName = env.projectId;
      }
      newEnvMap.set(env.id, env);
      const provider = activeProviders.find((p) => p.id === env.provider);
      if (provider) {
        newProviderMap.set(env.id, provider);
      }
    }

    this.environments = newEnvMap;
    this.envProviderMap = newProviderMap;

    // Broadcast updated state
    this.ctx.broadcast();
  }

  private async loadProjects(): Promise<void> {
    const activeProviders = this.providers.filter((p) =>
      this.providerStatuses.find((s) => s.id === p.id)?.available,
    );
    const allProjects: Project[] = [];
    await Promise.allSettled(
      activeProviders.map(async (provider) => {
        try {
          const projects = await provider.listProjects();
          allProjects.push(...projects);
        } catch {
          // Skip
        }
      }),
    );
    this.projectNameMap.clear();
    for (const p of allProjects) {
      this.projectNameMap.set(p.id, p.name);
    }
  }

  private async syncSshConfigs(): Promise<void> {
    const activeProviders = this.providers.filter((p) =>
      this.providerStatuses.find((s) => s.id === p.id)?.available,
    );
    await Promise.allSettled(
      activeProviders.map((p) => p.syncSshConfig()),
    );
  }
}
