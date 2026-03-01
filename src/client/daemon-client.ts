import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { ClientMessage, DaemonMessage, DaemonState, DaemonEvent } from '../types';

const DEFAULT_SOCKET_DIR = path.join(os.homedir(), '.cloudev');
const DEFAULT_SOCKET_PATH = path.join(DEFAULT_SOCKET_DIR, 'daemon.sock');
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 2_000;
const SPAWN_RETRY_COUNT = 20;
const SPAWN_RETRY_DELAY_MS = 250;

export interface DaemonClientOptions {
  socketPath?: string;
  autoSpawn?: boolean;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class DaemonClient extends EventEmitter {
  private readonly socketPath: string;
  private readonly autoSpawn: boolean;
  private socket: net.Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<string, PendingRequest>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private _connected = false;

  constructor(opts?: DaemonClientOptions) {
    super();
    this.socketPath = opts?.socketPath ?? DEFAULT_SOCKET_PATH;
    this.autoSpawn = opts?.autoSpawn ?? true;
  }

  async connect(): Promise<void> {
    // Reset disposed flag so reconnection works after a manual disconnect+reconnect
    this.disposed = false;

    // 1. Try connecting to existing daemon
    try {
      await this.tryConnect();
      return;
    } catch {
      // No daemon running
    }

    // 2. Spawn daemon (if auto-spawn enabled)
    if (!this.autoSpawn) {
      throw new Error('No daemon running and auto-spawn is disabled');
    }
    this.spawnDaemon();

    // 3. Wait for daemon to be ready
    await this.waitForDaemon();
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
    // Reject all pending requests
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('Client disconnected'));
    }
    this.pendingRequests.clear();
  }

  isConnected(): boolean {
    return this._connected;
  }

  // ---------------------------------------------------------------------------
  // Typed API methods
  // ---------------------------------------------------------------------------

  async subscribe(): Promise<void> {
    await this.sendRequest({ type: 'subscribe', requestId: '' });
  }

  async startEnvironment(envId: string): Promise<void> {
    await this.sendRequest({ type: 'environments.start', requestId: '', envId });
  }

  async stopEnvironment(envId: string): Promise<void> {
    await this.sendRequest({ type: 'environments.stop', requestId: '', envId });
  }

  async createEnvironment(
    projectId: string,
    opts?: { machineClassId?: string; providerId?: string; branch?: string },
  ): Promise<string> {
    const result = await this.sendRequest({
      type: 'environments.create',
      requestId: '',
      projectId,
      machineClassId: opts?.machineClassId,
      providerId: opts?.providerId,
      branch: opts?.branch,
    });
    return result as string;
  }

  async deleteEnvironment(envId: string): Promise<void> {
    await this.sendRequest({ type: 'environments.delete', requestId: '', envId });
  }

  async restartEnvironment(envId: string): Promise<void> {
    await this.sendRequest({ type: 'environments.restart', requestId: '', envId });
  }

  async startPortForwarding(envId: string): Promise<void> {
    await this.sendRequest({ type: 'port-forwarding.start', requestId: '', envId });
  }

  async stopPortForwarding(): Promise<void> {
    await this.sendRequest({ type: 'port-forwarding.stop', requestId: '' });
  }

  async refresh(): Promise<void> {
    await this.sendRequest({ type: 'environments.refresh', requestId: '' });
  }

  async listProjects(providerId: string): Promise<unknown[]> {
    const result = await this.sendRequest({
      type: 'environments.listProjects',
      requestId: '',
      providerId,
    });
    return result as unknown[];
  }

  async listMachineClasses(providerId: string, repo?: string): Promise<unknown[]> {
    const result = await this.sendRequest({
      type: 'environments.listMachineClasses',
      requestId: '',
      providerId,
      repo,
    });
    return result as unknown[];
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private sendRequest(msg: ClientMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this._connected) {
        reject(new Error('Not connected to daemon'));
        return;
      }

      const requestId = crypto.randomUUID();
      (msg as { requestId: string }).requestId = requestId;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timed out: ${msg.type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.socket.write(JSON.stringify(msg) + '\n');
    });
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 2_000);

      socket.on('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this._connected = true;
        this.buffer = '';
        this.setupSocketHandlers();
        this.emit('connected');
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private spawnDaemon(): void {
    const socketDir = path.dirname(this.socketPath);
    fs.mkdirSync(socketDir, { recursive: true });

    // Path to daemon entry point relative to compiled output
    const daemonScript = path.join(__dirname, '..', 'daemon', 'index.js');

    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  }

  private async waitForDaemon(): Promise<void> {
    for (let i = 0; i < SPAWN_RETRY_COUNT; i++) {
      try {
        await this.tryConnect();
        return;
      } catch {
        await new Promise<void>((r) => setTimeout(r, SPAWN_RETRY_DELAY_MS));
      }
    }
    throw new Error('Failed to connect to daemon after spawning');
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const msg: DaemonMessage = JSON.parse(line);
          this.handleMessage(msg);
        } catch {
          // Invalid JSON — ignore
        }
      }
    });

    this.socket.on('close', () => {
      this._connected = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.socket.on('error', () => {
      // Handled by 'close'
    });
  }

  private handleMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case 'response': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.requestId);
          if (msg.success) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.error ?? 'Unknown error'));
          }
        }
        break;
      }
      case 'state-update':
        this.emit('state-update', msg.state as DaemonState);
        break;
      case 'event':
        this.emit('event', msg.event as DaemonEvent);
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        await this.subscribe();
        this.emit('reconnected');
      } catch {
        this.scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }
}
