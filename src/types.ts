// ---------------------------------------------------------------------------
// Domain Models
// ---------------------------------------------------------------------------

export type EnvironmentStatus =
  | 'running'
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'creating'
  | 'unknown';

export interface Environment {
  id: string;
  provider: string; // 'ona' | 'codespaces'
  name: string;
  projectId: string;
  projectName: string;
  branch: string;
  status: EnvironmentStatus;
  repositoryUrl: string;
  checkoutLocation: string;
}

export interface Project {
  id: string;
  name: string;
  repositoryUrl: string;
}

export interface MachineClass {
  id: string;
  name: string;
  description: string;
  cpus: number;
  memoryGb: number;
}

export interface PortForwardingState {
  activeEnvId: string | null;
  activeEnvName: string | null;
  ports: number[];
  portLabels: Record<number, string>; // port → label (container name or static guess)
  status: 'idle' | 'connecting' | 'active' | 'error';
  error?: string;
}

export interface ProviderStatus {
  id: string;
  displayName: string;
  available: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Daemon State — composable snapshot from all services
// ---------------------------------------------------------------------------

export interface DaemonState {
  environments: Environment[];
  portForwarding: PortForwardingState;
  providers: ProviderStatus[];
}

// ---------------------------------------------------------------------------
// IPC Protocol — Client → Daemon messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  // Core
  | { type: 'subscribe'; requestId: string }
  | { type: 'ping'; requestId: string }
  // Environments service
  | { type: 'environments.list'; requestId: string }
  | { type: 'environments.start'; requestId: string; envId: string }
  | { type: 'environments.stop'; requestId: string; envId: string }
  | { type: 'environments.create'; requestId: string; projectId: string; machineClassId?: string }
  | { type: 'environments.delete'; requestId: string; envId: string }
  | { type: 'environments.restart'; requestId: string; envId: string }
  | { type: 'environments.refresh'; requestId: string }
  // Port-forwarding service
  | { type: 'port-forwarding.start'; requestId: string; envId: string }
  | { type: 'port-forwarding.stop'; requestId: string };

// ---------------------------------------------------------------------------
// IPC Protocol — Daemon → Client messages
// ---------------------------------------------------------------------------

export type DaemonMessage =
  | { type: 'state-update'; state: DaemonState }
  | { type: 'response'; requestId: string; success: boolean; error?: string; data?: unknown }
  | { type: 'event'; event: DaemonEvent };

export type DaemonEvent =
  | { kind: 'environment-changed'; environment: Environment }
  | { kind: 'environment-removed'; envId: string }
  | { kind: 'port-forwarding-changed'; portForwarding: PortForwardingState }
  | { kind: 'provider-status-changed'; provider: ProviderStatus }
  | { kind: 'error'; message: string };
