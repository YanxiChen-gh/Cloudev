import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const STATE_DIR = path.join(os.homedir(), '.cloudev');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

interface PersistedState {
  activeForwardingEnvId?: string;
}

export function readPersistedState(): PersistedState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function writePersistedState(state: PersistedState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch {
    // Best-effort — don't crash if write fails
  }
}
