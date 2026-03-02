import * as net from 'net';

export interface PortProxy {
  port: number;       // user-facing port (e.g., 3000)
  upstream: number;   // hidden tunnel port (e.g., 49001)
  server: net.Server;
  connections: Set<net.Socket>;
}

/**
 * Manages per-port TCP proxies that own user-facing ports.
 * SSH tunnels bind to hidden high ports; the proxy pipes traffic through.
 * Switching envs = changing upstream pointer, no rebind.
 */
export class LocalProxyManager {
  private proxies = new Map<number, PortProxy>();

  /**
   * Ensure a proxy is listening on `port`, routing to `upstream`.
   * Creates the proxy if it doesn't exist; updates upstream if it does.
   */
  async ensureProxy(port: number, upstream: number): Promise<void> {
    const existing = this.proxies.get(port);
    if (existing) {
      if (existing.upstream !== upstream) {
        this.destroyConnections(port);
        existing.upstream = upstream;
      }
      return;
    }

    const proxy: PortProxy = {
      port,
      upstream,
      server: null!,
      connections: new Set(),
    };

    const server = net.createServer((clientSocket) => {
      const p = this.proxies.get(port);
      if (!p) {
        clientSocket.destroy();
        return;
      }

      const upstreamSocket = net.connect(p.upstream, '127.0.0.1');

      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);

      p.connections.add(clientSocket);
      clientSocket.on('close', () => p.connections.delete(clientSocket));

      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => clientSocket.destroy());
    });

    proxy.server = server;
    this.proxies.set(port, proxy);

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * Switch upstream for an existing proxy. Kills all current connections
   * to prevent data from the old env leaking to existing clients.
   */
  switchUpstream(port: number, newUpstream: number): void {
    const proxy = this.proxies.get(port);
    if (!proxy) return;
    if (proxy.upstream === newUpstream) return;

    this.destroyConnections(port);
    proxy.upstream = newUpstream;
  }

  /**
   * Forcefully close all active connections on a port.
   * Must be called before switching upstream to prevent silent data corruption.
   */
  destroyConnections(port: number): void {
    const proxy = this.proxies.get(port);
    if (!proxy) return;

    for (const socket of proxy.connections) {
      socket.destroy();
    }
    proxy.connections.clear();
  }

  /**
   * Tear down the proxy for a port — close server + all connections.
   */
  async removeProxy(port: number): Promise<void> {
    const proxy = this.proxies.get(port);
    if (!proxy) return;

    this.destroyConnections(port);
    this.proxies.delete(port);

    await new Promise<void>((resolve) => {
      // Force close — destroy any remaining connections the server is tracking
      proxy.server.close(() => resolve());
      // Safety timeout in case close hangs
      setTimeout(resolve, 1_000);
    });
  }

  /**
   * Remove all proxies.
   */
  async removeAll(): Promise<void> {
    const ports = [...this.proxies.keys()];
    await Promise.all(ports.map((p) => this.removeProxy(p)));
  }

  /**
   * Get the current upstream port for a proxy (for debugging/state).
   */
  getUpstream(port: number): number | undefined {
    return this.proxies.get(port)?.upstream;
  }

  /**
   * Get all proxied ports.
   */
  getProxiedPorts(): number[] {
    return [...this.proxies.keys()];
  }
}
