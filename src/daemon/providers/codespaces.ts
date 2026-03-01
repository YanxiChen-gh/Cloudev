import { ChildProcess } from 'child_process';
import { Environment, Project, MachineClass } from '../../types';
import { EnvironmentProvider, CreateOpts } from './types';

export class CodespacesProvider implements EnvironmentProvider {
  readonly id = 'codespaces';
  readonly displayName = 'GitHub Codespaces';

  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    return { available: false, error: 'Codespaces provider not yet implemented' };
  }

  async listEnvironments(): Promise<Environment[]> {
    throw new Error('Codespaces provider not yet implemented');
  }

  async start(_envId: string): Promise<void> {
    throw new Error('Codespaces provider not yet implemented');
  }

  async stop(_envId: string): Promise<void> {
    throw new Error('Codespaces provider not yet implemented');
  }

  async restart(_envId: string): Promise<void> {
    throw new Error('Codespaces provider not yet implemented');
  }

  async create(_opts: CreateOpts): Promise<string> {
    throw new Error('Codespaces provider not yet implemented');
  }

  async delete(_envId: string): Promise<void> {
    throw new Error('Codespaces provider not yet implemented');
  }

  async discoverPorts(_envId: string): Promise<{ ports: number[]; labels: Record<number, string> }> {
    throw new Error('Codespaces provider not yet implemented');
  }

  spawnTunnel(_envId: string, _ports: number[]): ChildProcess {
    throw new Error('Codespaces provider not yet implemented');
  }

  sshHost(_envId: string): string {
    throw new Error('Codespaces provider not yet implemented');
  }

  async syncSshConfig(): Promise<void> {
    // No-op for stub
  }

  async listProjects(): Promise<Project[]> {
    throw new Error('Codespaces provider not yet implemented');
  }

  async listMachineClasses(): Promise<MachineClass[]> {
    throw new Error('Codespaces provider not yet implemented');
  }
}
