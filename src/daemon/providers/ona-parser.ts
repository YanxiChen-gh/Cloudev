import { Environment, EnvironmentStatus, Project } from '../../types';

const EXCLUDED_PORTS = new Set([22, 24783]);

/**
 * Parse `ss -tln` output to extract listening port numbers.
 * Includes all addresses (0.0.0.0, 127.0.0.1, [::], *) — matches the
 * reference Tauri app behavior. Paired with `ExitOnForwardFailure=no` on
 * the SSH tunnel so individual port bind failures are silently skipped.
 */
export function parseSsOutput(output: string): number[] {
  const ports: number[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (!line.includes('LISTEN')) continue;

    const parts = line.trim().split(/\s+/);
    const localAddr = parts[3];
    if (!localAddr) continue;

    // Port is after the last colon. Handles:
    //   0.0.0.0:3000, 127.0.0.1:3000, [::]:3000, [::1]:3000, *:3000
    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;

    const port = parseInt(localAddr.slice(lastColon + 1), 10);
    if (!isNaN(port) && !EXCLUDED_PORTS.has(port)) {
      ports.push(port);
    }
  }

  // Deduplicate (same port can appear for IPv4, IPv6, and localhost)
  return [...new Set(ports)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Port labels: docker ps parsing + well-known port fallback
// ---------------------------------------------------------------------------

const WELL_KNOWN_PORTS: Record<number, string> = {
  80: 'http', 443: 'https',
  3000: 'http', 3001: 'http', 4200: 'http', 5173: 'http',
  8000: 'http', 8080: 'http', 8888: 'http',
  5432: 'postgres', 3306: 'mysql',
  6379: 'redis', 6380: 'redis',
  27017: 'mongodb', 27018: 'mongodb',
  9229: 'debugger',
  4566: 'localstack',
};

/**
 * Parse `docker ps --format '{{.Names}}\t{{.Ports}}'` output.
 * Returns a map of host port → cleaned container name.
 *
 * Example input line:
 *   obsidian-nginx.internal-1\t0.0.0.0:8080->80/tcp, [::]:8080->80/tcp
 * → Map { 8080 => "nginx" }
 */
export function parseDockerPorts(output: string): Map<number, string> {
  const result = new Map<number, string>();

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;

    const rawName = line.slice(0, tabIdx).trim();
    const portsStr = line.slice(tabIdx + 1).trim();
    if (!portsStr) continue;

    // Clean container name: strip common prefixes/suffixes
    // "obsidian-nginx.internal-1" → "nginx"
    // "obsidian-web-client.internal-1" → "web-client"
    const name = cleanContainerName(rawName);

    // Parse port mappings: "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp"
    for (const mapping of portsStr.split(',')) {
      const match = mapping.trim().match(/(?:\d+\.\d+\.\d+\.\d+|\[::\]|\*):(\d+)->/);
      if (match) {
        const hostPort = parseInt(match[1], 10);
        if (!isNaN(hostPort) && !result.has(hostPort)) {
          result.set(hostPort, name);
        }
      }
    }
  }

  return result;
}

/** Clean a docker container name into a short readable label */
function cleanContainerName(raw: string): string {
  let name = raw;
  // Remove common suffixes: ".internal-1", "-1"
  name = name.replace(/\.internal-\d+$/, '').replace(/-\d+$/, '');
  // Remove project prefix (first segment before the first dash that's followed by a known service)
  // e.g., "obsidian-nginx" → "nginx", "obsidian-web-client" → "web-client"
  const dashIdx = name.indexOf('-');
  if (dashIdx > 0 && dashIdx < name.length - 1) {
    name = name.slice(dashIdx + 1);
  }
  return name;
}

/**
 * Get a label for a port: docker container name if available, otherwise well-known port guess.
 */
export function getPortLabel(port: number, dockerLabels: Map<number, string>): string {
  return dockerLabels.get(port) ?? WELL_KNOWN_PORTS[port] ?? '';
}

/** Map gitpod CLI phase string to our EnvironmentStatus */
export function mapStatus(raw: string): EnvironmentStatus {
  const lower = raw.toLowerCase();
  if (lower.includes('running')) return 'running';
  if (lower.includes('starting')) return 'starting';
  if (lower.includes('stopping')) return 'stopping';
  if (lower.includes('stopped')) return 'stopped';
  if (lower.includes('creating')) return 'creating';
  return 'unknown';
}

/**
 * Map raw gitpod CLI environment JSON to our Environment interface.
 *
 * Real CLI structure:
 *   { id, metadata: { projectId, name? },
 *     spec: { content: { initializer: { specs: [{ git: { remoteUri, cloneTarget, checkoutLocation } }] } }, desiredPhase },
 *     status: { phase, content: { git: { branch } } } }
 */
export function mapEnvironment(raw: Record<string, unknown>, providerId: string): Environment | null {
  const id = String(raw.id ?? '');
  if (!id) return null;

  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  const spec = (raw.spec ?? {}) as Record<string, unknown>;
  const statusObj = (raw.status ?? {}) as Record<string, unknown>;

  const phase = String(statusObj.phase ?? spec.desiredPhase ?? 'unknown');
  const status = mapStatus(phase);

  // Git info from spec (repo URL, checkout location, default branch)
  const specContent = (spec.content ?? {}) as Record<string, unknown>;
  const initializer = (specContent.initializer ?? {}) as Record<string, unknown>;
  const specs = (initializer.specs ?? []) as Array<Record<string, unknown>>;
  const git = (specs[0]?.git ?? {}) as Record<string, unknown>;

  // Actual branch from status.content.git.branch (reflects current working branch)
  // Falls back to spec cloneTarget (default branch) if status not available
  const statusContent = (statusObj.content ?? {}) as Record<string, unknown>;
  const statusGit = (statusContent.git ?? {}) as Record<string, unknown>;
  const branch = String(statusGit.branch ?? git.cloneTarget ?? '');

  const repoUrl = String(git.remoteUri ?? '');
  const repoName = repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? '';
  const name = String(metadata.name ?? '') || repoName || id;

  const checkoutLocation = String(git.checkoutLocation ?? '');

  return {
    id,
    provider: providerId,
    name,
    projectId: String(metadata.projectId ?? ''),
    projectName: '', // enriched later from project list
    branch,
    status,
    repositoryUrl: repoUrl,
    checkoutLocation,
    sshHost: `${id}.gitpod.environment`,
    workspacePath: checkoutLocation ? `/workspaces/${checkoutLocation}` : '/workspaces',
  };
}

/**
 * Parse `gitpod environment port list <envId> -o json` output.
 * Returns a map of port → public URL for exposed ports.
 *
 * Example input: [{ "port": 8080, "url": "https://8080s--envid.ona-runner.dev" }]
 */
export function parseGitpodPorts(output: string): Record<number, string> {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return {};

    const result: Record<number, string> = {};
    for (const entry of parsed) {
      const port = Number(entry.port);
      const url = String(entry.url ?? '');
      if (!isNaN(port) && port > 0 && url) {
        result[port] = url;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Map raw gitpod CLI project JSON to our Project interface.
 *
 * Real CLI structure:
 *   { id, metadata: { name }, initializer: { specs: [{ git: { remoteUri } }] } }
 */
export function mapProject(raw: Record<string, unknown>): Project | null {
  const id = String(raw.id ?? '');
  if (!id) return null;

  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  const initializer = (raw.initializer ?? {}) as Record<string, unknown>;
  const specs = (initializer.specs ?? []) as Array<Record<string, unknown>>;
  const git = (specs[0]?.git ?? {}) as Record<string, unknown>;

  return {
    id,
    name: String(metadata.name ?? id),
    repositoryUrl: String(git.remoteUri ?? ''),
  };
}
