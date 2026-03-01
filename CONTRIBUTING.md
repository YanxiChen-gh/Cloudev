# Contributing to Cloudev

## Prerequisites

- Node.js 20+
- VS Code 1.85+
- For testing with real environments: `gitpod` CLI and/or `gh` CLI

## Development Setup

```sh
git clone https://github.com/YanxiChen-gh/Cloudev.git
cd Cloudev
npm install
npm run compile
```

Press **F5** in VS Code to launch the extension in a development host.

## Architecture

Two processes: a **VS Code extension** (UI-only) and a **background daemon** (owns all state). They communicate via newline-delimited JSON over a Unix socket at `~/.cloudev/daemon.sock`.

```
src/
+-- extension.ts                    # VS Code entry point
+-- types.ts                        # Shared types + IPC protocol
+-- version.ts                      # Runtime version from package.json
+-- daemon/
|   +-- index.ts                    # Daemon entry point
|   +-- ipc-server.ts               # Unix socket server
|   +-- service.ts                  # DaemonService plugin interface
|   +-- state-file.ts               # Persist forwarding state to disk
|   +-- port-owner.ts               # Port ownership detection (lsof)
|   +-- services/
|   |   +-- environments.ts         # Environment polling + lifecycle
|   |   +-- port-forwarding.ts      # Port discovery + SSH tunnels
|   +-- providers/
|       +-- types.ts                # EnvironmentProvider interface
|       +-- ona.ts                  # Ona/Gitpod provider
|       +-- codespaces.ts           # GitHub Codespaces provider
+-- client/
|   +-- daemon-client.ts            # IPC client, daemon spawning
|   +-- state.ts                    # Client-side state mirror
+-- ui/
    +-- sidebar-provider.ts         # TreeDataProvider
    +-- status-bar.ts               # Status bar items
    +-- commands.ts                 # Command handlers
```

**Key constraint**: The extension never calls SSH or CLI commands directly. All mutations go through the daemon via IPC.

## Testing

```sh
npm test          # run all tests
npm run compile   # must exit with 0 errors
```

CI runs on every PR and must pass before merging.

## Adding a New Provider

1. Create a parser at `src/daemon/providers/{name}-parser.ts`
2. Implement `EnvironmentProvider` from `src/daemon/providers/types.ts`
3. Register in `src/daemon/index.ts` (add to providers array)
4. Add provider-specific UI branch in `src/ui/commands.ts` (for `openInNewWindow`, `create`)
5. Run `npm run compile && npm test`

See the existing Ona and Codespaces providers for reference.

## Pull Requests

- CI must pass (compile + 114 tests)
- Keep changes focused -- one feature or fix per PR
- Follow existing code patterns (see `CLAUDE.md` for detailed conventions)

## Releasing

Releases are automated via GitHub Actions:

1. Bump version in `package.json`
2. Commit and push to main (via PR)
3. Tag: `git tag v{x.y.z} && git push origin v{x.y.z}`
4. CI builds, tests, packages VSIX, publishes to Marketplace
