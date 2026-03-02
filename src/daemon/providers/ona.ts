import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import { Environment, Project, MachineClass } from '../../types';
import { EnvironmentProvider, CreateOpts } from './types';
import { parseSsOutput, parseDockerPorts, getPortLabel, parseGitpodPorts, mapEnvironment, mapProject } from './ona-parser';

const GITPOD_BIN = '/usr/local/bin/gitpod';
const CLI_TIMEOUT_MS = 30_000;
const SSH_TIMEOUT_S = 5;

export type ExecFn = (args: string[]) => Promise<string>;

function defaultExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(GITPOD_BIN, args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gitpod ${args[0]} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
    child.unref?.();
  });
}

export class OnaProvider implements EnvironmentProvider {
  readonly id = 'ona';
  readonly displayName = 'Ona';

  private contexts: { name: string; host: string }[] = [];
  private readonly execFn: ExecFn;
  private readonly skipBinaryCheck: boolean;

  constructor(execFn?: ExecFn) {
    this.execFn = execFn ?? defaultExec;
    this.skipBinaryCheck = !!execFn; // Skip fs.access check when using injected exec (tests)
  }

  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    if (!this.skipBinaryCheck) {
      try {
        await fs.access(GITPOD_BIN, fs.constants.X_OK);
      } catch {
        return { available: false, error: `CLI not found at ${GITPOD_BIN}` };
      }
    }

    try {
      const output = await this.execRaw(['config', 'context', 'list', '-o', 'json']);
      const parsed = JSON.parse(output);
      this.contexts = Array.isArray(parsed)
        ? parsed
            .filter((c: { name?: string }) => c.name)
            .map((c: { name?: string; host?: string }) => ({
              name: c.name!,
              host: String(c.host ?? '').replace(/\/$/, ''),
            }))
        : [];

      if (this.contexts.length === 0) {
        return { available: false, error: 'No contexts configured. Run `gitpod login`.' };
      }

      return { available: true };
    } catch (err) {
      return { available: false, error: `Failed to list contexts: ${(err as Error).message}` };
    }
  }

  async listEnvironments(): Promise<Environment[]> {
    const envMap = new Map<string, Environment>();

    await Promise.allSettled(
      this.contexts.map(async (ctx) => {
        try {
          const raw = await this.execWithContext(['environment', 'list', '-o', 'json'], ctx.name);
          const envs = JSON.parse(raw);
          if (!Array.isArray(envs)) return;
          for (const env of envs) {
            const mapped = mapEnvironment(env, this.id);
            if (mapped && !envMap.has(mapped.id)) {
              mapped.webUrl = ctx.host ? `${ctx.host}/details/${mapped.id}` : '';
              envMap.set(mapped.id, mapped);
            }
          }
        } catch {
          // Context failed — skip
        }
      }),
    );

    return Array.from(envMap.values());
  }

  async start(envId: string): Promise<void> {
    await this.execAnyContext(['environment', 'start', '--dont-wait', envId]);
  }

  async stop(envId: string): Promise<void> {
    await this.execAnyContext(['environment', 'stop', '--dont-wait', envId]);
  }

  async restart(envId: string): Promise<void> {
    await this.execAnyContext(['environment', 'stop', envId]);
    await this.waitForStatus(envId, 'stopped', 120_000);
    await this.execAnyContext(['environment', 'start', '--dont-wait', envId]);
  }

  async create(opts: CreateOpts): Promise<string> {
    const args = ['environment', 'create', opts.projectId, '--dont-wait'];
    if (opts.machineClassId) {
      args.push('--class-id', opts.machineClassId);
    }
    // `gitpod environment create` no longer supports -o json.
    // It prints the environment ID to stdout.
    const result = await this.execAnyContext(args);
    return result.trim();
  }

  async delete(envId: string): Promise<void> {
    await this.execAnyContext(['environment', 'delete', envId]);
  }

  async discoverPorts(envId: string): Promise<{ ports: number[]; labels: Record<number, string>; urls?: Record<number, string> }> {
    const host = this.sshHost(envId);

    // Run ss, docker ps, and gitpod port list in parallel
    const [ssOutput, dockerOutput, portListOutput] = await Promise.all([
      this.execSsh(host, 'ss -tln'),
      this.execSsh(host, "docker ps --format '{{.Names}}\t{{.Ports}}'").catch(() => ''),
      this.execAnyContext(['environment', 'port', 'list', envId, '-o', 'json']).catch(() => '[]'),
    ]);

    const ports = parseSsOutput(ssOutput);
    const dockerLabels = parseDockerPorts(dockerOutput);
    const urls = parseGitpodPorts(portListOutput);

    const labels: Record<number, string> = {};
    for (const port of ports) {
      const label = getPortLabel(port, dockerLabels);
      if (label) labels[port] = label;
    }

    return { ports, labels, urls: Object.keys(urls).length > 0 ? urls : undefined };
  }

  spawnTunnel(envId: string, ports: number[]): ChildProcess {
    const host = this.sshHost(envId);
    const args: string[] = [
      '-N',
      '-o', 'ExitOnForwardFailure=no',
      '-o', `ConnectTimeout=${SSH_TIMEOUT_S}`,
      '-o', 'StrictHostKeyChecking=no',
    ];
    for (const port of ports) {
      args.push('-L', `${port}:localhost:${port}`);
    }
    args.push(host);
    return spawn('ssh', args, { stdio: 'pipe' });
  }

  sshHost(envId: string): string {
    return `${envId}.gitpod.environment`;
  }

  async syncSshConfig(): Promise<void> {
    await Promise.allSettled(
      this.contexts.map((ctx) =>
        this.execWithContext(['environment', 'ssh-config'], ctx.name),
      ),
    );
    // Workaround: gitpod CLI sometimes writes truncated "Only yes" instead of
    // "IdentitiesOnly yes" in SSH configs, breaking all SSH connections.
    await this.fixSshConfigs();
  }

  private async fixSshConfigs(): Promise<void> {
    for (const ctx of this.contexts) {
      const host = ctx.host.replace(/^https?:\/\//, '');
      if (!host) continue;
      const configPath = `${process.env.HOME}/.ssh/gitpod/${host}/config`;
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        if (content.includes('\nOnly ')) {
          const fixed = content.replace(/\nOnly /g, '\nIdentitiesOnly ');
          await fs.writeFile(configPath, fixed);
          console.log(`[ona] Fixed truncated IdentitiesOnly in ${configPath}`);
        }
      } catch {
        // Config file doesn't exist — skip
      }
    }
  }

  async listProjects(): Promise<Project[]> {
    const projectMap = new Map<string, Project>();

    await Promise.allSettled(
      this.contexts.map(async (ctx) => {
        try {
          const raw = await this.execWithContext(['project', 'list', '-o', 'json'], ctx.name);
          const projects = JSON.parse(raw);
          if (!Array.isArray(projects)) return;
          for (const p of projects) {
            const mapped = mapProject(p);
            if (mapped && !projectMap.has(mapped.id)) {
              projectMap.set(mapped.id, mapped);
            }
          }
        } catch {
          // Skip failed context
        }
      }),
    );

    return Array.from(projectMap.values());
  }

  async listMachineClasses(): Promise<MachineClass[]> {
    try {
      const raw = await this.execAnyContext(['environment', 'list-classes', '-o', 'json']);
      const classes = JSON.parse(raw);
      if (!Array.isArray(classes)) return [];
      return classes
        .filter((c: Record<string, unknown>) => c.enabled !== false)
        .map((c: Record<string, unknown>) => {
          const runner = String(c.runner ?? '');
          const name = String(c.name ?? c.id ?? '');
          return {
            id: String(c.id ?? ''),
            name: runner ? `${name} (${runner})` : name,
            description: String(c.description ?? ''),
            cpus: Number(c.cpus ?? 0),
            memoryGb: Number(c.memory ?? c.memoryGb ?? 0),
          };
        });
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private execWithContext(args: string[], context: string): Promise<string> {
    return this.execRaw([...args, '--context', context]);
  }

  private execRaw(args: string[]): Promise<string> {
    return this.execFn(args);
  }

  private async execAnyContext(args: string[]): Promise<string> {
    let lastError: Error | undefined;
    for (const ctx of this.contexts) {
      try {
        return await this.execWithContext(args, ctx.name);
      } catch (e) {
        lastError = e as Error;
      }
    }
    throw lastError ?? new Error('No contexts available');
  }

  async execRemoteCommand(envId: string, command: string): Promise<string> {
    return this.execSsh(this.sshHost(envId), command);
  }

  private execSsh(host: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('ssh', [
        '-o', `ConnectTimeout=${SSH_TIMEOUT_S}`,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'BatchMode=yes',
        host,
        command,
      ], {
        timeout: (SSH_TIMEOUT_S + 5) * 1_000,
      }, (err, stdout) => {
        if (err) {
          reject(new Error(`SSH to ${host} failed: ${err.message}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  private async waitForStatus(
    envId: string,
    targetStatus: Environment['status'],
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now();
    const pollMs = 2_000;
    while (Date.now() - start < timeoutMs) {
      const envs = await this.listEnvironments();
      const env = envs.find((e) => e.id === envId);
      if (env?.status === targetStatus) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
