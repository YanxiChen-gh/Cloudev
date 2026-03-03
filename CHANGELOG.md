# Changelog

All notable changes to the Cloudev extension will be documented in this file.

## [0.5.2] - 2026-03-02

### Changed
- **Compare commands renamed with "Web"**: "Compare with this env" → "Web Compare", "Remove from Compare" → "Remove Web Compare", "Compare in Browser" → "Open Web Compare", "Stop comparing" → "Stop web compare". Makes it clear that compare uses HTTP hostname routing and only works for web UIs, not raw TCP (databases, gRPC).
- **README**: added HTTP-only limitation note to side-by-side web compare feature description.

## [0.5.1] - 2026-03-02

### Fixed
- **Compare routing broken by discovery timer**: the 5-second port discovery timer could fire during compare mode and call `applyPorts`, which replaced HTTP proxies (hostname routing) with TCP proxies (single upstream). Discovery timer is now stopped while compare is active and restarted when compare ends.
- **Debug logging**: `addCompare` now logs per-port routes and proxy mode to `daemon.log` for easier troubleshooting.

### Changed
- **"Open Both" → "Open All"**: notification and right-click action now open all envs in the compare session (not just primary + one), supporting 3+ way compare.

## [0.5.0] - 2026-03-02

### Added
- **Additive compare**: right-click a running env while forwarding → "Compare with this env". Adds envs to an ongoing compare session one at a time, without stopping forwarding.
- **Compare sidebar indicators**: compared envs show `$(git-compare)` icon (blue) with `hostname.localhost` description
- **Status bar compare count**: shows `+ N comparing` when compare is active
- **"Open Both in Browser"**: right-click a compared env to re-open both primary and compared env tabs
- **"Stop comparing"**: status bar QuickPick action to remove all compares while keeping primary forwarding
- **Web port heuristic**: `pickWebPort()` auto-selects the best port for compare notifications using last-used → label keywords → well-known ports → lowest
- **Compare notification**: "Comparing env-a ↔ env-b (port 3000)" with "Open Both", "Other port...", "Copy URLs" actions
- **`cloudev.isForwarding` context key**: controls inline icon visibility (compare icon vs forward icon on running envs)
- IPC messages: `port-forwarding.add-compare`, `port-forwarding.remove-compare`

### Changed
- Status bar QuickPick is compare-aware: shows compared envs with hostnames, remove actions, and "Stop comparing"
- Inline icons swap: running envs show `$(git-compare)` when forwarding is active (instead of `$(arrow-swap)`)
- `stopForwarding()` cleans up any active compare session before tearing down

## [0.4.0] - 2026-03-02

### Added
- **Local proxy architecture**: SSH tunnels bind to hidden ports; a local TCP proxy owns user-facing ports. Enables instant env switching (no port rebind) and side-by-side compare.
- **Instant quick-switch**: switching forwarding between envs is now a proxy upstream swap — no port release/reacquire race. Port cache enables instant switch on second visit.
- **Side-by-side web compare**: compare multiple envs simultaneously via hostname routing. Access `http://env-name.localhost:port` in Chrome/Firefox for each env while `localhost:port` still works for the primary.
- **OS-assigned hidden ports**: avoids collisions with old tunnels still releasing
- **Skip privileged ports** (< 1024) from forwarding

### Changed
- `spawnTunnel` provider interface now accepts `PortMapping[]` instead of `number[]`
- Port ownership detection recognizes daemon process as "ours"

## [0.3.0] - 2026-03-02

### Added
- **Shell history sync**: bidirectional sync of bash and zsh history between local machine and remote environments
- Separate local stores per shell type — no cross-contamination between bash and zsh formats
- Two-pass sync algorithm: collect from all envs first, then push merged diff back (single sync fully converges)
- Manual sync via command palette or right-click context menu
- Configurable periodic auto-sync (`cloudev.shellHistory.periodicSyncMinutes` setting)
- Set-based dedup prevents duplication on repeated syncs
- Shell history sync errors logged to Cloudev output channel
- `execRemoteCommand` added to provider interface (building block for future features)
- Clear Shell History command to reset local store

## [0.1.1] - 2026-03-01

### Fixed
- Publisher ID for VS Code Marketplace

## [0.1.0] - 2026-03-01

### Added
- **Multi-provider support**: Ona/Gitpod and GitHub Codespaces in a single sidebar
- **Port forwarding**: auto-discovery, SSH tunnels, public URL support
- **Port conflict detection**: PID-based ownership check via lsof, friendly process names
- **Favorites**: star environments and ports, sorted to top
- **Environment lifecycle**: create, start, stop, restart, delete from sidebar or command palette
- **Create flow**: project picker, machine class selector, branch input
- **Dashboard links**: open provider web UI for any environment
- **SSH command copy**: copy provider-specific SSH command to clipboard
- **Port details copy**: copy port info including label, public URL, and conflict status
- **Persistent daemon**: stays alive while forwarding, survives VS Code reloads
- **Auto-resume**: forwarding target persisted to disk, resumes on daemon restart
- **Daemon version check**: graceful restart on extension update
- **Error notifications**: warning popups with "Copy Error" and "Show Output" actions
- **VS Code Remote conflict hint**: one-time notification to disable auto-forwarding
- **LogOutputChannel**: structured logging with VS Code-managed rotation
- **Daemon log rotation**: rotates on start, keeps one previous session
- **View Daemon Log command**: open `~/.cloudev/daemon.log` in VS Code
- **SSH config auto-fix**: patches corrupted gitpod SSH configs after each sync
- **CI/CD**: GitHub Actions for PR checks and tag-based releases
- **Marketplace publishing**: automated on version tags
