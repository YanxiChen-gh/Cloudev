import { ClientMessage, DaemonState, Environment } from '../types';
import { EnvironmentProvider } from './providers/types';

/**
 * Context passed to services so they can interact with the daemon
 * without tight coupling to each other.
 */
export interface ServiceContext {
  /** Broadcast a full state-update to all subscribed clients */
  broadcast(): void;
  /** Look up the provider that owns a given environment */
  getProvider(envId: string): EnvironmentProvider | undefined;
  /** Get the current canonical environment list (owned by environments service) */
  getEnvironments(): Environment[];
}

/**
 * A self-contained daemon feature. Each service owns a slice of state,
 * handles a set of IPC messages, and can react to state changes from
 * other services.
 */
export interface DaemonService {
  readonly id: string;

  /** Return true if this service handles the given IPC message type */
  handles(msgType: string): boolean;

  /** Handle an IPC message and return response data (or throw) */
  handleMessage(msg: ClientMessage): Promise<unknown>;

  /** Return this service's state slice (merged into DaemonState on broadcast) */
  getState(): Partial<DaemonState>;

  /** Optional: react when the full daemon state changes (e.g., forwarded env was stopped) */
  onStateChanged?(fullState: DaemonState): void;

  start(): Promise<void>;
  stop(): Promise<void>;
}
