import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { IpcServer } from '../daemon/ipc-server';
import { DaemonClient } from '../client/daemon-client';
import { DaemonState, ClientMessage } from '../types';

function tmpSocket(): string {
  return path.join(os.tmpdir(), `cloudev-test-${crypto.randomUUID()}.sock`);
}

function makeState(): DaemonState {
  return {
    environments: [
      {
        id: 'env-1',
        provider: 'ona',
        name: 'test-env',
        projectId: 'proj-1',
        projectName: 'Test',
        branch: 'main',
        status: 'running',
        repositoryUrl: 'https://github.com/test/repo.git',
        checkoutLocation: 'repo',
        sshHost: 'env-1.ona.environment',
        workspacePath: '/workspaces/repo',
        webUrl: 'https://app.ona.io/environments/env-1',
      },
    ],
    portForwarding: { activeEnvId: null, activeEnvName: null, ports: [], portLabels: {}, portUrls: {}, status: 'idle' },
    providers: [{ id: 'ona', displayName: 'Ona', available: true }],
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('IPC Integration', () => {
  let socketPath: string;
  let server: IpcServer;
  let client: DaemonClient;

  beforeEach(async () => {
    socketPath = tmpSocket();
    server = new IpcServer(socketPath, 500); // 500ms grace for fast tests
    await server.start();
  });

  afterEach(async () => {
    try { await client?.disconnect(); } catch { /* ignore */ }
    try { await server?.stop(); } catch { /* ignore */ }
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it('client connects to server', async () => {
    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(server.getClientCount()).toBe(1);
  });

  it('server receives messages from client', async () => {
    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();

    const received = new Promise<{ clientId: string; msg: ClientMessage }>((resolve) => {
      server.on('message', (clientId: string, msg: ClientMessage) => {
        resolve({ clientId, msg });
      });
    });

    // Send a ping (client.subscribe sends a 'subscribe' message internally)
    // We need to manually write since subscribe expects a response
    const socket = (client as any).socket;
    socket.write(JSON.stringify({ type: 'ping', requestId: 'test-1' }) + '\n');

    const { msg } = await received;
    expect(msg.type).toBe('ping');
    expect(msg.requestId).toBe('test-1');
  });

  it('subscribe + state-update round-trip', async () => {
    // Wire up server to respond to subscribe with state
    server.on('message', (clientId: string, msg: ClientMessage) => {
      if (msg.type === 'subscribe') {
        server.markSubscribed(clientId);
        server.sendTo(clientId, { type: 'state-update', state: makeState() });
        server.sendTo(clientId, { type: 'response', requestId: msg.requestId, success: true });
      }
    });

    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();

    const statePromise = new Promise<DaemonState>((resolve) => {
      client.on('state-update', resolve);
    });

    await client.subscribe();
    const state = await statePromise;

    expect(state.environments).toHaveLength(1);
    expect(state.environments[0].name).toBe('test-env');
  });

  it('broadcast reaches subscribed client', async () => {
    server.on('message', (clientId: string, msg: ClientMessage) => {
      if (msg.type === 'subscribe') {
        server.markSubscribed(clientId);
        server.sendTo(clientId, { type: 'response', requestId: msg.requestId, success: true });
      }
    });

    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();
    await client.subscribe();

    const statePromise = new Promise<DaemonState>((resolve) => {
      client.on('state-update', resolve);
    });

    server.broadcast({ type: 'state-update', state: makeState() });
    const state = await statePromise;
    expect(state.environments).toHaveLength(1);
  });

  it('request-response correlation with requestId', async () => {
    server.on('message', (clientId: string, msg: ClientMessage) => {
      server.sendTo(clientId, {
        type: 'response',
        requestId: msg.requestId,
        success: true,
        data: 'pong',
      });
    });

    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();

    // Use the internal sendRequest via the public refresh method
    // (refresh sends environments.refresh which will get a response)
    await client.refresh();
    // If this doesn't throw, the response was correctly correlated
  });

  it('server tracks client count', async () => {
    expect(server.getClientCount()).toBe(0);

    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();
    expect(server.getClientCount()).toBe(1);

    const client2 = new DaemonClient({ socketPath, autoSpawn: false });
    await client2.connect();
    expect(server.getClientCount()).toBe(2);

    await client2.disconnect();
    await wait(50); // Let socket close propagate
    expect(server.getClientCount()).toBe(1);
  });

  it('grace period fires after last client disconnects', async () => {
    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();

    const gonePromise = new Promise<void>((resolve) => {
      server.on('all-clients-gone', resolve);
    });

    await client.disconnect();

    // Grace period is 500ms in our test setup
    await gonePromise;
    // If this resolves, the grace period timer fired correctly
  });

  it('handles split/chunked messages (newline framing)', async () => {
    const received: ClientMessage[] = [];
    server.on('message', (_clientId: string, msg: ClientMessage) => {
      received.push(msg);
    });

    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();

    // Manually write two messages as a single chunk (simulating TCP buffering)
    const socket = (client as any).socket;
    const msg1 = JSON.stringify({ type: 'ping', requestId: 'a' });
    const msg2 = JSON.stringify({ type: 'ping', requestId: 'b' });
    socket.write(msg1 + '\n' + msg2 + '\n');

    await wait(100);
    expect(received).toHaveLength(2);
    expect(received[0].requestId).toBe('a');
    expect(received[1].requestId).toBe('b');
  });

  it('handles message split across two chunks', async () => {
    const received: ClientMessage[] = [];
    server.on('message', (_clientId: string, msg: ClientMessage) => {
      received.push(msg);
    });

    client = new DaemonClient({ socketPath, autoSpawn: false });
    await client.connect();

    // Split a single message across two writes
    const fullMsg = JSON.stringify({ type: 'ping', requestId: 'split-test' });
    const socket = (client as any).socket;
    const mid = Math.floor(fullMsg.length / 2);
    socket.write(fullMsg.slice(0, mid));
    await wait(10);
    socket.write(fullMsg.slice(mid) + '\n');

    await wait(100);
    expect(received).toHaveLength(1);
    expect(received[0].requestId).toBe('split-test');
  });
});
