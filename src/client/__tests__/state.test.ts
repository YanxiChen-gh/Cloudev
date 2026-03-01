import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { StateStore } from '../state';
import { DaemonClient } from '../daemon-client';
import { DaemonState, DaemonEvent, Environment } from '../../types';

function makeMockClient(): DaemonClient {
  // DaemonClient extends EventEmitter — create a minimal mock
  const emitter = new EventEmitter();
  return emitter as unknown as DaemonClient;
}

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'env-1',
    provider: 'ona',
    name: 'test-env',
    projectId: 'proj-1',
    projectName: 'TestProject',
    branch: 'main',
    status: 'running',
    repositoryUrl: 'https://github.com/test/repo.git',
    checkoutLocation: 'repo',
    sshHost: 'env-1.ona.environment',
    workspacePath: '/workspaces/repo',
    webUrl: 'https://app.ona.io/environments/env-1',
    ...overrides,
  };
}

function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    environments: [makeEnv()],
    portForwarding: { activeEnvId: null, activeEnvName: null, ports: [], portLabels: {}, portUrls: {}, status: 'idle' },
    providers: [{ id: 'ona', displayName: 'Ona', available: true }],
    ...overrides,
  };
}

describe('StateStore', () => {
  let client: DaemonClient;
  let store: StateStore;

  beforeEach(() => {
    client = makeMockClient();
    store = new StateStore(client);
  });

  it('starts with empty state', () => {
    expect(store.getEnvironments()).toEqual([]);
    expect(store.getRunningCount()).toBe(0);
    expect(store.getPortForwarding().status).toBe('idle');
  });

  it('replaces state on state-update', () => {
    const state = makeState();
    (client as unknown as EventEmitter).emit('state-update', state);

    expect(store.getEnvironments()).toHaveLength(1);
    expect(store.getEnvironments()[0].name).toBe('test-env');
  });

  it('emits changed on state-update', () => {
    let changed = false;
    store.on('changed', () => { changed = true; });

    (client as unknown as EventEmitter).emit('state-update', makeState());
    expect(changed).toBe(true);
  });

  describe('applyEvent', () => {
    beforeEach(() => {
      (client as unknown as EventEmitter).emit('state-update', makeState());
    });

    it('applies environment-changed for existing env', () => {
      const event: DaemonEvent = {
        kind: 'environment-changed',
        environment: makeEnv({ status: 'stopped' }),
      };
      (client as unknown as EventEmitter).emit('event', event);

      expect(store.getEnvironment('env-1')?.status).toBe('stopped');
    });

    it('applies environment-changed for new env', () => {
      const event: DaemonEvent = {
        kind: 'environment-changed',
        environment: makeEnv({ id: 'env-new', name: 'new-env' }),
      };
      (client as unknown as EventEmitter).emit('event', event);

      expect(store.getEnvironments()).toHaveLength(2);
      expect(store.getEnvironment('env-new')?.name).toBe('new-env');
    });

    it('applies environment-removed', () => {
      const event: DaemonEvent = { kind: 'environment-removed', envId: 'env-1' };
      (client as unknown as EventEmitter).emit('event', event);

      expect(store.getEnvironments()).toHaveLength(0);
    });

    it('applies port-forwarding-changed', () => {
      const event: DaemonEvent = {
        kind: 'port-forwarding-changed',
        portForwarding: { activeEnvId: 'env-1', activeEnvName: 'test-env', ports: [3000], portLabels: {}, portUrls: {}, status: 'active' },
      };
      (client as unknown as EventEmitter).emit('event', event);

      const pf = store.getPortForwarding();
      expect(pf.activeEnvId).toBe('env-1');
      expect(pf.ports).toEqual([3000]);
      expect(pf.status).toBe('active');
    });

    it('applies port-forwarding-changed with labels', () => {
      const event: DaemonEvent = {
        kind: 'port-forwarding-changed',
        portForwarding: {
          activeEnvId: 'env-1',
          activeEnvName: 'test-env',
          ports: [3000, 8080],
          portLabels: { 3000: 'turborepo', 8080: 'nginx' },
          portUrls: {},
          status: 'active',
        },
      };
      (client as unknown as EventEmitter).emit('event', event);

      const pf = store.getPortForwarding();
      expect(pf.portLabels).toEqual({ 3000: 'turborepo', 8080: 'nginx' });
    });
  });

  describe('derived queries', () => {
    it('getEnvironmentsByProject groups correctly', () => {
      const state = makeState({
        environments: [
          makeEnv({ id: 'e1', projectName: 'ProjectA' }),
          makeEnv({ id: 'e2', projectName: 'ProjectA' }),
          makeEnv({ id: 'e3', projectName: 'ProjectB' }),
        ],
      });
      (client as unknown as EventEmitter).emit('state-update', state);

      const byProject = store.getEnvironmentsByProject();
      expect(byProject.get('ProjectA')).toHaveLength(2);
      expect(byProject.get('ProjectB')).toHaveLength(1);
    });

    it('getRunningCount counts only running envs', () => {
      const state = makeState({
        environments: [
          makeEnv({ id: 'e1', status: 'running' }),
          makeEnv({ id: 'e2', status: 'stopped' }),
          makeEnv({ id: 'e3', status: 'running' }),
        ],
      });
      (client as unknown as EventEmitter).emit('state-update', state);
      expect(store.getRunningCount()).toBe(2);
    });

    it('isForwarding checks activeEnvId', () => {
      const state = makeState();
      state.portForwarding.activeEnvId = 'env-1';
      (client as unknown as EventEmitter).emit('state-update', state);

      expect(store.isForwarding('env-1')).toBe(true);
      expect(store.isForwarding('env-2')).toBe(false);
    });

    it('groups envs with empty projectName under "Unknown Project"', () => {
      const state = makeState({
        environments: [makeEnv({ id: 'e1', projectName: '' })],
      });
      (client as unknown as EventEmitter).emit('state-update', state);

      const byProject = store.getEnvironmentsByProject();
      expect(byProject.has('Unknown Project')).toBe(true);
    });
  });
});
