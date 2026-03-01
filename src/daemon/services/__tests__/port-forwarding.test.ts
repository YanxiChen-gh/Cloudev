import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PortForwardingService } from '../port-forwarding';
import { ServiceContext } from '../../service';
import { MockProvider, MOCK_ENVS } from '../../../__tests__/helpers/mock-provider';
import { DaemonState } from '../../../types';

function makeContext(provider: MockProvider): ServiceContext {
  return {
    broadcast: vi.fn(),
    getProvider: (_envId: string) => provider,
    getEnvironments: () => provider.environments,
  };
}

describe('PortForwardingService', () => {
  let provider: MockProvider;
  let ctx: ServiceContext;
  let service: PortForwardingService;

  beforeEach(() => {
    provider = new MockProvider();
    ctx = makeContext(provider);
    service = new PortForwardingService(ctx);
  });

  afterEach(async () => {
    await service.stop();
  });

  it('starts in idle state', () => {
    const state = service.getState();
    expect(state.portForwarding?.status).toBe('idle');
    expect(state.portForwarding?.activeEnvId).toBeNull();
  });

  it('handles port-forwarding.start', async () => {
    await service.handleMessage({
      type: 'port-forwarding.start',
      requestId: '1',
      envId: 'env-1',
    });

    const state = service.getState();
    expect(state.portForwarding?.activeEnvId).toBe('env-1');
    expect(state.portForwarding?.status).toBe('active');
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('handles port-forwarding.stop', async () => {
    await service.handleMessage({
      type: 'port-forwarding.start',
      requestId: '1',
      envId: 'env-1',
    });

    await service.handleMessage({
      type: 'port-forwarding.stop',
      requestId: '2',
    });

    const state = service.getState();
    expect(state.portForwarding?.activeEnvId).toBeNull();
    expect(state.portForwarding?.status).toBe('idle');
  });

  it('discovers ports on start', async () => {
    provider.ports = [3000, 8080];

    await service.handleMessage({
      type: 'port-forwarding.start',
      requestId: '1',
      envId: 'env-1',
    });

    const state = service.getState();
    expect(state.portForwarding?.ports).toEqual([3000, 8080]);
  });

  it('throws if provider not found', async () => {
    const emptyCtx: ServiceContext = {
      broadcast: vi.fn(),
      getProvider: () => undefined,
      getEnvironments: () => [],
    };
    const svc = new PortForwardingService(emptyCtx);

    await expect(
      svc.handleMessage({
        type: 'port-forwarding.start',
        requestId: '1',
        envId: 'nonexistent',
      }),
    ).rejects.toThrow('No provider found');

    await svc.stop();
  });

  it('passes port labels through state', async () => {
    provider.discoverPorts = async () => ({
      ports: [3000, 8080],
      labels: { 3000: 'turborepo', 8080: 'nginx' },
    });

    await service.handleMessage({
      type: 'port-forwarding.start',
      requestId: '1',
      envId: 'env-1',
    });

    const state = service.getState();
    expect(state.portForwarding?.portLabels).toEqual({
      3000: 'turborepo',
      8080: 'nginx',
    });
  });

  it('clears port labels on stop', async () => {
    provider.discoverPorts = async () => ({
      ports: [3000],
      labels: { 3000: 'web' },
    });

    await service.handleMessage({
      type: 'port-forwarding.start',
      requestId: '1',
      envId: 'env-1',
    });

    await service.handleMessage({
      type: 'port-forwarding.stop',
      requestId: '2',
    });

    const state = service.getState();
    expect(state.portForwarding?.portLabels).toEqual({});
  });

  it('onStateChanged stops forwarding if env disappears', async () => {
    await service.handleMessage({
      type: 'port-forwarding.start',
      requestId: '1',
      envId: 'env-1',
    });

    // Simulate env disappearing from state
    const fakeState: DaemonState = {
      environments: [], // env-1 is gone
      portForwarding: service.getState().portForwarding!,
      providers: [],
    };
    service.onStateChanged!(fakeState);

    // stopForwarding is async — wait for it to complete
    await new Promise((r) => setTimeout(r, 50));

    const state = service.getState();
    expect(state.portForwarding?.status).toBe('idle');
    expect(state.portForwarding?.activeEnvId).toBeNull();
  });

  it('onStateChanged stops forwarding if env stops', async () => {
    await service.handleMessage({
      type: 'port-forwarding.start',
      requestId: '1',
      envId: 'env-1',
    });

    const fakeState: DaemonState = {
      environments: [{ ...MOCK_ENVS[0], status: 'stopped' }],
      portForwarding: service.getState().portForwarding!,
      providers: [],
    };
    service.onStateChanged!(fakeState);

    await new Promise((r) => setTimeout(r, 50));

    expect(service.getState().portForwarding?.status).toBe('idle');
  });

  it('handles message routing', () => {
    expect(service.handles('port-forwarding.start')).toBe(true);
    expect(service.handles('port-forwarding.stop')).toBe(true);
    expect(service.handles('environments.start')).toBe(false);
  });
});
