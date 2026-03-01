/**
 * Daemon entry point — spawned as a detached child process by the extension.
 * Run via: node out/daemon/index.js
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { IpcServer } from './ipc-server';
import { DaemonService, ServiceContext } from './service';
import { EnvironmentsService } from './services/environments';
import { PortForwardingService } from './services/port-forwarding';
import { OnaProvider } from './providers/ona';
import { CodespacesProvider } from './providers/codespaces';
import { ClientMessage, DaemonState } from '../types';

const SOCKET_DIR = path.join(os.homedir(), '.vanta-dev');
const SOCKET_PATH = path.join(SOCKET_DIR, 'daemon.sock');
const PID_PATH = path.join(SOCKET_DIR, 'daemon.pid');
const LOG_PATH = path.join(SOCKET_DIR, 'daemon.log');

async function main(): Promise<void> {
  // 1. Ensure state directory exists
  fs.mkdirSync(SOCKET_DIR, { recursive: true });

  // 2. Setup logging — redirect stdout/stderr to log file since daemon is detached
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  const originalLog = console.log;
  const originalError = console.error;
  const timestamp = () => new Date().toISOString();
  console.log = (...args: unknown[]) => {
    logStream.write(`[${timestamp()}] [INFO] ${args.join(' ')}\n`);
    originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    logStream.write(`[${timestamp()}] [ERROR] ${args.join(' ')}\n`);
    originalError(...args);
  };

  // 3. Write PID file
  fs.writeFileSync(PID_PATH, String(process.pid));
  console.log(`Daemon starting (pid=${process.pid})`);

  // 4. Initialize providers
  const providers = [new OnaProvider(), new CodespacesProvider()];

  // 5. Create IPC server
  const ipcServer = new IpcServer(SOCKET_PATH);

  // 6. Create service context — services use this to broadcast and look up cross-cutting data
  let services: DaemonService[] = [];

  const serviceContext: ServiceContext = {
    broadcast() {
      const state = buildState();
      // Notify services of state change (e.g., port-forwarding reacts to env disappearing)
      for (const svc of services) {
        svc.onStateChanged?.(state);
      }
      ipcServer.broadcast({ type: 'state-update', state });
    },
    getProvider(envId: string) {
      return environmentsService.getProvider(envId);
    },
    getEnvironments() {
      return environmentsService.getEnvironmentList();
    },
  };

  // 7. Create services
  const environmentsService = new EnvironmentsService(providers, serviceContext);
  const portForwardingService = new PortForwardingService(serviceContext);
  services = [environmentsService, portForwardingService];

  // 8. Wire up IPC message routing
  ipcServer.on('message', async (clientId: string, msg: ClientMessage) => {
    try {
      switch (msg.type) {
        // Core messages handled directly by daemon
        case 'subscribe': {
          ipcServer.markSubscribed(clientId);
          const state = buildState();
          ipcServer.sendTo(clientId, { type: 'state-update', state });
          ipcServer.sendTo(clientId, {
            type: 'response',
            requestId: msg.requestId,
            success: true,
          });
          return;
        }
        case 'ping': {
          ipcServer.sendTo(clientId, {
            type: 'response',
            requestId: msg.requestId,
            success: true,
          });
          return;
        }
      }

      // Route to appropriate service
      const service = services.find((s) => s.handles(msg.type));
      if (!service) {
        ipcServer.sendTo(clientId, {
          type: 'response',
          requestId: msg.requestId,
          success: false,
          error: `No service handles message type: ${msg.type}`,
        });
        return;
      }

      const data = await service.handleMessage(msg);
      ipcServer.sendTo(clientId, {
        type: 'response',
        requestId: msg.requestId,
        success: true,
        data,
      });
    } catch (err) {
      console.error(`Error handling ${msg.type}:`, (err as Error).message);
      ipcServer.sendTo(clientId, {
        type: 'response',
        requestId: msg.requestId,
        success: false,
        error: (err as Error).message,
      });
    }
  });

  // 9. Graceful shutdown
  ipcServer.on('all-clients-gone', () => {
    console.log('All clients disconnected — shutting down');
    shutdown();
  });

  process.on('SIGTERM', () => {
    console.log('Received SIGTERM');
    shutdown();
  });
  process.on('SIGINT', () => {
    console.log('Received SIGINT');
    shutdown();
  });

  async function shutdown(): Promise<void> {
    console.log('Daemon shutting down...');
    for (const svc of services) {
      try {
        await svc.stop();
      } catch (err) {
        console.error(`Error stopping service ${svc.id}:`, (err as Error).message);
      }
    }
    await ipcServer.stop();
    try {
      fs.unlinkSync(PID_PATH);
    } catch {
      // Already gone
    }
    logStream.end();
    process.exit(0);
  }

  function buildState(): DaemonState {
    const merged: DaemonState = {
      environments: [],
      portForwarding: { activeEnvId: null, activeEnvName: null, ports: [], portLabels: {}, portUrls: {}, status: 'idle' },
      providers: [],
    };
    for (const svc of services) {
      Object.assign(merged, svc.getState());
    }
    return merged;
  }

  // 10. Start everything
  await ipcServer.start();
  console.log(`IPC server listening on ${SOCKET_PATH}`);

  for (const svc of services) {
    await svc.start();
    console.log(`Service '${svc.id}' started`);
  }

  console.log('Daemon ready');
}

main().catch((err) => {
  console.error('Daemon failed to start:', err);
  process.exit(1);
});
