import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { OnaProvider, ExecFn } from '../ona';

const FIXTURES = path.join(__dirname, '..', '..', '..', '__tests__', 'fixtures');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

function createMockExec(responses: Record<string, string>): ExecFn {
  return async (args: string[]) => {
    const key = args.join(' ');
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    throw new Error(`Unexpected CLI call: ${key}`);
  };
}

describe('OnaProvider with mocked exec', () => {
  it('listEnvironments parses real fixture data', async () => {
    const envFixture = loadFixture('environments.json');
    const ctxFixture = loadFixture('contexts.json');

    const exec = createMockExec({
      'config context list': ctxFixture,
      'environment list': envFixture,
    });

    const provider = new OnaProvider(exec);
    await provider.checkAvailability();
    const envs = await provider.listEnvironments();

    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env.provider).toBe('ona');
      expect(env.id).toBeTruthy();
    }
  });

  it('listProjects parses real fixture data', async () => {
    const projFixture = loadFixture('projects.json');
    const ctxFixture = loadFixture('contexts.json');

    const exec = createMockExec({
      'config context list': ctxFixture,
      'project list': projFixture,
    });

    const provider = new OnaProvider(exec);
    await provider.checkAvailability();
    const projects = await provider.listProjects();

    expect(projects.length).toBeGreaterThan(0);
    for (const proj of projects) {
      expect(proj.id).toBeTruthy();
      expect(proj.name).toBeTruthy();
    }
  });

  it('deduplicates environments across contexts', async () => {
    const envJson = JSON.stringify([
      { id: 'env-1', metadata: { projectId: 'p1' }, spec: { content: { initializer: { specs: [{ git: { remoteUri: 'https://github.com/test/repo.git' } }] } } }, status: { phase: 'ENVIRONMENT_PHASE_RUNNING' } },
    ]);
    const ctxJson = JSON.stringify([{ name: 'ctx-a' }, { name: 'ctx-b' }]);

    const exec = createMockExec({
      'config context list': ctxJson,
      'environment list': envJson,
    });

    const provider = new OnaProvider(exec);
    await provider.checkAvailability();
    const envs = await provider.listEnvironments();

    // Same env returned by both contexts — should deduplicate to 1
    expect(envs).toHaveLength(1);
  });

  it('handles one failing context gracefully', async () => {
    const ctxJson = JSON.stringify([{ name: 'good-ctx' }, { name: 'bad-ctx' }]);
    const envJson = JSON.stringify([
      { id: 'env-1', metadata: {}, spec: { content: { initializer: { specs: [{ git: {} }] } } }, status: { phase: 'ENVIRONMENT_PHASE_RUNNING' } },
    ]);

    let callCount = 0;
    const exec: ExecFn = async (args) => {
      const key = args.join(' ');
      if (key.includes('config context list')) return ctxJson;
      if (key.includes('environment list')) {
        callCount++;
        if (key.includes('bad-ctx')) throw new Error('context unavailable');
        return envJson;
      }
      throw new Error(`Unexpected: ${key}`);
    };

    const provider = new OnaProvider(exec);
    await provider.checkAvailability();
    const envs = await provider.listEnvironments();

    expect(envs).toHaveLength(1);
    expect(callCount).toBe(2); // Both contexts were tried
  });

  it('start sends correct CLI args', async () => {
    const ctxJson = JSON.stringify([{ name: 'my-ctx' }]);
    const calls: string[][] = [];

    const exec: ExecFn = async (args) => {
      calls.push(args);
      if (args.join(' ').includes('config context list')) return ctxJson;
      return '';
    };

    const provider = new OnaProvider(exec);
    await provider.checkAvailability();
    await provider.start('env-abc');

    const startCall = calls.find((c) => c.includes('start'));
    expect(startCall).toBeDefined();
    expect(startCall).toContain('--dont-wait');
    expect(startCall).toContain('env-abc');
    expect(startCall).toContain('--context');
    expect(startCall).toContain('my-ctx');
  });
});
