import { Environment, EnvironmentStatus } from '../../types';

/**
 * Map gh CLI codespace state to our EnvironmentStatus.
 *
 * gh codespace list --json returns state values:
 *   Available, Shutdown, Starting, Rebuilding, ShuttingDown, Failed, Deleted, Archived, Queued, Awaiting
 */
export function mapCodespaceStatus(raw: string): EnvironmentStatus {
  switch (raw.toLowerCase()) {
    case 'available':
      return 'running';
    case 'shutdown':
      return 'stopped';
    case 'starting':
    case 'rebuilding':
    case 'queued':
    case 'awaiting':
      return 'starting';
    case 'shuttingdown':
      return 'stopping';
    default:
      return 'unknown';
  }
}

/**
 * Map raw gh CLI codespace JSON to our Environment interface.
 *
 * gh codespace list --json name,state,repository,gitStatus,machineName returns:
 *   {
 *     "name": "octocat-Hello-World-abc123",
 *     "state": "Available",
 *     "repository": "octocat/Hello-World",
 *     "gitStatus": { "ref": "main", "hasUncommittedChanges": false },
 *     "machineName": "basicLinux32gb"
 *   }
 */
export function mapCodespace(raw: Record<string, unknown>, providerId: string): Environment | null {
  const name = String(raw.name ?? '');
  if (!name) return null;

  const state = String(raw.state ?? 'unknown');
  const status = mapCodespaceStatus(state);

  const repository = String(raw.repository ?? '');
  const repoName = repository.split('/').pop() ?? '';

  const gitStatus = (raw.gitStatus ?? {}) as Record<string, unknown>;
  const branch = String(gitStatus.ref ?? '');

  return {
    id: name,
    provider: providerId,
    name: repoName || name,
    projectId: repository,     // owner/repo — used for sidebar grouping
    projectName: '',           // enriched by environments service fallback (uses projectId)
    branch,
    status,
    repositoryUrl: repository ? `https://github.com/${repository}` : '',
    checkoutLocation: repoName,
    sshHost: name,             // codespace name for `gh codespace ssh -c NAME`
    workspacePath: repoName ? `/workspaces/${repoName}` : '/workspaces',
  };
}

/**
 * Parse `gh codespace ports --json sourcePort,label,browseUrl` output.
 *
 * Returns:
 *   [
 *     { "sourcePort": 3000, "label": "Application", "browseUrl": "https://..." },
 *     { "sourcePort": 8080, "label": "", "browseUrl": "https://..." }
 *   ]
 */
export function parseCodespacePorts(output: string): {
  ports: number[];
  labels: Record<number, string>;
  urls: Record<number, string>;
} {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return { ports: [], labels: {}, urls: {} };

    const seen = new Set<number>();
    const ports: number[] = [];
    const labels: Record<number, string> = {};
    const urls: Record<number, string> = {};

    for (const entry of parsed) {
      const port = Number(entry.sourcePort);
      if (isNaN(port) || port <= 0 || seen.has(port)) continue;
      seen.add(port);
      ports.push(port);

      const label = String(entry.label ?? '');
      if (label) labels[port] = label;

      const url = String(entry.browseUrl ?? '');
      if (url) urls[port] = url;
    }

    return { ports: ports.sort((a, b) => a - b), labels, urls };
  } catch {
    return { ports: [], labels: {}, urls: {} };
  }
}
