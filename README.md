# Cloudev

A VS Code extension for managing cloud development environments from your editor. Start, stop, restart, and connect to environments. Forward ports. See what's running across all your VS Code windows.

Currently supports **Ona/Gitpod**. GitHub Codespaces is planned.

## Features

- **Sidebar** — Environments grouped by project, with status icons and inline actions
- **Port forwarding** — Auto-discovers ports in your environment, tunnels them to localhost
- **Status bar** — Daemon health, forwarded ports, running environment count
- **Click to connect** — Single-click an environment to open it in a new VS Code window (or jump to an existing one)
- **Restart** — Stop and restart an environment to pick up new env vars and secrets
- **Multi-window** — All VS Code windows share the same state via a background daemon

## How it works

A background daemon process manages all state, SSH tunnels, and CLI interactions. Each VS Code window connects to the daemon over a Unix socket. This means port forwarding survives window reloads, and all windows see the same state instantly.

```
VS Code Window 1 ──┐
                    ├── IPC (Unix socket) ──▶ Background Daemon
VS Code Window 2 ──┘                         ├── SSH tunnels
                                              ├── Port discovery
                                              ├── gitpod CLI calls
                                              └── State broadcasts
```

## Requirements

- VS Code 1.85+
- **Ona provider**: `gitpod` CLI installed at `/usr/local/bin/gitpod` and logged in (`gitpod login`). System SSH client (for tunnels and port discovery).
- **Codespaces provider**: GitHub CLI (`gh`) installed and logged in (`gh auth login`). Requires the `codespace` OAuth scope — if you get a 403 error, run:
  ```
  gh auth refresh -h github.com -s codespace
  ```

## Commands

| Command | Description |
|---------|-------------|
| `Cloudev: Create Environment` | Create a new environment |
| `Cloudev: Start Environment` | Start a stopped environment |
| `Cloudev: Stop Environment` | Stop a running environment |
| `Cloudev: Restart Environment` | Restart to pick up new env vars/secrets |
| `Cloudev: Delete Environment` | Delete a stopped environment |
| `Cloudev: Forward Ports` | Start port forwarding for an environment |
| `Cloudev: Stop Port Forwarding` | Stop port forwarding |
| `Cloudev: Switch Port Forwarding Target` | Quick-pick to switch which env is forwarded |
| `Cloudev: Open in New Window` | Open a remote SSH window to the environment |
| `Cloudev: Start Daemon` | Manually start or reconnect to the daemon |
| `Cloudev: Refresh Environments` | Force-refresh the environment list |

## Development

```sh
npm install
npm run compile   # build once
npm run watch     # incremental rebuild
```

Press **F5** in VS Code to launch the extension in a development host.

The daemon runs as a separate process at `~/.cloudev/daemon.sock`. Logs are at `~/.cloudev/daemon.log`. PID file at `~/.cloudev/daemon.pid`.

## Project structure

```
src/
├── extension.ts                    # VS Code entry point
├── types.ts                        # Shared types + IPC protocol
├── daemon/
│   ├── index.ts                    # Daemon entry point
│   ├── ipc-server.ts               # Unix socket server
│   ├── service.ts                  # DaemonService plugin interface
│   ├── services/
│   │   ├── environments.ts         # Environment polling + lifecycle
│   │   └── port-forwarding.ts      # Port discovery + SSH tunnels
│   └── providers/
│       ├── types.ts                # EnvironmentProvider interface
│       ├── ona.ts                  # Ona/Gitpod (multi-context CLI wrapper)
│       └── codespaces.ts           # Stub for future Codespaces support
├── client/
│   ├── daemon-client.ts            # IPC client, daemon spawning, reconnection
│   └── state.ts                    # Client-side state mirror
└── ui/
    ├── sidebar-provider.ts         # TreeDataProvider
    ├── status-bar.ts               # Status bar items
    └── commands.ts                 # Command handlers
```
