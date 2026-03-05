import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the extension version from package.json at runtime,
 * plus a build fingerprint so same-version rebuilds still trigger
 * a daemon restart (critical during development).
 */
/**
 * Returns true if version `a` is strictly newer than version `b`.
 * Versions are "X.Y.Z+mtime" — compares semver first, then mtime.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const [semA, mtimeA] = a.split('+');
  const [semB, mtimeB] = b.split('+');
  const pa = (semA ?? '').split('.').map(Number);
  const pb = (semB ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return Number(mtimeA ?? 0) > Number(mtimeB ?? 0);
}

export function getExtensionVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const version = pkg.version ?? 'unknown';
    // Use the mtime of the compiled entry point as a build fingerprint
    const entryPath = path.join(__dirname, 'extension.js');
    const mtime = fs.statSync(entryPath).mtimeMs;
    return `${version}+${Math.floor(mtime)}`;
  } catch {
    return 'unknown';
  }
}
