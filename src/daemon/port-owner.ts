/**
 * Identifies the local process that owns a given port.
 * Uses a chain of enrichers to add context (docker container name, SSH target, etc.).
 */

import { execFile } from 'child_process';

const EXEC_TIMEOUT = 2_000;
const LSOF_BIN = '/usr/sbin/lsof';

export interface PortOwnerInfo {
  command: string;
  pid: string;
}

/** An enricher takes basic owner info and optionally returns a richer description. */
export type PortOwnerEnricher = (owner: PortOwnerInfo, port: number) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Built-in enrichers
// ---------------------------------------------------------------------------

/** Enriches docker-related processes with the container name. */
export const dockerEnricher: PortOwnerEnricher = async (owner, port) => {
  const cmd = owner.command.toLowerCase();
  if (!cmd.includes('docker') && !cmd.includes('vpnkit') && !cmd.includes('com.docker')) {
    return null;
  }
  const name = await exec('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']);
  return name ? `docker: ${name}` : null;
};

/** Enriches SSH processes with the remote host target. */
export const sshEnricher: PortOwnerEnricher = async (owner) => {
  if (owner.command.toLowerCase() !== 'ssh') return null;
  const args = await exec('ps', ['-p', owner.pid, '-o', 'args=']);
  if (!args) return null;
  const host = parseSshHost(args);
  return host ? `ssh tunnel to ${host}` : null;
};

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

const defaultEnrichers: PortOwnerEnricher[] = [dockerEnricher, sshEnricher];

/**
 * Get a human-readable description of what's using a local port.
 * Runs enrichers in order; first match wins.
 */
export async function getPortOwnerDescription(
  port: number,
  enrichers: PortOwnerEnricher[] = defaultEnrichers,
): Promise<string | null> {
  const owners = await getPortOwners(port);
  const owner = owners[0];
  if (!owner) return null;

  for (const enricher of enrichers) {
    try {
      const description = await enricher(owner, port);
      if (description) return description;
    } catch {
      // Enricher failed — continue to next
    }
  }

  // Fallback: raw process info
  return `${owner.command} (PID ${owner.pid})`;
}

/**
 * Classify who owns a port relative to our tunnel.
 * Returns: 'ours' | 'stale:{description}' | 'other:{description}' | 'none'
 */
export async function classifyPortOwner(
  port: number,
  ourPid: number | undefined,
  enrichers: PortOwnerEnricher[] = defaultEnrichers,
): Promise<{ status: 'ours' | 'stale' | 'other' | 'none'; description: string }> {
  const owners = await getPortOwners(port);
  if (owners.length === 0) {
    return { status: 'none', description: 'Not bound' };
  }

  // Find the first owner that ISN'T our tunnel process.
  // SSH may bind IPv6 (::1) when IPv4 (127.0.0.1) is taken by another process,
  // so we need to look at all listeners, not just the first.
  const conflict = owners.find((o) => !ourPid || o.pid !== String(ourPid));
  if (!conflict) {
    // All listeners are our tunnel — no conflict
    return { status: 'ours', description: '' };
  }

  // Enrich to get a human-readable description
  let description = `${conflict.command} (PID ${conflict.pid})`;
  for (const enricher of enrichers) {
    try {
      const enriched = await enricher(conflict, port);
      if (enriched) { description = enriched; break; }
    } catch { /* continue */ }
  }

  // SSH process connecting to a different host = stale tunnel from old env
  if (conflict.command.toLowerCase() === 'ssh') {
    return { status: 'stale', description };
  }

  // Any other process
  return { status: 'other', description };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot of all TCP listeners on the machine.
 * One lsof call instead of N per-port calls (avoids timeouts with many ports).
 * Uses a pending promise to deduplicate concurrent calls.
 */
let listenerCache: { ts: number; map: Map<number, PortOwnerInfo[]> } = { ts: 0, map: new Map() };
let pendingSnapshot: Promise<Map<number, PortOwnerInfo[]>> | null = null;
const CACHE_TTL_MS = 2_000;

async function getPortOwners(port: number): Promise<PortOwnerInfo[]> {
  if (Date.now() - listenerCache.ts < CACHE_TTL_MS) {
    return listenerCache.map.get(port) ?? [];
  }
  if (!pendingSnapshot) {
    pendingSnapshot = snapshotAllListeners().then((map) => {
      listenerCache = { ts: Date.now(), map };
      pendingSnapshot = null;
      return map;
    });
  }
  const map = await pendingSnapshot;
  return map.get(port) ?? [];
}

/** Run a single lsof call to get all TCP listeners, grouped by port. */
function snapshotAllListeners(): Promise<Map<number, PortOwnerInfo[]>> {
  return new Promise((resolve) => {
    execFile(LSOF_BIN, ['-iTCP', '-sTCP:LISTEN', '-n', '-P'], { timeout: 5_000 }, (_err, stdout) => {
      const map = new Map<number, PortOwnerInfo[]>();
      if (!stdout || !stdout.trim()) { resolve(map); return; }
      const lines = stdout.trim().split('\n');
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\s+/);
        const command = parts[0] ?? '';
        const pid = parts[1] ?? '';
        // NAME is second-to-last (e.g. "127.0.0.1:8765"), last is "(LISTEN)"
        // Format: "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (STATE)"
        const namePart = parts.length >= 10 ? parts[8] : (parts[parts.length - 2] ?? '');
        const colonIdx = namePart.lastIndexOf(':');
        const portStr = colonIdx >= 0 ? namePart.slice(colonIdx + 1) : '';
        const portNum = parseInt(portStr, 10);
        if (!command || !pid || isNaN(portNum)) continue;
        if (!map.has(portNum)) map.set(portNum, []);
        const owners = map.get(portNum)!;
        // Deduplicate by PID within each port
        if (!owners.some((o) => o.pid === pid)) {
          owners.push({ command, pid });
        }
      }
      resolve(map);
    });
  });
}

/** Run a command and return trimmed first line of stdout, or null on failure. */
function exec(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT }, (err, stdout) => {
      resolve(err || !stdout.trim() ? null : stdout.trim().split('\n')[0]);
    });
  });
}

/** Extract the SSH host from a full ssh command line. */
function parseSshHost(args: string): string | null {
  const parts = args.split(/\s+/);
  const flagsWithValue = new Set(['-o', '-L', '-R', '-D', '-p', '-i', '-F', '-J', '-W']);
  let skipNext = false;

  for (let i = 1; i < parts.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const part = parts[i];
    if (part.startsWith('-')) {
      if (flagsWithValue.has(part)) skipNext = true;
      continue;
    }
    return part; // First non-flag arg is the host
  }
  return null;
}
