import { describe, it, expect } from 'vitest';
import { parseSsOutput, parseDockerPorts, getPortLabel, mapStatus, mapEnvironment, mapProject } from '../ona-parser';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURES = path.join(__dirname, '..', '..', '..', '__tests__', 'fixtures');

describe('parseSsOutput', () => {
  it('parses standard IPv4 output', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*
LISTEN 0      511          0.0.0.0:8080       0.0.0.0:*`;
    expect(parseSsOutput(output)).toEqual([3000, 8080]);
  });

  it('parses IPv6 output', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      128             [::]:3000          [::]:*
LISTEN 0      128             [::]:9090          [::]:*`;
    expect(parseSsOutput(output)).toEqual([3000, 9090]);
  });

  it('parses wildcard (*:PORT) format', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      511                *:5432             *:*`;
    expect(parseSsOutput(output)).toEqual([5432]);
  });

  it('excludes port 22 and 24783', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*
LISTEN 0      128             [::]:24783         [::]:*`;
    expect(parseSsOutput(output)).toEqual([3000]);
  });

  it('includes localhost bindings (127.0.0.1) — ExitOnForwardFailure=no handles conflicts', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*
LISTEN 0      65536      127.0.0.1:5000       0.0.0.0:*
LISTEN 0      65536      127.0.0.1:8126       0.0.0.0:*
LISTEN 0      511             [::]:8080          [::]:*`;
    expect(parseSsOutput(output)).toEqual([3000, 5000, 8080, 8126]);
  });

  it('deduplicates IPv4 and IPv6 entries for the same port', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*
LISTEN 0      511             [::]:3000          [::]:*`;
    expect(parseSsOutput(output)).toEqual([3000]);
  });

  it('returns sorted ports', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      511          0.0.0.0:9090       0.0.0.0:*
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*
LISTEN 0      511          0.0.0.0:8080       0.0.0.0:*`;
    expect(parseSsOutput(output)).toEqual([3000, 8080, 9090]);
  });

  it('handles empty output', () => {
    expect(parseSsOutput('')).toEqual([]);
  });

  it('handles header-only output (no LISTEN lines)', () => {
    const output = 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n';
    expect(parseSsOutput(output)).toEqual([]);
  });

  it('parses the real fixture file', () => {
    const output = fs.readFileSync(path.join(FIXTURES, 'ss-output.txt'), 'utf-8');
    const ports = parseSsOutput(output);
    expect(ports).toEqual([3000, 5432, 8080, 9090]);
  });
});

describe('mapStatus', () => {
  it('maps ENVIRONMENT_PHASE_RUNNING', () => {
    expect(mapStatus('ENVIRONMENT_PHASE_RUNNING')).toBe('running');
  });

  it('maps ENVIRONMENT_PHASE_STOPPED', () => {
    expect(mapStatus('ENVIRONMENT_PHASE_STOPPED')).toBe('stopped');
  });

  it('maps ENVIRONMENT_PHASE_STARTING', () => {
    expect(mapStatus('ENVIRONMENT_PHASE_STARTING')).toBe('starting');
  });

  it('maps ENVIRONMENT_PHASE_STOPPING', () => {
    expect(mapStatus('ENVIRONMENT_PHASE_STOPPING')).toBe('stopping');
  });

  it('maps ENVIRONMENT_PHASE_CREATING', () => {
    expect(mapStatus('ENVIRONMENT_PHASE_CREATING')).toBe('creating');
  });

  it('maps unknown phases to unknown', () => {
    expect(mapStatus('SOMETHING_ELSE')).toBe('unknown');
    expect(mapStatus('')).toBe('unknown');
  });
});

describe('mapEnvironment', () => {
  it('maps real gitpod CLI environment JSON', () => {
    const raw = {
      id: 'env-123',
      metadata: { projectId: 'proj-456', name: '' },
      spec: {
        content: {
          initializer: {
            specs: [{ git: { remoteUri: 'https://github.com/org/repo.git', cloneTarget: 'main' } }],
          },
        },
      },
      status: { phase: 'ENVIRONMENT_PHASE_RUNNING' },
    };

    const env = mapEnvironment(raw, 'ona');
    expect(env).toEqual({
      id: 'env-123',
      provider: 'ona',
      name: 'repo', // derived from remoteUri since metadata.name is empty
      projectId: 'proj-456',
      projectName: '',
      branch: 'main',
      status: 'running',
      repositoryUrl: 'https://github.com/org/repo.git',
      checkoutLocation: '',
      sshHost: 'env-123.gitpod.environment',
      workspacePath: '/workspaces',
    });
  });

  it('uses metadata.name when available', () => {
    const raw = {
      id: 'env-123',
      metadata: { projectId: 'proj-456', name: 'My Custom Name' },
      spec: { content: { initializer: { specs: [{ git: { remoteUri: 'https://github.com/org/repo.git' } }] } } },
      status: { phase: 'ENVIRONMENT_PHASE_STOPPED' },
    };

    const env = mapEnvironment(raw, 'ona');
    expect(env?.name).toBe('My Custom Name');
  });

  it('returns null for missing id', () => {
    expect(mapEnvironment({}, 'ona')).toBeNull();
    expect(mapEnvironment({ id: '' }, 'ona')).toBeNull();
  });

  it('handles missing nested fields gracefully', () => {
    const raw = { id: 'env-minimal' };
    const env = mapEnvironment(raw, 'ona');
    expect(env).toEqual({
      id: 'env-minimal',
      provider: 'ona',
      name: 'env-minimal', // falls back to id
      projectId: '',
      projectName: '',
      branch: '',
      status: 'unknown',
      repositoryUrl: '',
      checkoutLocation: '',
      sshHost: 'env-minimal.gitpod.environment',
      workspacePath: '/workspaces',
    });
  });

  it('parses environments from real fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'environments.json'), 'utf-8'));
    const envs = fixture.map((raw: Record<string, unknown>) => mapEnvironment(raw, 'ona')).filter(Boolean);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env.id).toBeTruthy();
      expect(env.provider).toBe('ona');
      expect(['running', 'stopped', 'starting', 'stopping', 'creating', 'unknown']).toContain(env.status);
    }
  });
});

describe('mapProject', () => {
  it('maps real gitpod CLI project JSON', () => {
    const raw = {
      id: 'proj-123',
      metadata: { name: 'MyProject' },
      initializer: { specs: [{ git: { remoteUri: 'https://github.com/org/repo.git' } }] },
    };

    expect(mapProject(raw)).toEqual({
      id: 'proj-123',
      name: 'MyProject',
      repositoryUrl: 'https://github.com/org/repo.git',
    });
  });

  it('falls back to id when name is missing', () => {
    const raw = { id: 'proj-123', metadata: {} };
    expect(mapProject(raw)?.name).toBe('proj-123');
  });

  it('returns null for missing id', () => {
    expect(mapProject({})).toBeNull();
  });

  it('parses projects from real fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'projects.json'), 'utf-8'));
    const projects = fixture.map((raw: Record<string, unknown>) => mapProject(raw)).filter(Boolean);
    expect(projects.length).toBeGreaterThan(0);
    for (const proj of projects) {
      expect(proj.id).toBeTruthy();
      expect(proj.name).toBeTruthy();
    }
  });
});

describe('parseDockerPorts', () => {
  it('parses real docker ps output', () => {
    const output = `obsidian-nginx.internal-1\t0.0.0.0:8080->80/tcp, [::]:8080->80/tcp
obsidian-mongo.internal-1\t0.0.0.0:27017->27017/tcp, [::]:27017->27017/tcp
obsidian-redis.internal-1\t0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp
obsidian-mysql.internal-1\t0.0.0.0:3306->3306/tcp, [::]:3306->3306/tcp, 33060/tcp`;

    const result = parseDockerPorts(output);
    expect(result.get(8080)).toBe('nginx');
    expect(result.get(27017)).toBe('mongo');
    expect(result.get(6379)).toBe('redis');
    expect(result.get(3306)).toBe('mysql');
  });

  it('handles containers with multiple port mappings', () => {
    const output = `obsidian-minio-1\t0.0.0.0:9001->9001/tcp, [::]:9001->9001/tcp, 0.0.0.0:9002->9000/tcp`;
    const result = parseDockerPorts(output);
    expect(result.get(9001)).toBe('minio');
    expect(result.get(9002)).toBe('minio');
  });

  it('handles containers with no port mappings', () => {
    const output = `obsidian-mongo-index-sync.internal-1\t`;
    const result = parseDockerPorts(output);
    expect(result.size).toBe(0);
  });

  it('cleans container names', () => {
    const output = `obsidian-web-client.internal-1\t0.0.0.0:9000->9000/tcp`;
    const result = parseDockerPorts(output);
    expect(result.get(9000)).toBe('web-client');
  });

  it('handles empty output', () => {
    expect(parseDockerPorts('').size).toBe(0);
  });
});

describe('getPortLabel', () => {
  it('returns docker label when available', () => {
    const docker = new Map([[8080, 'nginx']]);
    expect(getPortLabel(8080, docker)).toBe('nginx');
  });

  it('falls back to well-known port', () => {
    const docker = new Map<number, string>();
    expect(getPortLabel(5432, docker)).toBe('postgres');
    expect(getPortLabel(6379, docker)).toBe('redis');
    expect(getPortLabel(3000, docker)).toBe('http');
  });

  it('returns empty string for unknown port', () => {
    expect(getPortLabel(54321, new Map())).toBe('');
  });

  it('docker label takes precedence over well-known', () => {
    const docker = new Map([[3000, 'turborepo-remote-cache']]);
    expect(getPortLabel(3000, docker)).toBe('turborepo-remote-cache');
  });
});
