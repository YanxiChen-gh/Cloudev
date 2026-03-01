import { describe, it, expect } from 'vitest';
import { CodespacesProvider, GhExecFn } from '../codespaces';

function createMockGh(responses: Record<string, string>): GhExecFn {
  return async (args: string[]) => {
    const key = args.join(' ');
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    throw new Error(`Unexpected gh call: ${key}`);
  };
}

describe('CodespacesProvider', () => {
  it('checkAvailability returns true when gh is authenticated', async () => {
    const exec = createMockGh({
      'auth status': '',
      'codespace list': '[]',
    });
    const provider = new CodespacesProvider(exec);
    const result = await provider.checkAvailability();
    expect(result.available).toBe(true);
  });

  it('checkAvailability returns false when gh is not available', async () => {
    const exec: GhExecFn = async () => {
      throw new Error('command not found');
    };
    const provider = new CodespacesProvider(exec);
    const result = await provider.checkAvailability();
    expect(result.available).toBe(false);
    expect(result.error).toContain('not installed or not logged in');
  });

  it('listEnvironments parses gh output', async () => {
    const csJson = JSON.stringify([
      {
        name: 'cs-1',
        state: 'Available',
        repository: 'org/repo',
        gitStatus: { ref: 'main' },
        machineName: 'basicLinux32gb',
      },
      {
        name: 'cs-2',
        state: 'Shutdown',
        repository: 'org/other',
        gitStatus: { ref: 'dev' },
        machineName: 'standardLinux32gb',
      },
    ]);
    const exec = createMockGh({ 'codespace list': csJson });
    const provider = new CodespacesProvider(exec);
    const envs = await provider.listEnvironments();

    expect(envs).toHaveLength(2);
    expect(envs[0].provider).toBe('codespaces');
    expect(envs[0].id).toBe('cs-1');
    expect(envs[0].status).toBe('running');
    expect(envs[0].name).toBe('repo');
    expect(envs[1].status).toBe('stopped');
    expect(envs[1].name).toBe('other');
  });

  it('create sends correct args with branch', async () => {
    const calls: string[][] = [];
    const exec: GhExecFn = async (args) => {
      calls.push(args);
      if (args.includes('create')) return 'new-cs\n';
      return '';
    };
    const provider = new CodespacesProvider(exec);
    const result = await provider.create({
      projectId: 'org/repo',
      branch: 'feature',
    });

    expect(result).toBe('new-cs');
    const createCall = calls.find((c) => c.includes('create'));
    expect(createCall).toContain('-R');
    expect(createCall).toContain('org/repo');
    expect(createCall).toContain('-b');
    expect(createCall).toContain('feature');
  });

  it('create sends correct args without branch', async () => {
    const calls: string[][] = [];
    const exec: GhExecFn = async (args) => {
      calls.push(args);
      if (args.includes('create')) return 'new-cs\n';
      return '';
    };
    const provider = new CodespacesProvider(exec);
    await provider.create({ projectId: 'org/repo' });

    const createCall = calls.find((c) => c.includes('create'));
    expect(createCall).not.toContain('-b');
  });

  it('stop sends correct args', async () => {
    const calls: string[][] = [];
    const exec: GhExecFn = async (args) => {
      calls.push(args);
      return '';
    };
    const provider = new CodespacesProvider(exec);
    await provider.stop('cs-1');

    const stopCall = calls.find((c) => c.includes('stop'));
    expect(stopCall).toContain('-c');
    expect(stopCall).toContain('cs-1');
  });

  it('delete sends force flag', async () => {
    const calls: string[][] = [];
    const exec: GhExecFn = async (args) => {
      calls.push(args);
      return '';
    };
    const provider = new CodespacesProvider(exec);
    await provider.delete('cs-1');

    const deleteCall = calls.find((c) => c.includes('delete'));
    expect(deleteCall).toContain('--force');
    expect(deleteCall).toContain('-c');
    expect(deleteCall).toContain('cs-1');
  });

  it('discoverPorts parses gh codespace ports output', async () => {
    const portsJson = JSON.stringify([
      { sourcePort: 3000, label: 'Application', browseUrl: 'https://cs-3000.dev/' },
      { sourcePort: 8080, label: '', browseUrl: 'https://cs-8080.dev/' },
    ]);
    const exec = createMockGh({ 'codespace ports': portsJson });
    const provider = new CodespacesProvider(exec);
    const result = await provider.discoverPorts('cs-1');

    expect(result.ports).toEqual([3000, 8080]);
    expect(result.labels[3000]).toBe('Application');
    expect(result.urls?.[3000]).toBe('https://cs-3000.dev/');
  });

  it('discoverPorts returns empty on failure', async () => {
    const exec: GhExecFn = async () => {
      throw new Error('not connected');
    };
    const provider = new CodespacesProvider(exec);
    const result = await provider.discoverPorts('cs-1');

    expect(result.ports).toEqual([]);
    expect(result.labels).toEqual({});
  });

  it('sshHost returns codespace name', () => {
    const provider = new CodespacesProvider();
    expect(provider.sshHost('my-codespace')).toBe('my-codespace');
  });

  it('listProjects returns empty array', async () => {
    const provider = new CodespacesProvider(async () => '');
    const projects = await provider.listProjects();
    expect(projects).toEqual([]);
  });

  it('listMachineClasses returns empty array', async () => {
    const provider = new CodespacesProvider(async () => '');
    const classes = await provider.listMachineClasses();
    expect(classes).toEqual([]);
  });
});
