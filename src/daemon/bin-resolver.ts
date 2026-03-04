/**
 * Resolves binary paths for all external CLI tools used by the daemon.
 *
 * Resolution priority per binary:
 * 1. User override (from VS Code settings, sent via IPC)
 * 2. `which <name>` against user's real login shell PATH
 * 3. Known platform-specific fallback locations
 * 4. Bare name (relies on daemon's process.env.PATH)
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BinaryPaths {
  gitpod: string;
  gh: string;
  ssh: string;
  lsof: string;
  docker: string;
  ps: string;
}

export interface BinaryPathOverrides {
  gitpod?: string;
  gh?: string;
  ssh?: string;
  lsof?: string;
}

/** Platform-specific fallback locations for each binary */
const KNOWN_LOCATIONS: Record<string, string[]> = {
  gitpod: [
    '/usr/local/bin/gitpod',
    path.join(os.homedir(), '.local', 'bin', 'gitpod'),
    '/opt/homebrew/bin/gitpod',
  ],
  gh: [
    '/usr/local/bin/gh',
    '/opt/homebrew/bin/gh',
    path.join(os.homedir(), '.local', 'bin', 'gh'),
  ],
  ssh: ['/usr/bin/ssh', '/usr/local/bin/ssh'],
  lsof: ['/usr/sbin/lsof', '/usr/bin/lsof'],
  docker: ['/usr/local/bin/docker', '/usr/bin/docker', '/opt/homebrew/bin/docker'],
  ps: ['/bin/ps', '/usr/bin/ps'],
};

let resolvedPaths: BinaryPaths | null = null;

/**
 * Resolve the user's real shell PATH by running a login shell.
 * Captures ~/.bashrc, ~/.zshrc, Homebrew paths, nix paths, etc.
 */
function resolveShellPath(): string | null {
  const shell = process.env.SHELL || '/bin/sh';
  try {
    const result = execFileSync(shell, ['-lc', 'echo $PATH'], {
      timeout: 5_000,
      encoding: 'utf-8',
      env: { HOME: os.homedir(), USER: process.env.USER },
    });
    // Take last line only — login shells may print MOTD/banners before it
    const resolved = result.trim().split('\n').pop()?.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** Find a binary using `which` against a given PATH */
function whichWithPath(name: string, pathEnv: string): string | null {
  try {
    const result = execFileSync('/usr/bin/which', [name], {
      timeout: 2_000,
      encoding: 'utf-8',
      env: { ...process.env, PATH: pathEnv },
    });
    const resolved = result.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** Find a binary by checking known platform-specific locations */
function findInKnownLocations(name: string): string | null {
  const locations = KNOWN_LOCATIONS[name] ?? [];
  for (const loc of locations) {
    try {
      fs.accessSync(loc, fs.constants.X_OK);
      return loc;
    } catch { /* continue */ }
  }
  return null;
}

/**
 * Resolve a single binary path.
 * Priority: override → which on shell PATH → known locations → bare name.
 */
function resolveBinary(name: string, shellPath: string, override?: string): string {
  // 1. User override
  if (override) {
    const expanded = override.startsWith('~/')
      ? path.join(os.homedir(), override.slice(2))
      : override;
    try {
      fs.accessSync(expanded, fs.constants.X_OK);
      return expanded;
    } catch {
      console.error(`[bin-resolver] User override for ${name} not executable: ${expanded}, falling back to auto-detection`);
    }
  }

  // 2. which on real shell PATH
  const fromWhich = whichWithPath(name, shellPath);
  if (fromWhich) return fromWhich;

  // 3. Known platform locations
  const fromKnown = findInKnownLocations(name);
  if (fromKnown) return fromKnown;

  // 4. Bare name fallback
  return name;
}

/**
 * Resolve all binary paths. Call at daemon startup and on settings change.
 */
export function resolveBinaries(overrides: BinaryPathOverrides = {}): BinaryPaths {
  const shellPath = resolveShellPath() ?? process.env.PATH ?? '';
  const entryCount = shellPath.split(':').filter(Boolean).length;
  console.log(`[bin-resolver] Shell PATH resolved (${entryCount} entries)`);

  resolvedPaths = {
    gitpod: resolveBinary('gitpod', shellPath, overrides.gitpod),
    gh: resolveBinary('gh', shellPath, overrides.gh),
    ssh: resolveBinary('ssh', shellPath, overrides.ssh),
    lsof: resolveBinary('lsof', shellPath, overrides.lsof),
    docker: resolveBinary('docker', shellPath),
    ps: resolveBinary('ps', shellPath),
  };

  for (const [name, resolved] of Object.entries(resolvedPaths)) {
    console.log(`[bin-resolver] ${name} → ${resolved}`);
  }

  return resolvedPaths;
}

/**
 * Get currently resolved binary paths. Throws if not yet initialized.
 */
export function getBinaries(): BinaryPaths {
  if (!resolvedPaths) {
    throw new Error('Binary paths not resolved yet — call resolveBinaries() first');
  }
  return resolvedPaths;
}
