import { readFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_PROTOCOL_BUFFER_BYTES = 1_000_000;
const MAX_TOOL_OUTPUT_BYTES = 50_000;
const MAX_TOOL_SCHEMA_BYTES = 50_000;
const MAX_TOOL_DESCRIPTION_LENGTH = 10_000;
const MAX_NAME_LENGTH = 128;

type BaseServerConfig = {
  env: Record<string, string>;
  inheritEnv: string[];
  requestTimeoutMs: number;
  cwd?: string;
};
type StdioServerConfig = BaseServerConfig & { command: string; args: string[] };
type HttpServerConfig = BaseServerConfig & { url: string; headers: Record<string, string> };
type ServerConfig = StdioServerConfig | HttpServerConfig;
type McpClient = {
  connect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): void;
};
type ManagedServer = {
  config?: ServerConfig;
  cwd: string;
  client?: McpClient;
  toolNames: string[];
  toolsRegistered: boolean;
  enabled: boolean;
  status: "enabled" | "disabled" | "failed";
  error?: string;
};
type McpConfig = { mcpServers?: Record<string, unknown> };
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type JsonRpcResponse = { id?: number; result?: unknown; error?: { message?: string } };
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an object with string values`);
  }
  return value as Record<string, string>;
}

function parseServerConfig(value: unknown): ServerConfig {
  if (!isRecord(value)) throw new Error("server configuration must be an object");
  const hasCommand = typeof value.command === "string" && value.command.trim().length > 0;
  const hasUrl = typeof value.url === "string" && value.url.trim().length > 0;
  if (hasCommand === hasUrl) throw new Error("server must define exactly one of command (stdio) or url (HTTP)");
  if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error("server cwd must be a string");
  const requestTimeoutMs = value.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    typeof requestTimeoutMs !== "number" ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(`requestTimeoutMs must be an integer between 1000 and ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  const base: BaseServerConfig = {
    env: stringRecord(value.env, "server env"),
    inheritEnv: stringArray(value.inheritEnv, "server inheritEnv"),
    requestTimeoutMs,
    cwd: value.cwd as string | undefined,
  };
  if (hasCommand) return { ...base, command: value.command as string, args: stringArray(value.args, "server args") };
  try {
    const url = new URL(value.url as string);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw new Error("server url must be an absolute http(s) URL");
  }
  return { ...base, url: value.url as string, headers: stringRecord(value.headers, "server headers") };
}

function childEnvironment(server: StdioServerConfig): Record<string, string> {
  // Do not pass all of Pi's ambient credentials to arbitrary MCP processes.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "USERPROFILE"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
  }
  for (const name of server.inheritEnv) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...server.env };
}

function parseMcpTools(result: unknown): McpTool[] {
  if (!isRecord(result) || !Array.isArray(result.tools))
    throw new Error("MCP server returned an invalid tools/list response");
  return result.tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name || !isRecord(tool.inputSchema)) {
      throw new Error("MCP server returned an invalid tool definition");
    }
    if (Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8") > MAX_TOOL_SCHEMA_BYTES) {
      throw new Error("MCP server returned an oversized tool schema");
    }
    if (typeof tool.description === "string" && tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
      throw new Error("MCP server returned an oversized tool description");
    }
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: tool.inputSchema,
    };
  });
}

class StdioMcpClient {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(
    private readonly server: StdioServerConfig,
    private readonly cwd: string,
  ) {}

  async connect() {
    this.process = spawn(this.server.command, this.server.args, {
      cwd: this.cwd,
      env: childEnvironment(this.server),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (data: string) => this.onData(data));
    // Consume stderr so a noisy server cannot block, but do not leak its output to Pi logs.
    this.process.stderr.resume();
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) =>
      this.failAll(new Error(`MCP server exited (${code ?? signal ?? "unknown"})`)),
    );

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-mcp-extension", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    return parseMcpTools(await this.request("tools/list", {}));
  }

  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  close() {
    const child = this.process;
    if (!child || child.killed) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
        return;
      } catch {
        /* fall through */
      }
    }
    child.kill();
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("MCP request cancelled"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (callback: (value: unknown) => void, value: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        callback(value);
      };
      const timeout = setTimeout(
        () => finish(reject, new Error(`MCP ${method} request timed out`)),
        this.server.requestTimeoutMs,
      );
      const abort = () => {
        this.notify("notifications/cancelled", { requestId: id, reason: "Client cancelled the request" });
        finish(reject, new Error("MCP request cancelled"));
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        finish(reject, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown) {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      /* Server has already stopped. */
    }
  }

  private send(message: unknown) {
    if (!this.process?.stdin.writable) throw new Error("MCP server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(data: string) {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_PROTOCOL_BUFFER_BYTES) {
      this.failAll(new Error("MCP server exceeded the maximum protocol message size"));
      this.close();
      return;
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      pending.cleanup();
      if (response.error) pending.reject(new Error(response.error.message ?? "MCP request failed"));
      else pending.resolve(response.result);
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId?: string;
  private closed = false;

  constructor(private readonly server: HttpServerConfig) {}

  async connect() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-mcp-extension", version: "0.1.0" },
    });
    await this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    return parseMcpTools(await this.request("tools/list", {}));
  }

  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  close() {
    this.closed = true;
  }

  private async notify(method: string, params: unknown) {
    await this.request(method, params, undefined, false);
  }

  private async request(method: string, params: unknown, signal?: AbortSignal, includeId = true): Promise<unknown> {
    if (this.closed) throw new Error("MCP server is closed");
    if (signal?.aborted) throw new Error("MCP request cancelled");
    const id = includeId ? this.nextId++ : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`MCP ${method} request timed out`)),
      this.server.requestTimeoutMs,
    );
    const abort = () => controller.abort(new Error("MCP request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers = new Headers(this.server.headers);
      headers.set("Accept", "application/json, text/event-stream");
      headers.set("Content-Type", "application/json");
      if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
      const response = await fetch(this.server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
        signal: controller.signal,
        redirect: "error",
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
      const body = await this.readBody(response);
      if (!response.ok) throw new Error(`MCP HTTP request failed (${response.status})`);
      if (!body.trim()) return undefined;
      const rpc = this.parseResponse(body, response.headers.get("content-type") ?? "", id);
      if (!isRecord(rpc)) throw new Error("MCP server returned an invalid JSON-RPC response");
      if (isRecord(rpc.error))
        throw new Error(typeof rpc.error.message === "string" ? rpc.error.message : "MCP request failed");
      return rpc.result;
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error("MCP request cancelled");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async readBody(response: Response) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let body = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      size += value.byteLength;
      if (size > MAX_PROTOCOL_BUFFER_BYTES) {
        await reader.cancel();
        throw new Error("MCP server exceeded the maximum HTTP response size");
      }
      body += decoder.decode(value, { stream: true });
    }
  }

  private parseResponse(body: string, contentType: string, id: number | undefined): unknown {
    if (!contentType.includes("text/event-stream")) return JSON.parse(body) as unknown;
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const message = JSON.parse(data) as JsonRpcResponse;
      if (id === undefined || message.id === id) return message;
    }
    throw new Error("MCP server sent no response for the request");
  }
}

function createMcpClient(server: ServerConfig, projectCwd: string): McpClient {
  return "command" in server
    ? new StdioMcpClient(server, server.cwd ? resolve(projectCwd, server.cwd) : projectCwd)
    : new HttpMcpClient(server);
}

function encodeNamePart(value: string) {
  let encoded = "";
  for (const character of value) {
    if (/[a-zA-Z0-9-]/.test(character)) {
      encoded += character;
      continue;
    }
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) encoded += `_x${codePoint.toString(16)}_`;
  }
  return encoded;
}

function toolName(server: string, tool: string) {
  return `mcp__${encodeNamePart(server)}__${encodeNamePart(tool)}`;
}

function truncateForModel(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= MAX_TOOL_OUTPUT_BYTES
    ? value
    : `${bytes.subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8")}\n\n[Output truncated at 50KB]`;
}

function formatResult(result: Record<string, unknown>) {
  const content = Array.isArray(result.content)
    ? result.content
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? String((item as { text: unknown }).text)
            : JSON.stringify(item),
        )
        .join("\n")
    : "";
  const output =
    result.structuredContent === undefined
      ? content || "(MCP tool completed without output)"
      : `${content}${content ? "\n\n" : ""}Structured result:\n${JSON.stringify(result.structuredContent, null, 2)}`;
  return truncateForModel(output);
}

export default function (pi: ExtensionAPI) {
  const servers = new Map<string, ManagedServer>();
  const registeredNames = new Set<string>();

  const registerServerTools = (serverName: string, managed: ManagedServer, tools: McpTool[]) => {
    const definitions = tools.map((tool) => {
      if (tool.name.length > MAX_NAME_LENGTH)
        throw new Error(`tool name ${tool.name} exceeds ${MAX_NAME_LENGTH} characters`);
      const name = toolName(serverName, tool.name);
      if (registeredNames.has(name)) throw new Error(`tool name collision: ${name}`);
      registeredNames.add(name);
      return { tool, name };
    });
    managed.toolNames = definitions.map((definition) => definition.name);
    for (const { tool, name } of definitions) {
      pi.registerTool({
        name,
        label: `${serverName}: ${tool.name}`,
        description: tool.description ?? `Call ${tool.name} on MCP server ${serverName}.`,
        parameters: Type.Unsafe(tool.inputSchema),
        async execute(_id, args, signal) {
          if (!managed.enabled || !managed.client) throw new Error(`MCP server ${serverName} is disabled`);
          const result = await managed.client.callTool(tool.name, args, signal);
          if (!isRecord(result)) throw new Error("MCP server returned an invalid tools/call response");
          const text = formatResult(result);
          if (result.isError) throw new Error(text);
          return { content: [{ type: "text", text }], details: { server: serverName, tool: tool.name } };
        },
      });
    }
    managed.toolsRegistered = true;
  };

  const setServerEnabled = async (serverName: string, enabled: boolean) => {
    const server = servers.get(serverName);
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
    if (server.enabled === enabled) return;

    if (enabled) {
      const config = server.config;
      if (!config)
        throw new Error(`MCP server ${serverName} cannot be retried; reload Pi to refresh its configuration`);
      const client = createMcpClient(config, server.cwd);
      try {
        await client.connect();
        const tools = await client.listTools();
        if (server.toolsRegistered) {
          const availableTools = new Set(tools.map((tool) => toolName(serverName, tool.name)));
          if (
            availableTools.size !== server.toolNames.length ||
            server.toolNames.some((name) => !availableTools.has(name))
          ) {
            throw new Error("server tool list changed; reload Pi to refresh MCP tools");
          }
        } else {
          registerServerTools(serverName, server, tools);
        }
        server.client = client;
        server.enabled = true;
        server.status = "enabled";
        server.error = undefined;
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...server.toolNames])]);
      } catch (error) {
        client.close();
        server.client = undefined;
        server.enabled = false;
        server.status = "failed";
        server.error = String(error);
        throw error;
      }
      return;
    }

    server.client?.close();
    server.client = undefined;
    server.enabled = false;
    server.status = "disabled";
    server.error = undefined;
    const disabledTools = new Set(server.toolNames);
    pi.setActiveTools(pi.getActiveTools().filter((name) => !disabledTools.has(name)));
  };

  const serverStatus = ([name, server]: [string, ManagedServer]) =>
    server.status === "failed" ? `failed ${name}: ${server.error ?? "unknown error"}` : `${server.status} ${name}`;

  pi.registerCommand("mcp", {
    description: "List, enable, or disable MCP servers",
    getArgumentCompletions: (prefix) => {
      const [action = "", name = ""] = prefix.trimStart().split(/\s+/, 2);
      if (!prefix.includes(" "))
        return ["list", "enable", "disable", "toggle"]
          .filter((value) => value.startsWith(action))
          .map((value) => ({ value, label: value }));
      if (!["enable", "disable", "toggle"].includes(action)) return null;
      return [...servers.keys()].filter((value) => value.startsWith(name)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!action) {
        if (!ctx.hasUI) {
          console.error(`[mcp-bridge] ${[...servers].map(serverStatus).join("\n") || "No MCP servers configured."}`);
          return;
        }
        const options = [...servers].map(
          ([name, server]) => `${server.status === "enabled" ? "✓" : server.status === "failed" ? "✗" : "○"} ${name}`,
        );
        const selected = await ctx.ui.select("MCP servers (select to toggle)", options);
        if (!selected) return;
        const index = options.indexOf(selected);
        const entry = [...servers][index];
        if (!entry) return;
        const [serverName, server] = entry;
        await setServerEnabled(serverName, !server.enabled);
        ctx.ui.notify(`MCP server ${serverName} ${server.enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (action === "list") {
        const text = [...servers].map(serverStatus).join("\n") || "No MCP servers configured.";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else console.error(`[mcp-bridge] ${text}`);
        return;
      }
      if (!["enable", "disable", "toggle"].includes(action) || rest.length !== 1) {
        throw new Error("Usage: /mcp [list|enable <server>|disable <server>|toggle <server>]");
      }
      const server = servers.get(rest[0]);
      if (!server) throw new Error(`Unknown MCP server: ${rest[0]}`);
      await setServerEnabled(rest[0], action === "toggle" ? !server.enabled : action === "enable");
      if (ctx.hasUI) ctx.ui.notify(`MCP server ${rest[0]} ${server.status}.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) {
      console.error("[mcp-bridge] Not loading .mcp.json because this project is not trusted.");
      return;
    }

    let config: McpConfig;
    try {
      config = JSON.parse(await readFile(join(ctx.cwd, ".mcp.json"), "utf8")) as McpConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[mcp-bridge] Could not load .mcp.json: ${String(error)}`);
      }
      return;
    }
    if (!isRecord(config.mcpServers ?? {})) {
      console.error("[mcp-bridge] Invalid .mcp.json: mcpServers must be an object.");
      return;
    }

    registeredNames.clear();
    for (const tool of pi.getAllTools()) registeredNames.add(tool.name);
    for (const [serverName, rawServer] of Object.entries(config.mcpServers ?? {})) {
      let client: McpClient | undefined;
      let managed: ManagedServer | undefined;
      try {
        if (!serverName || serverName.length > MAX_NAME_LENGTH)
          throw new Error(`server name must be 1-${MAX_NAME_LENGTH} characters`);
        const server = parseServerConfig(rawServer);
        managed = {
          config: server,
          cwd: ctx.cwd,
          toolNames: [],
          toolsRegistered: false,
          enabled: false,
          status: "disabled",
        };
        servers.set(serverName, managed);
        client = createMcpClient(server, ctx.cwd);
        await client.connect();
        const tools = await client.listTools();
        managed.client = client;
        registerServerTools(serverName, managed, tools);
        managed.enabled = true;
        managed.status = "enabled";
        console.error(`[mcp-bridge] Connected ${serverName} (${tools.length} tools).`);
      } catch (error) {
        client?.close();
        if (managed) {
          managed.client = undefined;
          managed.enabled = false;
          managed.status = "failed";
          managed.error = String(error);
        } else if (serverName) {
          servers.set(serverName, {
            cwd: ctx.cwd,
            toolNames: [],
            toolsRegistered: false,
            enabled: false,
            status: "failed",
            error: String(error),
          });
        }
        console.error(`[mcp-bridge] Failed to connect ${serverName}: ${String(error)}`);
      }
    }
  });

  pi.on("session_shutdown", () => {
    for (const server of servers.values()) server.client?.close();
    servers.clear();
  });
}
