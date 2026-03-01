# Cloudev — AI Development Guide

## Build

```sh
npm install
npm run compile    # must exit with 0 errors — always verify after changes
```

## Architecture

Two processes: a **VS Code extension** (UI-only) and a **background daemon** (owns all state). They communicate via newline-delimited JSON over a Unix socket at `~/.vanta-dev/daemon.sock`.

### Key constraint

The extension never calls SSH or CLI commands directly. All mutations go through the daemon via IPC.

## Where things live

| Concern | File(s) |
|---------|---------|
| All shared types + IPC protocol | `src/types.ts` |
| Provider interface (what each cloud backend must implement) | `src/daemon/providers/types.ts` |
| Ona/Gitpod provider (multi-context CLI wrapper) | `src/daemon/providers/ona.ts` |
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

### Steps to add a new environment provider (e.g. Codespaces):

1. **Implement `EnvironmentProvider`** from `src/daemon/providers/types.ts`
2. **Add to provider list** in `src/daemon/index.ts`
3. **Verify build**: `npm run compile`

The `EnvironmentProvider` interface requires: `checkAvailability`, `listEnvironments`, `start`, `stop`, `restart`, `create`, `delete`, `discoverPorts`, `spawnTunnel`, `sshHost`, `syncSshConfig`, `listProjects`. Optional: `listMachineClasses`.

## Patterns to follow

- **Multi-context CLI calls** (Ona): `Promise.allSettled` across contexts so one failure doesn't block others. See `OnaProvider.listEnvironments()`.
- **Mutations**: try each context sequentially until one succeeds (`execAnyContext` pattern). See `OnaProvider.start()`.
- **IPC framing**: newline-delimited JSON. `JSON.stringify(msg) + '\n'`. Buffer incoming data and split on `'\n'`, keeping the last incomplete segment. Never pretty-print JSON on the wire.
- **Request/response correlation**: client sets a UUID `requestId`, daemon echoes it back in `response` messages.
- **Commands**: support dual invocation — tree view node argument OR command palette quick-pick fallback. Pattern: `node?.env?.id ?? await pickEnvironment(store, 'running')`.
- **package.json menus**: `contextValue` on tree items must exactly match the `when` clauses. Values: `environment-running`, `environment-stopped`, `environment-forwarding`, `environment-starting`.

## Things to watch out for

- **Daemon spawning**: uses `process.execPath` (Electron binary). The daemon script path is resolved as `path.join(__dirname, '..', 'daemon', 'index.js')` from the compiled client.
- **Socket stale detection**: IPC server tries `net.connect()` before unlinking — distinguishes live daemon from crashed leftover.
- **Grace period**: daemon waits 10s after last client disconnects before shutting down (handles VS Code reloads).
- **`disposed` flag**: `DaemonClient.disconnect()` sets `disposed = true`. `connect()` resets it. This matters for the manual reconnect flow.
- **Port forwarding switch**: 500ms delay after killing old tunnel before spawning new one (TCP TIME_WAIT).
- **`isDiscovering` mutex**: prevents overlapping port discovery when SSH is slow.

## Codespaces stub

`src/daemon/providers/codespaces.ts` implements the full interface but all methods throw "not yet implemented". `checkAvailability()` returns `available: false`, so the provider is effectively disabled. Fill in the methods to enable it.
