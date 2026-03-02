import { ChildProcess } from 'child_process';
import { Environment, Project, MachineClass } from '../../types';

export interface CreateOpts {
  projectId: string;
  machineClassId?: string;
  branch?: string;
}

export interface PortMapping {
  remote: number;  // port on the remote environment
  local: number;   // hidden local port for the SSH tunnel
}

export interface EnvironmentProvider {
  readonly id: string;
  readonly displayName: string;

  /** Check if the provider's CLI is installed and the user is logged in */
  checkAvailability(): Promise<{ available: boolean; error?: string }>;

  // Lifecycle
  listEnvironments(): Promise<Environment[]>;
  start(envId: string): Promise<void>;
  stop(envId: string): Promise<void>;
  restart(envId: string): Promise<void>;
  create(opts: CreateOpts): Promise<string>; // returns new env ID
  delete(envId: string): Promise<void>;

  // Port forwarding support
  discoverPorts(envId: string): Promise<{ ports: number[]; labels: Record<number, string>; urls?: Record<number, string> }>;
  spawnTunnel(envId: string, portMappings: PortMapping[]): ChildProcess;

  // SSH
  sshHost(envId: string): string;
  syncSshConfig(): Promise<void>;

  // Remote command execution
  execRemoteCommand?(envId: string, command: string): Promise<string>;

  // Metadata
  listProjects(): Promise<Project[]>;
  listMachineClasses?(repo?: string): Promise<MachineClass[]>;
}
