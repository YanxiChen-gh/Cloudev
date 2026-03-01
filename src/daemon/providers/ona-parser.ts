import { Environment, EnvironmentStatus, Project } from '../../types';

const EXCLUDED_PORTS = new Set([22, 24783]);

/** Parse `ss -tln` output to extract listening port numbers */
export function parseSsOutput(output: string): number[] {
  const ports: number[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (!line.includes('LISTEN')) continue;

    const parts = line.trim().split(/\s+/);
    const localAddr = parts[3];
    if (!localAddr) continue;

    // Port is after the last colon. Handles:
    //   0.0.0.0:3000, [::]:3000, *:3000
    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;

    const port = parseInt(localAddr.slice(lastColon + 1), 10);
    if (!isNaN(port) && !EXCLUDED_PORTS.has(port)) {
      ports.push(port);
    }
  }

  // Deduplicate (IPv4 and IPv6 may both list the same port)
  return [...new Set(ports)].sort((a, b) => a - b);
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
 *   { id, metadata: { projectId, name? }, spec: { content: { initializer: { specs: [{ git: { remoteUri, cloneTarget } }] } }, desiredPhase }, status: { phase } }
 */
export function mapEnvironment(raw: Record<string, unknown>, providerId: string): Environment | null {
  const id = String(raw.id ?? '');
  if (!id) return null;

  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  const spec = (raw.spec ?? {}) as Record<string, unknown>;
  const statusObj = (raw.status ?? {}) as Record<string, unknown>;

  const phase = String(statusObj.phase ?? spec.desiredPhase ?? 'unknown');
  const status = mapStatus(phase);

  // Git info: spec.content.initializer.specs[0].git
  const content = (spec.content ?? {}) as Record<string, unknown>;
  const initializer = (content.initializer ?? {}) as Record<string, unknown>;
  const specs = (initializer.specs ?? []) as Array<Record<string, unknown>>;
  const git = (specs[0]?.git ?? {}) as Record<string, unknown>;

  const repoUrl = String(git.remoteUri ?? '');
  const repoName = repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? '';
  const name = String(metadata.name ?? '') || repoName || id;

  return {
    id,
    provider: providerId,
    name,
    projectId: String(metadata.projectId ?? ''),
    projectName: '', // enriched later from project list
    branch: String(git.cloneTarget ?? ''),
    status,
    repositoryUrl: repoUrl,
    checkoutLocation: String(git.checkoutLocation ?? ''),
  };
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
