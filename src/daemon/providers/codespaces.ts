import { ChildProcess, execFile, spawn } from 'child_process';
import { Environment, Project, MachineClass } from '../../types';
import { EnvironmentProvider, CreateOpts, PortMapping } from './types';
import { mapCodespace, parseCodespacePorts } from './codespaces-parser';

const GH_BIN = 'gh';
const CLI_TIMEOUT_MS = 30_000;
const CODESPACE_FIELDS = 'name,state,repository,gitStatus,machineName';

export type GhExecFn = (args: string[]) => Promise<string>;

function defaultGhExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GH_BIN, args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gh ${args[0]} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export class CodespacesProvider implements EnvironmentProvider {
  readonly id = 'codespaces';
  readonly displayName = 'GitHub Codespaces';

  private readonly execFn: GhExecFn;

  constructor(execFn?: GhExecFn) {
    this.execFn = execFn ?? defaultGhExec;
  }

  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    try {
      await this.execFn(['auth', 'status']);
    } catch {
      return { available: false, error: 'GitHub CLI not installed or not logged in. Run `gh auth login`.' };
    }

    try {
      await this.execFn(['codespace', 'list', '--limit', '1', '--json', 'name']);
      return { available: true };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('codespace') && msg.includes('scope')) {
        return { available: false, error: 'Missing "codespace" scope. Run: gh auth refresh -h github.com -s codespace' };
      }
      return { available: false, error: `Codespaces not available: ${msg}` };
    }
  }

  async listEnvironments(): Promise<Environment[]> {
    const raw = await this.execFn([
      'codespace', 'list', '--json', CODESPACE_FIELDS,
    ]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const envs: Environment[] = [];
    for (const entry of parsed) {
      const env = mapCodespace(entry, this.id);
      if (env) envs.push(env);
    }
    return envs;
  }

  async start(envId: string): Promise<void> {
    // gh codespace has no explicit start command — codespaces auto-start on connect.
    // Trigger start by initiating an SSH connection that exits immediately.
    await this.execFn(['codespace', 'ssh', '-c', envId, '--', 'echo', 'started']);
  }

  async stop(envId: string): Promise<void> {
    await this.execFn(['codespace', 'stop', '-c', envId]);
  }

  async restart(envId: string): Promise<void> {
    await this.stop(envId);
    await this.waitForState(envId, 'shutdown', 120_000);
    await this.start(envId);
  }

  async create(opts: CreateOpts): Promise<string> {
    const args = ['codespace', 'create', '-R', opts.projectId];
    if (opts.branch) {
      args.push('-b', opts.branch);
    }
    // Machine type is required — gh prompts interactively without it, which fails headless
    if (opts.machineClassId) {
      args.push('-m', opts.machineClassId);
    } else {
      // Default to smallest available machine
      args.push('-m', 'basicLinux32gb');
    }
    // `gh codespace create` doesn't support --json — it prints the codespace name to stdout
    const result = await this.execFn(args);
    return result.trim();
  }

  async delete(envId: string): Promise<void> {
    await this.execFn(['codespace', 'delete', '-c', envId, '--force']);
  }

  async discoverPorts(envId: string): Promise<{ ports: number[]; labels: Record<number, string>; urls?: Record<number, string> }> {
    try {
      const output = await this.execFn([
        'codespace', 'ports', '-c', envId, '--json', 'sourcePort,label,browseUrl',
      ]);
      const result = parseCodespacePorts(output);
      return {
        ports: result.ports,
        labels: result.labels,
        urls: Object.keys(result.urls).length > 0 ? result.urls : undefined,
      };
    } catch {
      return { ports: [], labels: {} };
    }
  }

  spawnTunnel(envId: string, portMappings: PortMapping[]): ChildProcess {
    const portArgs = portMappings.map((m) => `${m.local}:${m.remote}`);
    return spawn(GH_BIN, ['codespace', 'ports', 'forward', ...portArgs, '-c', envId], {
      stdio: 'pipe',
    });
  }

  sshHost(envId: string): string {
    return envId;
  }

  async syncSshConfig(): Promise<void> {
    // No-op — using `gh codespace code` for connections, not SSH Remote
  }

  async execRemoteCommand(envId: string, command: string): Promise<string> {
    return this.execFn(['codespace', 'ssh', '-c', envId, '--', 'sh', '-c', command]);
  }

  async listProjects(): Promise<Project[]> {
    // Codespaces doesn't have a "projects" concept.
    // Environments are grouped by repository (via projectId = owner/repo).
    return [];
  }

  async listMachineClasses(repo?: string): Promise<MachineClass[]> {
    if (!repo) return [];
    try {
      const output = await this.execFn([
        'api', `repos/${repo}/codespaces/machines`, '--jq', '.machines',
      ]);
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((m: Record<string, unknown>) => ({
        id: String(m.name ?? ''),
        name: String(m.display_name ?? m.name ?? ''),
        description: `${m.cpus} CPUs, ${Math.round(Number(m.memory_in_bytes ?? 0) / 1024 / 1024 / 1024)}GB RAM`,
        cpus: Number(m.cpus ?? 0),
        memoryGb: Math.round(Number(m.memory_in_bytes ?? 0) / 1024 / 1024 / 1024),
      }));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async waitForState(envId: string, targetState: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const pollMs = 2_000;
    while (Date.now() - start < timeoutMs) {
      try {
        const output = await this.execFn(['codespace', 'list', '--json', 'name,state']);
        const parsed = JSON.parse(output);
        const cs = Array.isArray(parsed)
          ? parsed.find((c: Record<string, unknown>) => c.name === envId)
          : null;
        if (cs && String(cs.state).toLowerCase() === targetState.toLowerCase()) return;
      } catch {
        // Ignore poll errors
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
