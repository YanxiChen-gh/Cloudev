# Cloudev — AI Development Guide

## Build

```sh
npm install
npm run compile    # must exit with 0 errors — always verify after changes
```

## Architecture

Two processes: a **VS Code extension** (UI-only) and a **background daemon** (owns all state). They communicate via newline-delimited JSON over a Unix socket at `~/.cloudev/daemon.sock`.

### Key constraint

The extension never calls SSH or CLI commands directly. All mutations go through the daemon via IPC.

## Where things live

| Concern | File(s) |
|---------|---------|
| All shared types + IPC protocol | `src/types.ts` |
| Provider interface (what each cloud backend must implement) | `src/daemon/providers/types.ts` |
| Ona/Gitpod provider (multi-context CLI wrapper) | `src/daemon/providers/ona.ts` |
| Codespaces provider (gh CLI wrapper) | `src/daemon/providers/codespaces.ts` |
| Daemon service plugin interface | `src/daemon/service.ts` |
| Daemon entry point + message routing | `src/daemon/index.ts` |
| IPC socket server (framing, client mgmt, grace period) | `src/daemon/ipc-server.ts` |
| IPC client (spawning, reconnection, request/response) | `src/client/daemon-client.ts` |
| Client state mirror | `src/client/state.ts` |
| Sidebar tree view | `src/ui/sidebar-provider.ts` |
| Status bar (3 items: daemon health, ports, env count) | `src/ui/status-bar.ts` |
| All command handlers | `src/ui/commands.ts` |
| VS Code extension entry point | `src/extension.ts` |
| Extension manifest (commands, menus, views) | `package.json` |

## How to add a new feature

The daemon uses a **service plugin pattern**. Each feature is a `DaemonService` (defined in `src/daemon/service.ts`) that:
- declares which IPC message types it handles (prefix-based: `"environments.*"`, `"port-forwarding.*"`)
- contributes a state slice via `getState()`
- can react to other services' state via `onStateChanged()`

### Steps to add a new daemon feature (e.g. shell history sync):

1. **Add IPC message types** to `ClientMessage` in `src/types.ts` (e.g. `shell-history.sync`)
2. **Create service** at `src/daemon/services/shell-history-sync.ts` implementing `DaemonService`
3. **Register** it in `src/daemon/index.ts` (add to `services` array)
4. **Add client method** in `src/client/daemon-client.ts`
5. **Add command** in `src/ui/commands.ts` + register in `package.json`
6. **Verify build**: `npm run compile`

No changes needed to IPC server, message routing, or existing services.

### Steps to add a new environment provider:

1. **Create parser** at `src/daemon/providers/{name}-parser.ts` (status mapping, env mapping, port parsing)
2. **Implement `EnvironmentProvider`** from `src/daemon/providers/types.ts`, with injectable exec function for testability
3. **Add to provider list** in `src/daemon/index.ts`
4. **Add provider-specific open command branch** in `src/ui/commands.ts` (`openInNewWindow` command)
5. **Verify build**: `npm run compile`

The `EnvironmentProvider` interface requires: `checkAvailability`, `listEnvironments`, `start`, `stop`, `restart`, `create`, `delete`, `discoverPorts` (returns `{ports, labels, urls?}`), `spawnTunnel`, `sshHost`, `syncSshConfig`, `listProjects`. Optional: `listMachineClasses`.

Existing providers: **Ona** (`ona.ts`, gitpod CLI) and **Codespaces** (`codespaces.ts`, gh CLI). Both use injectable exec functions for testing.

## Patterns to follow

- **Multi-context CLI calls** (Ona): `Promise.allSettled` across contexts so one failure doesn't block others. See `OnaProvider.listEnvironments()`.
- **Mutations**: try each context sequentially until one succeeds (`execAnyContext` pattern). See `OnaProvider.start()`.
- **IPC framing**: newline-delimited JSON. `JSON.stringify(msg) + '\n'`. Buffer incoming data and split on `'\n'`, keeping the last incomplete segment. Never pretty-print JSON on the wire.
- **Request/response correlation**: client sets a UUID `requestId`, daemon echoes it back in `response` messages.
- **Commands**: support dual invocation — tree view node argument OR command palette quick-pick fallback. Pattern: `node?.env?.id ?? await pickEnvironment(store, 'running')`.
- **package.json menus**: `contextValue` on tree items must exactly match the `when` clauses. Values: `environment-running`, `environment-stopped`, `environment-forwarding`, `environment-starting`, `port`, `port-with-url`.
- **Command naming**: use `category: "Cloudev"` + short `title` (e.g. `"Stop"`). Context menus show the title; command palette shows `Cloudev: Stop`.
- **Port labels**: `docker ps` output parsed for container names, with well-known port fallback. See `ona-parser.ts`: `parseDockerPorts()`, `getPortLabel()`.
- **Port public URLs**: Ona uses `gitpod env port list` for public URLs, Codespaces uses `browseUrl` from `gh codespace ports`. Shown in port tooltip + "Copy Public URL" context menu.
- **Open in New Window**: Both providers use CLI commands — Ona: `gitpod environment open {id} --editor vscode`, Codespaces: `gh codespace code -c {name}`. No SSH Remote URI construction in UI.
- **Create flow**: Provider-aware — asks user to pick provider when multiple available, then shows provider-specific prompts (Ona: project ID, Codespaces: owner/repo + optional branch).
- **Environment model**: `sshHost` and `workspacePath` are provider-computed fields on `Environment`. UI reads from model, never constructs provider-specific strings.

## UX interaction model

- **Single-click**: selects item (shows tooltip). No action.
- **Inline icons** (hover): quick actions — Start/Stop, Forward/Unforward, Connect, Open in Browser
- **Right-click**: full grouped context menu (Lifecycle > Ports > Connect > Copy > Danger)
- **Status bar click**: port QuickPick when forwarding active, env picker when idle
- **Forwarding indicator**: env icon changes from `circle-filled` to `radio-tower` (green) when forwarding
- **Port children**: collapsed by default under forwarded env, with docker container labels
- **Dangerous ops**: Stop/Restart/Delete show modal confirmation dialogs

## Things to watch out for

- **Daemon spawning**: uses `process.execPath` (Electron binary). The daemon script path is resolved as `path.join(__dirname, '..', 'daemon', 'index.js')` from the compiled client.
- **Socket stale detection**: IPC server tries `net.connect()` before unlinking — distinguishes live daemon from crashed leftover.
- **Grace period**: daemon waits 10s after last client disconnects before shutting down (handles VS Code reloads).
- **`disposed` flag**: `DaemonClient.disconnect()` sets `disposed = true`. `connect()` resets it. This matters for the manual reconnect flow.
- **Port forwarding switch**: `killTunnel()` waits for process exit before spawning new tunnel (avoids "Address already in use").
- **`isDiscovering` mutex**: prevents overlapping port discovery when SSH is slow.
- **Docker port labels**: `docker ps` runs in parallel with `ss -tln` over SSH. Falls back gracefully if docker is not available.
- **Codespaces OAuth scope**: `gh` requires the `codespace` scope which isn't granted by default. `checkAvailability()` detects this and shows a helpful error. Fix: `gh auth refresh -h github.com -s codespace`.

## Provider implementations

**Ona** (`ona.ts`): Uses `gitpod` CLI with multi-context support. Port discovery via SSH (`ss -tln` + `docker ps`) + `gitpod env port list` for public URLs. Tunneling via `ssh -N -L`. Open via `gitpod environment open --editor vscode`.

**Codespaces** (`codespaces.ts`): Uses `gh` CLI. Port discovery via `gh codespace ports --json` (API-based, no SSH). Tunneling via `gh codespace ports forward`. Open via `gh codespace code -c NAME`. No multi-context (single GitHub account). Note: `gh codespace` has no explicit `start` command — codespaces auto-start on connect (SSH/code). Also `gh codespace create` doesn't support `--json` output, just prints the name. Port list can return many duplicate entries — parser deduplicates.

## Testing CLI integration

You can test parsers against real CLI output without running the extension:

```sh
# Verify Ona parser against real gitpod CLI output:
npm run compile
node -e "
const { mapEnvironment } = require('./out/daemon/providers/ona-parser');
const data = $(gitpod environment list -o json 2>/dev/null);
data.forEach(e => console.log(JSON.stringify(mapEnvironment(e, 'ona'), null, 2)));
"

# Verify Codespaces parser against real gh CLI output:
node -e "
const { mapCodespace } = require('./out/daemon/providers/codespaces-parser');
const data = $(gh codespace list --json name,state,repository,gitStatus,machineName 2>/dev/null);
data.forEach(cs => console.log(JSON.stringify(mapCodespace(cs, 'codespaces'), null, 2)));
"

# Verify codespace port dedup:
node -e "
const { parseCodespacePorts } = require('./out/daemon/providers/codespaces-parser');
const data = $(gh codespace ports -c CODESPACE_NAME --json sourcePort,label,browseUrl 2>/dev/null);
console.log(parseCodespacePorts(JSON.stringify(data)));
"
```

**Codespaces setup**: `gh auth login`, then `gh auth refresh -h github.com -s codespace` to grant the required OAuth scope.
