import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { LocalProxyManager } from '../local-proxy';

// Each test gets unique ports to avoid inter-test conflicts
let portCounter = 48100;
function nextPort(): number { return portCounter++; }

function startEchoServer(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(`echo:${data.toString()}`);
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

function sendAndReceive(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(message);
    });
    client.on('data', (data) => {
      client.destroy();
      resolve(data.toString());
    });
    client.on('error', reject);
    setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 2000);
  });
}

describe('LocalProxyManager', () => {
  const managers: LocalProxyManager[] = [];
  const servers: net.Server[] = [];

  afterEach(async () => {
    for (const m of managers) await m.removeAll();
    managers.length = 0;
    for (const s of servers) await closeServer(s);
    servers.length = 0;
  });

  it('proxies TCP traffic to upstream', async () => {
    const proxyPort = nextPort();
    const upstreamPort = nextPort();

    const manager = new LocalProxyManager();
    managers.push(manager);
    const upstream = await startEchoServer(upstreamPort);
    servers.push(upstream);

    await manager.ensureProxy(proxyPort, upstreamPort);

    const response = await sendAndReceive(proxyPort, 'hello');
    expect(response).toBe('echo:hello');
  });

  it('switchUpstream changes routing without rebind', async () => {
    const proxyPort = nextPort();
    const up1 = nextPort();
    const up2 = nextPort();

    const manager = new LocalProxyManager();
    managers.push(manager);
    const s1 = await startEchoServer(up1);
    servers.push(s1);
    const s2 = await startEchoServer(up2);
    servers.push(s2);

    await manager.ensureProxy(proxyPort, up1);
    expect(manager.getUpstream(proxyPort)).toBe(up1);

    manager.switchUpstream(proxyPort, up2);
    expect(manager.getUpstream(proxyPort)).toBe(up2);

    // New connections go to up2
    const response = await sendAndReceive(proxyPort, 'test');
    expect(response).toBe('echo:test');
  });

  it('destroyConnections kills active sockets', async () => {
    const proxyPort = nextPort();
    const upstreamPort = nextPort();

    const manager = new LocalProxyManager();
    managers.push(manager);
    const upstream = await startEchoServer(upstreamPort);
    servers.push(upstream);

    await manager.ensureProxy(proxyPort, upstreamPort);

    const client = net.connect(proxyPort, '127.0.0.1');
    await new Promise<void>((resolve) => client.on('connect', resolve));

    const closed = new Promise<void>((resolve) => {
      client.on('close', resolve);
      setTimeout(resolve, 2000); // safety
    });

    manager.destroyConnections(proxyPort);
    await closed;
  });

  it('removeProxy releases the port', async () => {
    const proxyPort = nextPort();
    const upstreamPort = nextPort();

    const manager = new LocalProxyManager();
    managers.push(manager);
    const upstream = await startEchoServer(upstreamPort);
    servers.push(upstream);

    await manager.ensureProxy(proxyPort, upstreamPort);
    expect(manager.getProxiedPorts()).toContain(proxyPort);

    await manager.removeProxy(proxyPort);
    expect(manager.getProxiedPorts()).not.toContain(proxyPort);
  });

  it('removeAll cleans up everything', async () => {
    const p1 = nextPort();
    const p2 = nextPort();
    const up = nextPort();

    const manager = new LocalProxyManager();
    managers.push(manager);
    const upstream = await startEchoServer(up);
    servers.push(upstream);

    await manager.ensureProxy(p1, up);
    await manager.ensureProxy(p2, up);
    expect(manager.getProxiedPorts().length).toBe(2);

    await manager.removeAll();
    expect(manager.getProxiedPorts().length).toBe(0);
  });

  it('ensureProxy with same upstream is no-op', async () => {
    const proxyPort = nextPort();
    const upstreamPort = nextPort();

    const manager = new LocalProxyManager();
    managers.push(manager);
    const upstream = await startEchoServer(upstreamPort);
    servers.push(upstream);

    await manager.ensureProxy(proxyPort, upstreamPort);
    await manager.ensureProxy(proxyPort, upstreamPort); // no-op

    const response = await sendAndReceive(proxyPort, 'hello');
    expect(response).toBe('echo:hello');
  });

  it('ensureProxy with different upstream updates routing', async () => {
    const proxyPort = nextPort();
    const up1 = nextPort();
    const up2 = nextPort();

    const manager = new LocalProxyManager();
    managers.push(manager);

    const s1 = await startEchoServer(up1);
    servers.push(s1);
    const s2 = await startEchoServer(up2);
    servers.push(s2);

    await manager.ensureProxy(proxyPort, up1);
    expect(manager.getUpstream(proxyPort)).toBe(up1);

    await manager.ensureProxy(proxyPort, up2);
    expect(manager.getUpstream(proxyPort)).toBe(up2);
  });
});
