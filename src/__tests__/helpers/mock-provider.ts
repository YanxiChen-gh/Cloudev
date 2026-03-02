import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Environment, Project, MachineClass } from '../../types';
import { EnvironmentProvider, CreateOpts } from '../../daemon/providers/types';

const MOCK_ENVS: Environment[] = [
  {
    id: 'env-1',
    provider: 'mock',
    name: 'my-app',
    projectId: 'proj-1',
    projectName: 'MyProject',
    branch: 'main',
    status: 'running',
    repositoryUrl: 'https://github.com/test/my-app.git',
    checkoutLocation: 'my-app',
    sshHost: 'env-1.mock.environment',
    workspacePath: '/workspaces/my-app',
    webUrl: 'https://app.mock.io/environments/env-1',
  },
  {
    id: 'env-2',
    provider: 'mock',
    name: 'my-api',
    projectId: 'proj-1',
    projectName: 'MyProject',
    branch: 'feature-x',
    status: 'stopped',
    repositoryUrl: 'https://github.com/test/my-api.git',
    checkoutLocation: 'my-api',
    sshHost: 'env-2.mock.environment',
    workspacePath: '/workspaces/my-api',
    webUrl: 'https://app.mock.io/environments/env-2',
  },
  {
    id: 'env-3',
    provider: 'mock',
    name: 'other-service',
    projectId: 'proj-2',
    projectName: 'OtherProject',
    branch: 'main',
    status: 'running',
    repositoryUrl: 'https://github.com/test/other.git',
    checkoutLocation: 'other-service',
    sshHost: 'env-3.mock.environment',
    workspacePath: '/workspaces/other-service',
    webUrl: 'https://app.mock.io/environments/env-3',
  },
];

const MOCK_PROJECTS: Project[] = [
  { id: 'proj-1', name: 'MyProject', repositoryUrl: 'https://github.com/test/my-app.git' },
  { id: 'proj-2', name: 'OtherProject', repositoryUrl: 'https://github.com/test/other.git' },
];

export class MockProvider implements EnvironmentProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock';

  // Override these in individual tests
  environments = [...MOCK_ENVS];
  projects = [...MOCK_PROJECTS];
  available = true;
  ports = [3000, 8080];

  // Track calls for assertions
  calls: { method: string; args: unknown[] }[] = [];

  async checkAvailability() {
    return { available: this.available };
  }

  async listEnvironments(): Promise<Environment[]> {
    this.calls.push({ method: 'listEnvironments', args: [] });
    return this.environments;
  }

  async start(envId: string): Promise<void> {
    this.calls.push({ method: 'start', args: [envId] });
  }

  async stop(envId: string): Promise<void> {
    this.calls.push({ method: 'stop', args: [envId] });
  }

  async restart(envId: string): Promise<void> {
    this.calls.push({ method: 'restart', args: [envId] });
  }

  async create(opts: CreateOpts): Promise<string> {
    this.calls.push({ method: 'create', args: [opts] });
    return 'new-env-id';
  }

  async delete(envId: string): Promise<void> {
    this.calls.push({ method: 'delete', args: [envId] });
  }

  async discoverPorts(_envId: string): Promise<{ ports: number[]; labels: Record<number, string> }> {
    return { ports: this.ports, labels: {} };
  }

  spawnTunnel(_envId: string, _ports: number[]): ChildProcess {
    // Return a fake ChildProcess-like EventEmitter that emits 'exit' on kill
    const fake = new EventEmitter() as ChildProcess;
    fake.kill = () => {
      process.nextTick(() => fake.emit('exit', 0, null));
      return true;
    };
    fake.pid = 99999;
    return fake;
  }

  sshHost(envId: string): string {
    return `${envId}.mock.environment`;
  }

  async syncSshConfig(): Promise<void> {
    // no-op
  }

  async listProjects(): Promise<Project[]> {
    return this.projects;
  }

  async listMachineClasses(): Promise<MachineClass[]> {
    return [];
  }

  // Remote command execution
  execRemoteResults: Record<string, string> = {};

  async execRemoteCommand(envId: string, command: string): Promise<string> {
    this.calls.push({ method: 'execRemoteCommand', args: [envId, command] });
    return this.execRemoteResults[command] ?? '';
  }
}

export { MOCK_ENVS, MOCK_PROJECTS };
