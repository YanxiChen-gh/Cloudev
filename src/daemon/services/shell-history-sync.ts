import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClientMessage, DaemonState, ShellHistoryState } from '../../types';
import { DaemonService, ServiceContext } from '../service';

const HISTORY_DIR = path.join(os.homedir(), '.cloudev');
const MAX_LINES = 50_000;
const MARKER = '===CLOUDEV_SHELL_SEP===';

const SHELLS = [
  { id: 'bash', remotePath: '~/.bash_history' },
  { id: 'zsh', remotePath: '~/.zsh_history' },
];

function localStorePath(shellId: string): string {
  return path.join(HISTORY_DIR, `shell-history-${shellId}`);
}

export class ShellHistorySyncService implements DaemonService {
  readonly id = 'shell-history-sync';

  private status: ShellHistoryState['status'] = 'idle';
  private error: string | undefined;
  private entryCount = 0;
  private lastSyncTime: number | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private isSyncing = false;

  constructor(private readonly ctx: ServiceContext) {}

  handles(msgType: string): boolean {
    return msgType.startsWith('history.');
  }

  async handleMessage(msg: ClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'history.collect': {
        const m = msg as Extract<ClientMessage, { type: 'history.collect' }>;
        await this.sync(m.envId);
        return;
      }
      case 'history.clear':
        this.clearStore();
        return;
      case 'history.configure': {
        const m = msg as Extract<ClientMessage, { type: 'history.configure' }>;
        this.configurePeriodicSync(m.periodicSyncMinutes);
        return;
      }
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  getState(): Partial<DaemonState> {
    return {
      shellHistory: {
        entryCount: this.entryCount,
        lastSyncTime: this.lastSyncTime,
        status: this.status,
        error: this.error,
      },
    };
  }

  async start(): Promise<void> {
    this.entryCount = this.totalEntryCount();
  }

  async stop(): Promise<void> {
    this.stopPeriodicSync();
  }

  // ---------------------------------------------------------------------------
  // Bidirectional sync — per shell type, separate local stores
  // ---------------------------------------------------------------------------

  private async sync(envId?: string): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.setStatus('syncing');

    try {
      const envs = envId
        ? this.ctx.getEnvironments().filter((e) => e.id === envId && e.status === 'running')
        : this.ctx.getEnvironments().filter((e) => e.status === 'running');

      // Per-shell local stores
      const stores = new Map<string, { lines: string[]; set: Set<string>; newLines: string[] }>();
      for (const shell of SHELLS) {
        const lines = this.readStore(shell.id);
        stores.set(shell.id, { lines, set: new Set(lines), newLines: [] });
      }

      // Per-env remote snapshots: envId → shellId → Set<lines>
      const remoteSnapshots = new Map<string, Map<string, Set<string>>>();

      // Pass 1: Collect — one SSH call per env using markers to split shells
      const collectCmd = SHELLS
        .map((s) => `echo '${MARKER}${s.id}'; cat ${s.remotePath} 2>/dev/null`)
        .join('; ');

      await Promise.allSettled(
        envs.map(async (env) => {
          const provider = this.ctx.getProvider(env.id);
          if (!provider?.execRemoteCommand) return;

          try {
            const raw = await provider.execRemoteCommand(env.id, collectCmd);
            const shellSnapshots = this.parseCollectOutput(raw);
            remoteSnapshots.set(env.id, shellSnapshots);

            for (const shell of SHELLS) {
              const remote = shellSnapshots.get(shell.id);
              if (!remote || remote.size === 0) continue;
              const store = stores.get(shell.id)!;
              for (const line of remote) {
                if (!store.set.has(line)) {
                  store.newLines.push(line);
                  store.set.add(line);
                }
              }
            }
          } catch (err) {
            console.error(`[shell-history] Collect failed for ${env.name}: ${(err as Error).message}`);
          }
        }),
      );

      // Save merged local stores
      const mergedStores = new Map<string, string[]>();
      for (const shell of SHELLS) {
        const store = stores.get(shell.id)!;
        const merged = store.newLines.length > 0
          ? [...store.lines, ...store.newLines]
          : store.lines;
        if (store.newLines.length > 0) {
          this.writeStore(shell.id, merged);
        }
        mergedStores.set(shell.id, merged);
      }

      // Pass 2: Push diff — one SSH call per env
      await Promise.allSettled(
        envs.map(async (env) => {
          const provider = this.ctx.getProvider(env.id);
          if (!provider?.execRemoteCommand) return;

          const envSnapshots = remoteSnapshots.get(env.id);
          if (!envSnapshots) return;

          // Build one push command for all shells that have diffs
          const pushParts: string[] = [];
          for (const shell of SHELLS) {
            const remoteSet = envSnapshots.get(shell.id);
            if (!remoteSet) continue; // shell doesn't exist on remote
            const merged = mergedStores.get(shell.id)!;
            const newForRemote = merged.filter((l) => !remoteSet.has(l));
            if (newForRemote.length === 0) continue;
            const content = newForRemote.join('\n') + '\n';
            const b64 = Buffer.from(content).toString('base64');
            pushParts.push(`echo '${b64}' | base64 -d >> ${shell.remotePath}`);
          }

          if (pushParts.length === 0) return;

          try {
            await provider.execRemoteCommand(env.id, pushParts.join('; '));
          } catch (err) {
            console.error(`[shell-history] Push failed for ${env.name}: ${(err as Error).message}`);
          }
        }),
      );

      this.entryCount = this.totalEntryCount();
      this.lastSyncTime = Date.now();
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('error', (err as Error).message);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Parse the collect output that uses markers to separate shell types.
   * Format: ===CLOUDEV_SHELL_SEP===bash\n<lines>\n===CLOUDEV_SHELL_SEP===zsh\n<lines>
   */
  private parseCollectOutput(raw: string): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    const sections = raw.split(MARKER);
    for (const section of sections) {
      if (!section.trim()) continue;
      const lines = section.split('\n');
      const shellId = lines[0]?.trim();
      if (!shellId || !SHELLS.some((s) => s.id === shellId)) continue;
      const commands = lines.slice(1).filter((l) => l.length > 0);
      if (commands.length > 0) {
        result.set(shellId, new Set(commands));
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Clear
  // ---------------------------------------------------------------------------

  private clearStore(): void {
    for (const shell of SHELLS) {
      try { fs.unlinkSync(localStorePath(shell.id)); } catch { /* noop */ }
    }
    this.entryCount = 0;
    this.lastSyncTime = null;
    this.ctx.broadcast();
  }

  // ---------------------------------------------------------------------------
  // Periodic sync
  // ---------------------------------------------------------------------------

  private configurePeriodicSync(minutes: number): void {
    this.stopPeriodicSync();
    if (minutes > 0) {
      const ms = minutes * 60 * 1_000;
      this.periodicTimer = setInterval(() => {
        this.sync().catch((err) => {
          console.error(`[shell-history] Periodic sync failed: ${(err as Error).message}`);
        });
      }, ms);
      console.log(`[shell-history] Periodic sync enabled (every ${minutes} min)`);
    }
  }

  private stopPeriodicSync(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Local store — per shell type, plain text, one command per line
  // ---------------------------------------------------------------------------

  private readStore(shellId: string): string[] {
    try {
      return fs.readFileSync(localStorePath(shellId), 'utf-8').split('\n').filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  private writeStore(shellId: string, lines: string[]): void {
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const line of lines) {
        if (!seen.has(line)) {
          seen.add(line);
          deduped.push(line);
        }
      }
      const capped = deduped.length > MAX_LINES
        ? deduped.slice(deduped.length - MAX_LINES)
        : deduped;
      fs.writeFileSync(localStorePath(shellId), capped.join('\n') + '\n');
    } catch {
      // Best-effort
    }
  }

  private totalEntryCount(): number {
    let count = 0;
    for (const shell of SHELLS) {
      count += this.readStore(shell.id).length;
    }
    return count;
  }

  private setStatus(status: ShellHistoryState['status'], error?: string): void {
    this.status = status;
    this.error = error;
    this.ctx.broadcast();
  }
}
