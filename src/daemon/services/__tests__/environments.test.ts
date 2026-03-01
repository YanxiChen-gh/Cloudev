import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EnvironmentsService } from '../environments';
import { ServiceContext } from '../../service';
import { MockProvider, MOCK_ENVS, MOCK_PROJECTS } from '../../../__tests__/helpers/mock-provider';
import { Environment } from '../../../types';

function makeContext(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    broadcast: vi.fn(),
    getProvider: vi.fn(),
    getEnvironments: () => [],
    ...overrides,
  };
}

describe('EnvironmentsService', () => {
  let provider: MockProvider;
  let ctx: ServiceContext;
  let service: EnvironmentsService;

  beforeEach(() => {
    provider = new MockProvider();
    ctx = makeContext();
    // Use 0ms intervals so tests don't actually wait
    service = new EnvironmentsService([provider], ctx, 100_000, 100_000);
  });

  afterEach(async () => {
    await service.stop();
  });

  it('start() checks provider availability and polls', async () => {
    await service.start();

    const state = service.getState();
    expect(state.environments).toHaveLength(MOCK_ENVS.length);
    expect(state.providers).toHaveLength(1);
    expect(state.providers![0].available).toBe(true);
    expect(ctx.broadcast).toHaveBeenCalled();
  });

  it('enriches environments with project names', async () => {
    await service.start();

    const envs = service.getEnvironmentList();
    const env1 = envs.find((e) => e.id === 'env-1');
    expect(env1?.projectName).toBe('MyProject');
  });

  it('handles unavailable provider gracefully', async () => {
    provider.available = false;
    await service.start();

    const state = service.getState();
    expect(state.environments).toHaveLength(0);
    expect(state.providers![0].available).toBe(false);
  });

  it('handles provider that throws on listEnvironments', async () => {
    provider.listEnvironments = async () => {
      throw new Error('CLI crashed');
    };
    await service.start();

    // Should not crash — allSettled catches the error
    const state = service.getState();
    expect(state.environments).toHaveLength(0);
  });

  describe('handleMessage', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('routes environments.start to provider', async () => {
      await service.handleMessage({
        type: 'environments.start',
        requestId: '1',
        envId: 'env-1',
      });

      expect(provider.calls.find((c) => c.method === 'start')).toBeDefined();
      expect(provider.calls.find((c) => c.method === 'start')?.args[0]).toBe('env-1');
    });

    it('routes environments.stop to provider', async () => {
      await service.handleMessage({
        type: 'environments.stop',
        requestId: '2',
        envId: 'env-1',
      });

      expect(provider.calls.find((c) => c.method === 'stop')?.args[0]).toBe('env-1');
    });

    it('routes environments.restart to provider', async () => {
      await service.handleMessage({
        type: 'environments.restart',
        requestId: '3',
        envId: 'env-1',
      });

      expect(provider.calls.find((c) => c.method === 'restart')?.args[0]).toBe('env-1');
    });

    it('routes environments.delete to provider', async () => {
      await service.handleMessage({
        type: 'environments.delete',
        requestId: '4',
        envId: 'env-2',
      });

      expect(provider.calls.find((c) => c.method === 'delete')?.args[0]).toBe('env-2');
    });

    it('routes environments.create to provider', async () => {
      const result = await service.handleMessage({
        type: 'environments.create',
        requestId: '5',
        projectId: 'proj-1',
      });

      expect(result).toBe('new-env-id');
      expect(provider.calls.find((c) => c.method === 'create')).toBeDefined();
    });

    it('throws for unknown environment', async () => {
      await expect(
        service.handleMessage({
          type: 'environments.start',
          requestId: '6',
          envId: 'nonexistent',
        }),
      ).rejects.toThrow('Unknown environment');
    });

    it('environments.refresh re-polls', async () => {
      const broadcastBefore = (ctx.broadcast as ReturnType<typeof vi.fn>).mock.calls.length;
      await service.handleMessage({ type: 'environments.refresh', requestId: '7' });
      expect((ctx.broadcast as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(broadcastBefore);
    });
  });

  it('getProvider returns correct provider for env', async () => {
    await service.start();
    expect(service.getProvider('env-1')).toBe(provider);
    expect(service.getProvider('nonexistent')).toBeUndefined();
  });
});
