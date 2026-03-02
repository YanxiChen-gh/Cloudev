import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the extension version from package.json at runtime,
 * plus a build fingerprint so same-version rebuilds still trigger
 * a daemon restart (critical during development).
 */
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
