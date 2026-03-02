import * as net from 'net';
import * as http from 'http';

// ---------------------------------------------------------------------------
// TCP Proxy (quick-switch mode — raw TCP pipe, works for all protocols)
// ---------------------------------------------------------------------------

export interface PortProxy {
  port: number;       // user-facing port (e.g., 3000)
  upstream: number;   // hidden tunnel port for active env
  server: net.Server;
  connections: Set<net.Socket>;
  mode: 'tcp';
}

// ---------------------------------------------------------------------------
// HTTP Proxy (side-by-side mode — routes by Host header)
// ---------------------------------------------------------------------------

export interface HttpPortProxy {
  port: number;
  routes: Map<string, number>;  // hostname prefix → hidden tunnel port (e.g., "env-a" → 49001)
  defaultUpstream: number;      // fallback for "localhost" (no prefix) → active env
  server: http.Server;
  connections: Set<net.Socket>;
  mode: 'http';
}

type AnyProxy = PortProxy | HttpPortProxy;

/**
 * Manages per-port proxies that own user-facing ports.
 * Two modes:
 * - TCP (default): raw pipe to single upstream. For quick-switch.
 * - HTTP: routes by Host header to multiple upstreams. For side-by-side.
 */
export class LocalProxyManager {
  private proxies = new Map<number, AnyProxy>();

  // =========================================================================
  // TCP proxy (quick-switch)
  // =========================================================================

  async ensureProxy(port: number, upstream: number): Promise<void> {
    const existing = this.proxies.get(port);
    if (existing) {
      if (existing.mode === 'tcp') {
        if ((existing as PortProxy).upstream !== upstream) {
          this.destroyConnections(port);
          (existing as PortProxy).upstream = upstream;
        }
      }
      // If switching from http → tcp, remove and recreate
      if (existing.mode === 'http') {
        await this.removeProxy(port);
      } else {
        return;
      }
    }

    const proxy: PortProxy = {
      port,
      upstream,
      server: null!,
      connections: new Set(),
      mode: 'tcp',
    };

    const server = net.createServer((clientSocket) => {
      const p = this.proxies.get(port) as PortProxy | undefined;
      if (!p || p.mode !== 'tcp') {
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

    await this.listen(server, port);
  }

  switchUpstream(port: number, newUpstream: number): void {
    const proxy = this.proxies.get(port);
    if (!proxy || proxy.mode !== 'tcp') return;
    const tcp = proxy as PortProxy;
    if (tcp.upstream === newUpstream) return;

    this.destroyConnections(port);
    tcp.upstream = newUpstream;
  }

  // =========================================================================
  // HTTP proxy (side-by-side)
  // =========================================================================

  /**
   * Create or update an HTTP proxy that routes by hostname prefix.
   * e.g., "env-a.localhost:3000" → route "env-a" → upstream 49001
   *        "localhost:3000" → defaultUpstream (active env)
   */
  async ensureHttpProxy(
    port: number,
    routes: Map<string, number>,
    defaultUpstream: number,
  ): Promise<void> {
    const existing = this.proxies.get(port);
    if (existing) {
      if (existing.mode === 'http') {
        // Update routes in place
        const httpProxy = existing as HttpPortProxy;
        httpProxy.routes = routes;
        httpProxy.defaultUpstream = defaultUpstream;
        return;
      }
      // Replace TCP with HTTP
      await this.removeProxy(port);
    }

    const proxy: HttpPortProxy = {
      port,
      routes,
      defaultUpstream,
      server: null!,
      connections: new Set(),
      mode: 'http',
    };

    const server = http.createServer((req, res) => {
      const p = this.proxies.get(port) as HttpPortProxy | undefined;
      if (!p || p.mode !== 'http') {
        res.writeHead(502);
        res.end('Proxy not available');
        return;
      }

      const upstream = this.resolveUpstream(p, req.headers.host);
      if (upstream === undefined) {
        res.writeHead(502);
        res.end('No upstream for this hostname');
        return;
      }

      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: upstream,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      proxyReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Upstream connection failed');
        }
      });

      req.pipe(proxyReq);
    });

    // WebSocket upgrade
    server.on('upgrade', (req, socket, head) => {
      const p = this.proxies.get(port) as HttpPortProxy | undefined;
      if (!p || p.mode !== 'http') {
        socket.destroy();
        return;
      }

      const upstream = this.resolveUpstream(p, req.headers.host);
      if (upstream === undefined) {
        socket.destroy();
        return;
      }

      const upstreamSocket = net.connect(upstream, '127.0.0.1', () => {
        // Reconstruct the HTTP upgrade request to send to upstream
        const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        const headers = Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n');
        upstreamSocket.write(reqLine + headers + '\r\n\r\n');
        if (head.length > 0) upstreamSocket.write(head);

        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });

      const sock = socket as net.Socket;
      p.connections.add(sock);
      sock.on('close', () => p.connections.delete(sock));

      sock.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => sock.destroy());
    });

    // Track connections for cleanup
    server.on('connection', (socket) => {
      proxy.connections.add(socket);
      socket.on('close', () => proxy.connections.delete(socket));
    });

    proxy.server = server;
    this.proxies.set(port, proxy);

    await this.listen(server, port);
  }

  /**
   * Resolve hostname to upstream port.
   * "env-a.localhost:3000" → extract "env-a" → lookup in routes
   * "localhost:3000" → defaultUpstream
   */
  private resolveUpstream(proxy: HttpPortProxy, host: string | undefined): number | undefined {
    if (!host) return proxy.defaultUpstream;

    // Strip port from host header
    const hostname = host.split(':')[0];

    // Check for env prefix: "env-name.localhost" → prefix = "env-name"
    if (hostname.endsWith('.localhost') && hostname !== 'localhost') {
      const prefix = hostname.slice(0, hostname.length - '.localhost'.length);
      return proxy.routes.get(prefix) ?? proxy.defaultUpstream;
    }

    return proxy.defaultUpstream;
  }

  /**
   * Get the route map for an HTTP proxy (for building URLs in the UI).
   */
  getHttpRoutes(port: number): Map<string, number> | undefined {
    const proxy = this.proxies.get(port);
    if (!proxy || proxy.mode !== 'http') return undefined;
    return (proxy as HttpPortProxy).routes;
  }

  // =========================================================================
  // Common operations
  // =========================================================================

  destroyConnections(port: number): void {
    const proxy = this.proxies.get(port);
    if (!proxy) return;

    for (const socket of proxy.connections) {
      socket.destroy();
    }
    proxy.connections.clear();
  }

  async removeProxy(port: number): Promise<void> {
    const proxy = this.proxies.get(port);
    if (!proxy) return;

    this.destroyConnections(port);
    this.proxies.delete(port);

    await new Promise<void>((resolve) => {
      proxy.server.close(() => resolve());
      setTimeout(resolve, 1_000);
    });
  }

  async removeAll(): Promise<void> {
    const ports = [...this.proxies.keys()];
    await Promise.all(ports.map((p) => this.removeProxy(p)));
  }

  getUpstream(port: number): number | undefined {
    const proxy = this.proxies.get(port);
    if (!proxy) return undefined;
    if (proxy.mode === 'tcp') return (proxy as PortProxy).upstream;
    if (proxy.mode === 'http') return (proxy as HttpPortProxy).defaultUpstream;
    return undefined;
  }

  getProxiedPorts(): number[] {
    return [...this.proxies.keys()];
  }

  getMode(port: number): 'tcp' | 'http' | undefined {
    return this.proxies.get(port)?.mode;
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private listen(server: net.Server | http.Server, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }
}
