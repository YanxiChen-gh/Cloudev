/**
 * Identifies the local process that owns a given port.
 * Uses a chain of enrichers to add context (docker container name, SSH target, etc.).
 */

import { execFile } from 'child_process';

const EXEC_TIMEOUT = 2_000;

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
  const owner = await getPortOwner(port);
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
  const owner = await getPortOwner(port);
  if (!owner) {
    return { status: 'none', description: 'Not bound' };
  }

  // Check if our tunnel process owns it
  if (ourPid && owner.pid === String(ourPid)) {
    return { status: 'ours', description: '' };
  }

  // Enrich to get a human-readable description
  let description = `${owner.command} (PID ${owner.pid})`;
  for (const enricher of enrichers) {
    try {
      const enriched = await enricher(owner, port);
      if (enriched) { description = enriched; break; }
    } catch { /* continue */ }
  }

  // SSH process connecting to a different host = stale tunnel from old env
  if (owner.command.toLowerCase() === 'ssh') {
    return { status: 'stale', description };
  }

  // Any other process
  return { status: 'other', description };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the command + PID of the process listening on a port via lsof. */
function getPortOwner(port: number): Promise<PortOwnerInfo | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-n', '-P'], { timeout: EXEC_TIMEOUT }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(null); return; }
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) { resolve(null); return; }
      const parts = lines[1].split(/\s+/);
      const command = parts[0] ?? '';
      const pid = parts[1] ?? '';
      resolve(command && pid ? { command, pid } : null);
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
