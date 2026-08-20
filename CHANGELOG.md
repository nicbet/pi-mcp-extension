# Changelog

## [0.1.3] - 2026-08-20

### Fixed

- Forward `HOME` (and `USERPROFILE` on Windows) to MCP child processes so tools like git can find their global configuration.

## [0.1.2] - 2026-08-19

### Fixed

- Replace a machine-specific local-install path in the README with a generic placeholder.

## [0.1.1] - 2026-08-19

### Fixed

- Do not log an error when a project has no `.mcp.json`.

## [0.1.0] - 2026-08-19

### Added

- Stdio and Streamable HTTP MCP transports from `.mcp.json`.
- Bearer-token HTTP headers, trusted-project gating, bounded protocol handling, and explicit environment forwarding.
- `/mcp` server enable/disable controls.
- Tests, formatting, linting, and TypeScript quality checks.
