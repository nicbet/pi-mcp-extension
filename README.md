# pi-mcp-extension

A dependency-free [Pi](https://pi.dev) extension that exposes tools from stdio and Streamable HTTP MCP servers declared in a project's `.mcp.json`.

## Install

Install globally from Git once this repository is pushed:

```bash
pi install git:github.com/nicbet/pi-mcp-extension
```

For local development:

```bash
pi install /path/to/pi-mcp-extension
```

Restart Pi after installation.

## Development

Install dependencies with `bun install`. The complete local quality gate is:

```bash
bun run check
```

Individual targets are `bun run format`, `bun run format:check`, `bun run lint`, `bun run typecheck`, and `bun run test`.

## Configuration

Create `.mcp.json` in a trusted project. If it contains credentials, add `.mcp.json` to that project's `.gitignore` before adding it:

```json
{
  "mcpServers": {
    "remote-example": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    },
    "local-example": {
      "command": "node",
      "args": ["servers/example/dist/server.js"],
      "env": { "EXAMPLE_API_URL": "http://localhost:11435" }
    }
  }
}
```

A server with `command` uses stdio; a server with `url` uses Streamable HTTP. Its MCP tools are registered as `mcp__SERVER__TOOL` (with non-alphanumeric name characters encoded). Stdio server processes, including their POSIX process groups, are terminated when the session ends.

### Server options

- `command`: stdio executable. Its presence selects the stdio transport.
- `args` (optional): stdio command-line arguments.
- `env` (optional): explicit string environment variables for a stdio server; this is the conventional `.mcp.json` field.
- `url`: absolute `http` or `https` Streamable HTTP endpoint. Its presence selects HTTP transport.
- `headers` (optional): string HTTP headers, including `Authorization: Bearer …`.
- `cwd` (optional): stdio working directory, resolved relative to the project.
- `inheritEnv` (optional, Pi extension): allowlist of environment-variable names to copy from Pi's environment, e.g. `"inheritEnv": ["EXAMPLE_TOKEN"]`.
- `requestTimeoutMs` (optional, Pi extension): JSON-RPC request deadline, from 1,000 to 300,000 ms; defaults to 30,000 ms.

## Security

Treat `.mcp.json` as executable project configuration: commands declared there run with your user permissions. The extension checks Pi's project-trust state before reading it, but only trust repositories whose MCP configuration you have reviewed.

`env` remains the portable configuration mechanism. Because it can contain credentials, do not commit a secret-bearing `.mcp.json`; the extension package's own `.gitignore` cannot protect a consuming project's repository. As an optional hardening measure, `inheritEnv` forwards only named existing environment variables rather than every credential available to Pi. Child servers otherwise receive a minimal environment (`PATH`, required Windows system variables, and `env`). Server stderr is consumed but not forwarded to Pi logs. MCP stdout messages and tool output are bounded to prevent a server from exhausting memory or model context.

Both stdio and Streamable HTTP are supported. HTTP uses configured headers directly, so bearer tokens work through `headers`, but interactive OAuth discovery, login, and refresh flows are not implemented.

## Managing servers

Use `/mcp` to open a server menu; selecting a server toggles it. You can also use `/mcp list`, `/mcp enable <server>`, `/mcp disable <server>`, or `/mcp toggle <server>`. Disabling a server removes its tools from Pi and closes its connection or stdio process. Re-enabling reconnects it and restores its previously registered tools.
