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
  sshHost: string;       // provider-computed SSH host for manual SSH / copy
  workspacePath: string; // provider-computed remote workspace path
  webUrl: string;        // provider web dashboard URL
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

export interface SideBySideEnv {
  envId: string;
  envName: string;
  hostname: string;  // e.g., "env-a" → user accesses env-a.localhost:3000
}

export interface PortForwardingState {
  activeEnvId: string | null;
  activeEnvName: string | null;
  ports: number[];
  portLabels: Record<number, string>; // port → label (container name or static guess)
  portUrls: Record<number, string>;   // port → public URL (gitpod URL or codespaces browseUrl)
  portConflicts: Record<number, string>; // port → conflict reason (empty if all bound)
  status: 'idle' | 'connecting' | 'active' | 'error';
  error?: string;
  // Side-by-side mode
  sideBySide: SideBySideEnv[];  // empty = quick-switch mode, non-empty = side-by-side active
}

export interface ProviderStatus {
  id: string;
  displayName: string;
  available: boolean;
  error?: string;
}

export interface ShellHistoryState {
  entryCount: number;
  lastSyncTime: number | null;
  status: 'idle' | 'syncing' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// Daemon State — composable snapshot from all services
// ---------------------------------------------------------------------------

export interface DaemonState {
  environments: Environment[];
  portForwarding: PortForwardingState;
  shellHistory: ShellHistoryState;
  providers: ProviderStatus[];
}

// ---------------------------------------------------------------------------
// IPC Protocol — Client → Daemon messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  // Core
  | { type: 'subscribe'; requestId: string; version?: string }
  | { type: 'ping'; requestId: string }
  // Environments service
  | { type: 'environments.list'; requestId: string }
  | { type: 'environments.start'; requestId: string; envId: string }
  | { type: 'environments.stop'; requestId: string; envId: string }
  | { type: 'environments.create'; requestId: string; projectId: string; machineClassId?: string; providerId?: string; branch?: string }
  | { type: 'environments.delete'; requestId: string; envId: string }
  | { type: 'environments.restart'; requestId: string; envId: string }
  | { type: 'environments.refresh'; requestId: string }
  | { type: 'environments.listProjects'; requestId: string; providerId: string }
  | { type: 'environments.listMachineClasses'; requestId: string; providerId: string; repo?: string }
  // Port-forwarding service
  | { type: 'port-forwarding.start'; requestId: string; envId: string }
  | { type: 'port-forwarding.stop'; requestId: string }
  | { type: 'port-forwarding.side-by-side'; requestId: string; envIds: string[] }
  | { type: 'port-forwarding.stop-side-by-side'; requestId: string }
  | { type: 'port-forwarding.add-compare'; requestId: string; envId: string }
  | { type: 'port-forwarding.remove-compare'; requestId: string; envId: string }
  // Shell history sync service
  | { type: 'history.collect'; requestId: string; envId?: string }
  | { type: 'history.clear'; requestId: string }
  | { type: 'history.configure'; requestId: string; periodicSyncMinutes: number }
  // Configuration
  | { type: 'configure.binaries'; requestId: string; overrides: { gitpod?: string; gh?: string; ssh?: string; lsof?: string } };

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
