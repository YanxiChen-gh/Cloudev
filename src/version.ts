import * as fs from 'fs';
import * as path from 'path';

/** Read the extension version from package.json at runtime. */
export function getExtensionVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
