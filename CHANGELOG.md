# Changelog

All notable changes to the Cloudev extension will be documented in this file.

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
