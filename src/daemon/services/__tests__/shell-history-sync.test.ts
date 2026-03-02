import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ShellHistorySyncService } from '../shell-history-sync';
import { ServiceContext } from '../../service';
import { MockProvider, MOCK_ENVS } from '../../../__tests__/helpers/mock-provider';

const HISTORY_DIR = path.join(os.homedir(), '.cloudev');
const BASH_STORE = path.join(HISTORY_DIR, 'shell-history-bash');
const ZSH_STORE = path.join(HISTORY_DIR, 'shell-history-zsh');
const MARKER = '===CLOUDEV_SHELL_SEP===';

// The collect command the service sends to remote
const COLLECT_CMD = `echo '${MARKER}bash'; cat ~/.bash_history 2>/dev/null; echo '${MARKER}zsh'; cat ~/.zsh_history 2>/dev/null`;

function makeContext(provider: MockProvider): ServiceContext {
  return {
    broadcast: vi.fn(),
    getProvider: (_envId: string) => provider,
    getEnvironments: () => provider.environments,
  };
}

function mockRemoteHistory(bash: string, zsh: string): string {
  return `${MARKER}bash\n${bash}${MARKER}zsh\n${zsh}`;
}

describe('ShellHistorySyncService', () => {
  let provider: MockProvider;
  let ctx: ServiceContext;
  let service: ShellHistorySyncService;
  let origBash: string | null = null;
  let origZsh: string | null = null;

  beforeEach(() => {
    try { origBash = fs.readFileSync(BASH_STORE, 'utf-8'); } catch { origBash = null; }
    try { origZsh = fs.readFileSync(ZSH_STORE, 'utf-8'); } catch { origZsh = null; }
    try { fs.unlinkSync(BASH_STORE); } catch { /* noop */ }
    try { fs.unlinkSync(ZSH_STORE); } catch { /* noop */ }

    provider = new MockProvider();
    ctx = makeContext(provider);
    service = new ShellHistorySyncService(ctx);
  });

  afterEach(async () => {
    await service.stop();
    try { fs.unlinkSync(BASH_STORE); } catch { /* noop */ }
    try { fs.unlinkSync(ZSH_STORE); } catch { /* noop */ }
    if (origBash !== null) fs.writeFileSync(BASH_STORE, origBash);
    if (origZsh !== null) fs.writeFileSync(ZSH_STORE, origZsh);
  });

  it('starts in idle state with zero entries', async () => {
    await service.start();
    const state = service.getState();
    expect(state.shellHistory?.status).toBe('idle');
    expect(state.shellHistory?.entryCount).toBe(0);
  });

  it('handles history.* messages', () => {
    expect(service.handles('history.collect')).toBe(true);
    expect(service.handles('history.clear')).toBe(true);
    expect(service.handles('history.configure')).toBe(true);
    expect(service.handles('environments.list')).toBe(false);
  });

  it('syncs bash history from remote', async () => {
    provider.execRemoteResults[COLLECT_CMD] =
      mockRemoteHistory('git status\nnpm install\n', '');

    await service.handleMessage({
      type: 'history.collect',
      requestId: '1',
      envId: 'env-1',
    });

    const stored = fs.readFileSync(BASH_STORE, 'utf-8');
    expect(stored).toContain('git status');
    expect(stored).toContain('npm install');
    expect(fs.existsSync(ZSH_STORE)).toBe(false); // no zsh content
    expect(service.getState().shellHistory?.entryCount).toBe(2);
  });

  it('syncs bash and zsh separately', async () => {
    provider.execRemoteResults[COLLECT_CMD] =
      mockRemoteHistory('bash-cmd\n', ': 1700000000:0;zsh-cmd\n');

    await service.handleMessage({
      type: 'history.collect',
      requestId: '1',
      envId: 'env-1',
    });

    const bash = fs.readFileSync(BASH_STORE, 'utf-8');
    const zsh = fs.readFileSync(ZSH_STORE, 'utf-8');
    expect(bash).toContain('bash-cmd');
    expect(bash).not.toContain('zsh-cmd');
    expect(zsh).toContain(': 1700000000:0;zsh-cmd');
    expect(zsh).not.toContain('bash-cmd');
  });

  it('bidirectional sync pushes diff per shell', async () => {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(BASH_STORE, 'local-bash\n');
    fs.writeFileSync(ZSH_STORE, ': 1700000000:0;local-zsh\n');
    await service.start();

    provider.execRemoteResults[COLLECT_CMD] =
      mockRemoteHistory('remote-bash\n', ': 1700000001:0;remote-zsh\n');

    await service.handleMessage({
      type: 'history.collect',
      requestId: '1',
      envId: 'env-1',
    });

    // Local stores should have both local + remote entries
    const bash = fs.readFileSync(BASH_STORE, 'utf-8');
    expect(bash).toContain('local-bash');
    expect(bash).toContain('remote-bash');

    const zsh = fs.readFileSync(ZSH_STORE, 'utf-8');
    expect(zsh).toContain(': 1700000000:0;local-zsh');
    expect(zsh).toContain(': 1700000001:0;remote-zsh');

    // Push should have sent only the missing lines
    const pushCall = provider.calls.find(
      (c) => c.method === 'execRemoteCommand' && (c.args[1] as string).includes('base64 -d >>'),
    );
    expect(pushCall).toBeDefined();
    const pushCmd = pushCall!.args[1] as string;
    // Should push local-bash to bash and local-zsh to zsh
    expect(pushCmd).toContain('>> ~/.bash_history');
    expect(pushCmd).toContain('>> ~/.zsh_history');
  });

  it('repeated sync produces no duplicate push', async () => {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(BASH_STORE, 'cmd-a\n');
    await service.start();

    provider.execRemoteResults[COLLECT_CMD] =
      mockRemoteHistory('cmd-a\n', '');

    await service.handleMessage({
      type: 'history.collect',
      requestId: '1',
      envId: 'env-1',
    });

    const pushCall = provider.calls.find(
      (c) => c.method === 'execRemoteCommand' && (c.args[1] as string).includes('base64 -d >>'),
    );
    expect(pushCall).toBeUndefined();
  });

  it('clear deletes all stores', async () => {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(BASH_STORE, 'cmd-a\n');
    fs.writeFileSync(ZSH_STORE, 'cmd-b\n');
    await service.start();
    expect(service.getState().shellHistory?.entryCount).toBe(2);

    await service.handleMessage({ type: 'history.clear', requestId: '1' });

    expect(service.getState().shellHistory?.entryCount).toBe(0);
    expect(fs.existsSync(BASH_STORE)).toBe(false);
    expect(fs.existsSync(ZSH_STORE)).toBe(false);
  });

  it('skips envs without execRemoteCommand', async () => {
    const bareProvider = { ...provider, execRemoteCommand: undefined };
    const bareCtx: ServiceContext = {
      broadcast: vi.fn(),
      getProvider: () => bareProvider as any,
      getEnvironments: () => provider.environments,
    };
    const bareService = new ShellHistorySyncService(bareCtx);

    await bareService.handleMessage({
      type: 'history.collect',
      requestId: '1',
      envId: 'env-1',
    });

    expect(bareService.getState().shellHistory?.entryCount).toBe(0);
  });

  it('syncs from multiple running envs', async () => {
    provider.execRemoteResults[COLLECT_CMD] =
      mockRemoteHistory('shared-cmd\n', '');

    await service.handleMessage({
      type: 'history.collect',
      requestId: '1',
    });

    const stored = fs.readFileSync(BASH_STORE, 'utf-8');
    expect(stored).toContain('shared-cmd');

    const collectCalls = provider.calls.filter(
      (c) => c.method === 'execRemoteCommand' && (c.args[1] as string).includes(MARKER),
    );
    expect(collectCalls.length).toBe(2); // env-1 and env-3 (both running)
  });

  it('configures periodic sync timer', async () => {
    vi.useFakeTimers();

    provider.execRemoteResults[COLLECT_CMD] =
      mockRemoteHistory('periodic-cmd\n', '');

    await service.handleMessage({
      type: 'history.configure',
      requestId: '1',
      periodicSyncMinutes: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    const stored = fs.readFileSync(BASH_STORE, 'utf-8');
    expect(stored).toContain('periodic-cmd');

    await service.handleMessage({
      type: 'history.configure',
      requestId: '2',
      periodicSyncMinutes: 0,
    });

    vi.useRealTimers();
  });
});
