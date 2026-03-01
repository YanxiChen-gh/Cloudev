import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { ClientMessage, DaemonMessage } from '../types';

interface ClientConnection {
  id: string;
  socket: net.Socket;
  subscribed: boolean;
  buffer: string;
}

export class IpcServer extends EventEmitter {
  private server: net.Server | null = null;
  private clients = new Map<string, ClientConnection>();
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly gracePeriodMs: number = 10_000,
  ) {
    super();
  }

  async start(): Promise<void> {
    // Ensure parent directory exists
    const dir = path.dirname(this.socketPath);
    fs.mkdirSync(dir, { recursive: true });

    // Check for stale socket: try connecting — if it works, another daemon is alive
    const isAlive = await this.isExistingDaemonAlive();
    if (isAlive) {
      throw new Error('Another daemon is already running');
    }

    // Remove stale socket file if present
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // File didn't exist — fine
    }

    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    // Close all client sockets
    for (const client of this.clients.values()) {
      client.socket.destroy();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Remove socket file
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Already gone
    }
  }

  broadcast(message: DaemonMessage): void {
    const line = JSON.stringify(message) + '\n';
    for (const client of this.clients.values()) {
      if (client.subscribed) {
        try {
          client.socket.write(line);
        } catch {
          // Client disconnected — will be cleaned up by 'close' handler
        }
      }
    }
  }

  sendTo(clientId: string, message: DaemonMessage): void {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        client.socket.write(JSON.stringify(message) + '\n');
      } catch {
        // Client disconnected
      }
    }
  }

  markSubscribed(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.subscribed = true;
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  // --- Private ---

  private isExistingDaemonAlive(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!fs.existsSync(this.socketPath)) {
        resolve(false);
        return;
      }

      const socket = net.connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1_000);

      socket.on('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    const clientId = crypto.randomUUID();
    const client: ClientConnection = {
      id: clientId,
      socket,
      subscribed: false,
      buffer: '',
    };
    this.clients.set(clientId, client);

    // Cancel any pending shutdown timer
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    socket.on('data', (chunk) => this.handleData(client, chunk));
    socket.on('close', () => this.handleDisconnect(client));
    socket.on('error', () => {
      // Will be followed by 'close'
    });
  }

  private handleData(client: ClientConnection, chunk: Buffer): void {
    // Newline-delimited JSON framing
    client.buffer += chunk.toString('utf-8');
    const lines = client.buffer.split('\n');
    client.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const msg: ClientMessage = JSON.parse(line);
        this.emit('message', client.id, msg);
      } catch {
        // Invalid JSON — ignore
      }
    }
  }

  private handleDisconnect(client: ClientConnection): void {
    this.clients.delete(client.id);
    this.emit('client-disconnected', client.id);

    // Start grace period shutdown if no clients remain
    if (this.clients.size === 0) {
      this.shutdownTimer = setTimeout(() => {
        this.emit('all-clients-gone');
      }, this.gracePeriodMs);
    }
  }
}
