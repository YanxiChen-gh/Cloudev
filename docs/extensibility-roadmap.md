# Cloudev Extensibility Roadmap

## Current State

The extension has one provider (Ona/Gitpod) with hardcoded SSH, port discovery, and tunnel logic. It works well for this single use case. This document analyzes what needs to change to support multiple providers, custom connections, and user configuration.

## Architecture Audit

### What's well-modularized

- **DaemonService plugin pattern**: Adding new daemon features (shell history sync, etc.) requires zero changes to existing services. Each service handles its own IPC messages, contributes its own state slice, and reacts to other services' state changes.
- **IPC protocol**: Feature-prefixed message types (`environments.*`, `port-forwarding.*`) route cleanly to services.
- **UI layer**: Commands, sidebar, and status bar are cleanly separated from daemon logic.

### What's NOT modularized

The `EnvironmentProvider` interface conflates three independent concerns:

```
EnvironmentProvider (current — monolithic)
├── Environment lifecycle (list, start, stop, create, delete, restart)
├── Connectivity (sshHost, syncSshConfig)
├── Port forwarding (discoverPorts, spawnTunnel)
└── Metadata (listProjects, listMachineClasses)
```

All four are tightly coupled in the interface. Each provider must implement all of them, even if the connectivity/tunneling approach is completely different.

## Problem: Gitpod-shaped Abstractions

The current interface embeds Gitpod assumptions:

| Method | Gitpod assumption | Codespaces reality |
|--------|-------------------|-------------------|
| `sshHost(envId)` | Returns `{id}.gitpod.environment` | Uses `gh codespace ssh` (different auth model) |
| `syncSshConfig()` | Writes to `~/.ssh/config` | Not needed (gh CLI handles it) |
| `discoverPorts(envId)` | SSH + `ss -tln` + `docker ps` | `gh codespace ports --json` (no SSH needed) |
| `spawnTunnel(envId, ports)` | `ssh -N -L` per port | `gh codespace ports forward` (different mechanism) |
| `create({ projectId })` | Creates from Gitpod project ID | Creates from repo URL + devcontainer config |

A Codespaces provider could implement this interface with workarounds, but the abstractions would leak badly.

## Proposed Architecture: Strategy Composition

Split the monolithic provider into composable strategies:

```
EnvironmentProvider       — lifecycle only (list, start, stop, create, delete)
  └── uses:
      ConnectionStrategy    — how to run commands on the remote (SSH, gh CLI, custom)
      PortDiscoveryStrategy — how to discover listening ports
      TunnelStrategy        — how to forward ports to localhost
```

### ConnectionStrategy

```typescript
interface ConnectionStrategy {
  /** Execute a command on the remote environment */
  exec(envId: string, command: string): Promise<string>;
  /** Get a stable identifier for the connection (for SSH config, etc.) */
  getHost(envId: string): string;
  /** Optional: setup needed before connections work */
  setup?(): Promise<void>;
}
```

Implementations:
- `SshConnection` — direct SSH via `{id}.gitpod.environment` (current Ona approach)
- `GhCodespaceConnection` — via `gh codespace ssh` or `gh codespace exec`
- `CustomSshConnection` — configurable host format, jump host, identity file, port

### PortDiscoveryStrategy

```typescript
interface PortDiscoveryStrategy {
  /** Discover listening ports and their labels */
  discover(envId: string, connection: ConnectionStrategy): Promise<{
    ports: number[];
    labels: Record<number, string>;
  }>;
}
```

Implementations:
- `SsDiscovery` — runs `ss -tln` via connection, parses output
- `DockerDiscovery` — runs `docker ps` via connection, parses container port mappings
- `GhCodespacePortDiscovery` — runs `gh codespace ports --json` (no connection needed)
- `CompositeDiscovery` — chains multiple strategies, merges results (ss + docker)
- `StaticPortMap` — fallback well-known port → label mapping

### TunnelStrategy

```typescript
interface TunnelStrategy {
  /** Spawn a tunnel process for the given ports */
  spawn(envId: string, ports: number[]): ChildProcess;
}
```

Implementations:
- `SshTunnel` — `ssh -N -L` (current approach)
- `GhCodespaceTunnel` — `gh codespace ports forward`
- `CustomSshTunnel` — configurable SSH binary, args, jump host

### Composition Examples

```typescript
// Ona (current functionality, refactored)
new OnaProvider({
  connection: new SshConnection({
    hostFormat: '{id}.gitpod.environment',
    options: ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no'],
  }),
  portDiscovery: new CompositeDiscovery([
    new SsDiscovery({ excludePorts: [22, 24783] }),
    new DockerDiscovery(),
  ]),
  tunnel: new SshTunnel({ exitOnForwardFailure: false }),
})

// Codespaces
new CodespacesProvider({
  connection: new GhCodespaceConnection(),
  portDiscovery: new GhCodespacePortDiscovery(),
  tunnel: new GhCodespaceTunnel(),
})

// Custom cloud provider
new GenericProvider({
  connection: new SshConnection({
    hostFormat: '{id}.mycloud.dev',
    jumpHost: 'bastion.mycloud.dev',
    identityFile: '~/.ssh/mycloud_key',
    port: 2222,
  }),
  portDiscovery: new CompositeDiscovery([
    new SsDiscovery({ excludePorts: [22] }),
    new StaticPortMap({ 8080: 'web', 5432: 'postgres' }),
  ]),
  tunnel: new SshTunnel(),
})
```

## Configuration via VS Code Settings

Add `contributes.configuration` in `package.json`:

```json
{
  "cloudev.providers.ona.enabled": true,
  "cloudev.providers.ona.cliBinary": "/usr/local/bin/gitpod",
  "cloudev.providers.codespaces.enabled": false,
  "cloudev.ssh.extraArgs": [],
  "cloudev.portDiscovery.excludePorts": [22, 24783],
  "cloudev.portDiscovery.methods": ["ss", "docker"],
  "cloudev.daemon.pollIntervalMs": 10000,
  "cloudev.daemon.portDiscoveryIntervalMs": 5000,
  "cloudev.daemon.gracePeriodMs": 10000,
  "cloudev.daemon.sshConfigSyncIntervalMs": 60000
}
```

Currently hardcoded values that should become configurable:

| Value | Current location | Default |
|-------|-----------------|---------|
| Gitpod CLI path | `ona.ts` line 7 | `/usr/local/bin/gitpod` |
| CLI timeout | `ona.ts` line 8 | 30000ms |
| SSH connect timeout | `ona.ts` line 9 | 5s |
| Excluded ports | `ona-parser.ts` line 3 | [22, 24783] |
| Poll interval | `environments.ts` constructor | 10000ms |
| Port discovery interval | `port-forwarding.ts` line 5 | 5000ms |
| Grace period | `ipc-server.ts` constructor | 10000ms |
| SSH config sync interval | `environments.ts` constructor | 60000ms |
| Tunnel kill delay | `port-forwarding.ts` line 7 | 2000ms |

## Implementation Sequence

### Phase 1: Extract and Configure (do now, low risk)
1. Move hardcoded constants to a config module that reads VS Code settings
2. Add `contributes.configuration` to `package.json` with defaults matching current values
3. Extract SSH execution utilities from `OnaProvider` into a shared `ssh-utils.ts`
4. Extract port parsing from `ona-parser.ts` into generic `port-parser.ts` (already mostly done)

### Phase 2: Strategy Interfaces (do when adding Codespaces)
1. Define `ConnectionStrategy`, `PortDiscoveryStrategy`, `TunnelStrategy` interfaces
2. Refactor `OnaProvider` to use `SshConnection`, `CompositeDiscovery(Ss + Docker)`, `SshTunnel`
3. Implement `CodespacesProvider` using `GhCodespaceConnection`, `GhCodespacePortDiscovery`, `GhCodespaceTunnel`
4. Update `EnvironmentProvider` to remove connectivity/tunnel methods; providers compose strategies instead

### Phase 3: User-Extensible Providers (future)
1. Allow users to define custom providers via settings (host format, SSH options, port discovery method)
2. Generic provider that composes strategies based on configuration
3. Support for custom port discovery scripts (user provides a command that outputs JSON)

## Tradeoffs

### Refactor now vs. later

**Refactor now (strategy pattern)**:
- Pro: Clean from day one, no tech debt accumulation
- Pro: Forces us to think about the right abstractions
- Con: We're designing interfaces without a second concrete implementation — risk of wrong abstractions
- Con: More code and indirection for a single-provider extension
- Con: Delays shipping the Codespaces provider

**Refactor when adding Codespaces**:
- Pro: Real friction points reveal the right seams
- Pro: Two concrete implementations validate the interface design
- Pro: Less speculative code
- Con: Larger refactor when we do it (touching more files at once)
- Con: Current code has some hardcoded values that should be configurable regardless

**Recommended**: Phase 1 now (config + extract utilities), Phase 2 with Codespaces, Phase 3 as demand emerges.

## What NOT to abstract

- **IPC protocol**: Already extensible via feature-prefixed messages. Don't add a plugin system for IPC.
- **UI rendering**: TreeView nodes and status bar items are thin wiring. Don't abstract the rendering layer.
- **Daemon lifecycle**: The daemon process management is a one-time concern. Don't make it pluggable.
- **Auth**: Each provider's CLI handles auth. Don't build a token manager.

## Port Discovery: Extensibility Deep Dive

Port discovery is the most likely customization point. Users may want to:
- Exclude specific ports (already hardcoded: 22, 24783)
- Include only specific ports (whitelist mode)
- Use `netstat` instead of `ss` (older Linux)
- Read port mappings from a config file (e.g., `.devcontainer.json`)
- Run a custom script that outputs port info as JSON
- Combine multiple sources (ss + docker + config file)

The `CompositeDiscovery` pattern handles all of these:

```typescript
// User configuration:
"cloudev.portDiscovery.methods": ["ss", "docker", "devcontainer"]
"cloudev.portDiscovery.custom": "cat /workspace/.ports.json"
"cloudev.portDiscovery.excludePorts": [22, 24783, 2222]
"cloudev.portDiscovery.includeOnly": []  // empty = include all
```

Each method is a `PortDiscoveryStrategy` that can be enabled/disabled via settings. The `CompositeDiscovery` merges results from all enabled methods, with later methods' labels overriding earlier ones (docker labels override ss labels, devcontainer labels override docker).

## SSH: Extensibility Deep Dive

SSH configuration is the second most likely customization:

```typescript
interface SshConnectionConfig {
  hostFormat: string;           // e.g., '{id}.gitpod.environment'
  binary?: string;              // default: 'ssh'
  port?: number;                // default: 22
  identityFile?: string;        // e.g., '~/.ssh/mykey'
  jumpHost?: string;            // e.g., 'bastion.corp.dev'
  extraArgs?: string[];         // e.g., ['-o', 'ServerAliveInterval=60']
  connectTimeoutS?: number;     // default: 5
  strictHostKeyChecking?: boolean; // default: false
}
```

This config would be readable from VS Code settings:

```json
"cloudev.ssh": {
  "binary": "ssh",
  "connectTimeout": 5,
  "strictHostKeyChecking": false,
  "extraArgs": ["-o", "ServerAliveInterval=60"]
}
```

The `SshConnection` class reads this config and constructs the SSH command accordingly. Providers can override individual settings (e.g., Ona sets `hostFormat`, user settings add `extraArgs`).
