import { EventEmitter } from 'events';
import { DaemonState, DaemonEvent, Environment, PortForwardingState } from '../types';
import { DaemonClient } from './daemon-client';

export class StateStore extends EventEmitter {
  private state: DaemonState = {
    environments: [],
    portForwarding: {
      activeEnvId: null,
      activeEnvName: null,
      ports: [],
      portLabels: {},
      status: 'idle',
    },
    providers: [],
  };

  constructor(private readonly client: DaemonClient) {
    super();

    client.on('state-update', (newState: DaemonState) => {
      this.state = newState;
      this.emit('changed');
    });

    client.on('event', (event: DaemonEvent) => {
      this.applyEvent(event);
      this.emit('changed');
    });

    client.on('disconnected', () => {
      // Keep stale state — better UX than blanking the sidebar
      this.emit('connection-lost');
    });

    client.on('reconnected', () => {
      this.emit('connection-restored');
    });
  }

  getEnvironments(): Environment[] {
    return this.state.environments;
  }

  getEnvironmentsByProject(): Map<string, Environment[]> {
    const map = new Map<string, Environment[]>();
    for (const env of this.state.environments) {
      const key = env.projectName || 'Unknown Project';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(env);
    }
    return map;
  }

  getPortForwarding(): PortForwardingState {
    return this.state.portForwarding;
  }

  getRunningCount(): number {
    return this.state.environments.filter((e) => e.status === 'running').length;
  }

  getEnvironment(id: string): Environment | undefined {
    return this.state.environments.find((e) => e.id === id);
  }

  isForwarding(envId: string): boolean {
    return this.state.portForwarding.activeEnvId === envId;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private applyEvent(event: DaemonEvent): void {
    switch (event.kind) {
      case 'environment-changed': {
        const idx = this.state.environments.findIndex(
          (e) => e.id === event.environment.id,
        );
        if (idx >= 0) {
          this.state.environments[idx] = event.environment;
        } else {
          this.state.environments.push(event.environment);
        }
        break;
      }
      case 'environment-removed': {
        this.state.environments = this.state.environments.filter(
          (e) => e.id !== event.envId,
        );
        break;
      }
      case 'port-forwarding-changed':
        this.state.portForwarding = event.portForwarding;
        break;
      case 'provider-status-changed': {
        const pidx = this.state.providers.findIndex(
          (p) => p.id === event.provider.id,
        );
        if (pidx >= 0) {
          this.state.providers[pidx] = event.provider;
        } else {
          this.state.providers.push(event.provider);
        }
        break;
      }
    }
  }
}
