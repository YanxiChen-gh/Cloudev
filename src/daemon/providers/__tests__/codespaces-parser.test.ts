import { describe, it, expect } from 'vitest';
import { mapCodespaceStatus, mapCodespace, parseCodespacePorts } from '../codespaces-parser';

// ---------------------------------------------------------------------------
// mapCodespaceStatus
// ---------------------------------------------------------------------------

describe('mapCodespaceStatus', () => {
  it('maps Available to running', () => {
    expect(mapCodespaceStatus('Available')).toBe('running');
  });

  it('maps Shutdown to stopped', () => {
    expect(mapCodespaceStatus('Shutdown')).toBe('stopped');
  });

  it('maps Starting to starting', () => {
    expect(mapCodespaceStatus('Starting')).toBe('starting');
  });

  it('maps ShuttingDown to stopping', () => {
    expect(mapCodespaceStatus('ShuttingDown')).toBe('stopping');
  });

  it('maps Rebuilding to starting', () => {
    expect(mapCodespaceStatus('Rebuilding')).toBe('starting');
  });

  it('maps Queued to starting', () => {
    expect(mapCodespaceStatus('Queued')).toBe('starting');
  });

  it('maps unknown values to unknown', () => {
    expect(mapCodespaceStatus('SomethingElse')).toBe('unknown');
    expect(mapCodespaceStatus('Failed')).toBe('unknown');
    expect(mapCodespaceStatus('Deleted')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// mapCodespace
// ---------------------------------------------------------------------------

describe('mapCodespace', () => {
  it('maps gh CLI codespace JSON to Environment', () => {
    const raw = {
      name: 'octocat-Hello-World-abc123',
      state: 'Available',
      repository: 'octocat/Hello-World',
      gitStatus: { ref: 'main', hasUncommittedChanges: false },
      machineName: 'basicLinux32gb',
    };

    const env = mapCodespace(raw, 'codespaces');
    expect(env).toEqual({
      id: 'octocat-Hello-World-abc123',
      provider: 'codespaces',
      name: 'Hello-World',
      projectId: 'octocat/Hello-World',
      projectName: '',
      branch: 'main',
      status: 'running',
      repositoryUrl: 'https://github.com/octocat/Hello-World',
      checkoutLocation: 'Hello-World',
      sshHost: 'octocat-Hello-World-abc123',
      workspacePath: '/workspaces/Hello-World',
    });
  });

  it('maps stopped codespace', () => {
    const raw = {
      name: 'user-repo-def456',
      state: 'Shutdown',
      repository: 'user/repo',
      gitStatus: { ref: 'feature-branch' },
    };

    const env = mapCodespace(raw, 'codespaces');
    expect(env?.status).toBe('stopped');
    expect(env?.branch).toBe('feature-branch');
  });

  it('returns null for missing name', () => {
    expect(mapCodespace({}, 'codespaces')).toBeNull();
    expect(mapCodespace({ name: '' }, 'codespaces')).toBeNull();
  });

  it('handles missing gitStatus gracefully', () => {
    const env = mapCodespace({ name: 'cs-1', repository: 'org/repo' }, 'codespaces');
    expect(env?.branch).toBe('');
    expect(env?.status).toBe('unknown');
  });

  it('handles missing repository gracefully', () => {
    const env = mapCodespace({ name: 'cs-1', state: 'Available' }, 'codespaces');
    expect(env?.name).toBe('cs-1'); // falls back to codespace name
    expect(env?.repositoryUrl).toBe('');
    expect(env?.workspacePath).toBe('/workspaces');
  });

  it('uses codespace name as sshHost', () => {
    const env = mapCodespace({
      name: 'my-codespace-123',
      repository: 'org/repo',
    }, 'codespaces');
    expect(env?.sshHost).toBe('my-codespace-123');
  });
});

// ---------------------------------------------------------------------------
// parseCodespacePorts
// ---------------------------------------------------------------------------

describe('parseCodespacePorts', () => {
  it('parses gh codespace ports JSON', () => {
    const output = JSON.stringify([
      { sourcePort: 3000, label: 'Application', browseUrl: 'https://cs-3000.app.github.dev/' },
      { sourcePort: 8080, label: '', browseUrl: 'https://cs-8080.app.github.dev/' },
    ]);

    const result = parseCodespacePorts(output);
    expect(result.ports).toEqual([3000, 8080]);
    expect(result.labels).toEqual({ 3000: 'Application' });
    expect(result.urls).toEqual({
      3000: 'https://cs-3000.app.github.dev/',
      8080: 'https://cs-8080.app.github.dev/',
    });
  });

  it('deduplicates ports', () => {
    const output = JSON.stringify([
      { sourcePort: 3000, label: 'web', browseUrl: 'https://a.dev/' },
      { sourcePort: 3000, label: 'web', browseUrl: 'https://a.dev/' },
      { sourcePort: 8080 },
    ]);

    const result = parseCodespacePorts(output);
    expect(result.ports).toEqual([3000, 8080]);
  });

  it('sorts ports', () => {
    const output = JSON.stringify([
      { sourcePort: 8080 },
      { sourcePort: 3000 },
      { sourcePort: 5432 },
    ]);

    const result = parseCodespacePorts(output);
    expect(result.ports).toEqual([3000, 5432, 8080]);
  });

  it('handles empty array', () => {
    const result = parseCodespacePorts('[]');
    expect(result.ports).toEqual([]);
    expect(result.labels).toEqual({});
    expect(result.urls).toEqual({});
  });

  it('handles invalid JSON', () => {
    const result = parseCodespacePorts('not json');
    expect(result.ports).toEqual([]);
  });

  it('skips entries with invalid ports', () => {
    const output = JSON.stringify([
      { sourcePort: 'abc' },
      { sourcePort: 0 },
      { sourcePort: 3000, label: 'valid' },
    ]);

    const result = parseCodespacePorts(output);
    expect(result.ports).toEqual([3000]);
    expect(result.labels).toEqual({ 3000: 'valid' });
  });

  it('only includes non-empty labels and urls', () => {
    const output = JSON.stringify([
      { sourcePort: 3000, label: '', browseUrl: '' },
      { sourcePort: 8080, label: 'web', browseUrl: 'https://example.com' },
    ]);

    const result = parseCodespacePorts(output);
    expect(result.labels).toEqual({ 8080: 'web' });
    expect(result.urls).toEqual({ 8080: 'https://example.com' });
  });
});
