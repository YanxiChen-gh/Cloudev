# Changelog

All notable changes to the Cloudev extension will be documented in this file.

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
