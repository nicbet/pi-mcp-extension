# pi-mcp-extension

A dependency-free [Pi](https://pi.dev) extension that exposes tools from stdio MCP servers declared in a project's `.mcp.json`.

## Install

Install globally from Git once this repository is pushed:

```bash
pi install git:github.com/nicbet/pi-mcp-extension
```

For local development:

```bash
pi install /Volumes/Work/Repositories/github-nicbet/pi-mcp-extension
```

Restart Pi after installation. Project-local `.mcp.json` is read only after the project is trusted; use `/trust` when prompted.

## Configuration

Create `.mcp.json` in a project:

```json
{
  "mcpServers": {
    "example": {
      "command": "my-mcp-server",
      "args": ["--stdio"],
      "env": { "EXAMPLE_TOKEN": "..." }
    }
  }
}
```

Every declared server is started over stdio when Pi loads the extension. Its MCP tools are registered as `mcp_<server>_<tool>` (unsafe characters become `_`). Server processes are terminated when the Pi session ends.

## Security

Treat `.mcp.json` as executable project configuration: commands declared there run with your user permissions. Only trust repositories whose MCP configuration you have reviewed.

Only stdio servers (`command`, optional `args`, optional `env`) are supported.
