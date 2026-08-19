import { readFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };
type McpConfig = { mcpServers?: Record<string, ServerConfig> };
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type JsonRpcResponse = { id?: number; result?: any; error?: { message?: string } };

class StdioMcpClient {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(private readonly server: ServerConfig) {}

  async connect() {
    this.process = spawn(this.server.command, this.server.args ?? [], {
      cwd: process.cwd(),
      env: { ...process.env, ...this.server.env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (data: string) => this.onData(data));
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => this.failAll(new Error(`MCP server exited (${code ?? signal ?? "unknown"})`)));

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-mcp-extension", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    return (await this.request("tools/list", {})).tools ?? [];
  }

  callTool(name: string, args: unknown): Promise<any> {
    return this.request("tools/call", { name, arguments: args });
  }

  close() {
    this.process?.kill();
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown) {
    if (!this.process?.stdin.writable) throw new Error("MCP server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(data: string) {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse;
      try { response = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
      if (typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? "MCP request failed"));
      else pending.resolve(response.result);
    }
  }

  private failAll(error: Error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

function toolName(server: string, tool: string) {
  return `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatResult(result: { content?: unknown; structuredContent?: unknown }) {
  const content = Array.isArray(result.content)
    ? result.content.map((item) => item && typeof item === "object" && "text" in item
      ? String((item as { text: unknown }).text) : JSON.stringify(item)).join("\n")
    : "";
  return result.structuredContent === undefined ? content || "(MCP tool completed without output)"
    : `${content}${content ? "\n\n" : ""}Structured result:\n${JSON.stringify(result.structuredContent, null, 2)}`;
}

export default async function (pi: ExtensionAPI) {
  let config: McpConfig;
  try {
    config = JSON.parse(await readFile(join(process.cwd(), ".mcp.json"), "utf8")) as McpConfig;
  } catch (error) {
    console.error(`[mcp-bridge] Could not load .mcp.json: ${String(error)}`);
    return;
  }

  const clients: StdioMcpClient[] = [];
  for (const [serverName, server] of Object.entries(config.mcpServers ?? {})) {
    try {
      const client = new StdioMcpClient(server);
      await client.connect();
      clients.push(client);
      const tools = await client.listTools();
      for (const tool of tools) {
        pi.registerTool({
          name: toolName(serverName, tool.name),
          label: `${serverName}: ${tool.name}`,
          description: tool.description ?? `Call ${tool.name} on MCP server ${serverName}.`,
          parameters: Type.Unsafe(tool.inputSchema),
          async execute(_id, args, signal) {
            if (signal?.aborted) throw new Error("MCP call cancelled");
            const result = await client.callTool(tool.name, args);
            const text = formatResult(result);
            if (result.isError) throw new Error(text);
            return { content: [{ type: "text", text }], details: { server: serverName, tool: tool.name } };
          },
        });
      }
      console.error(`[mcp-bridge] Connected ${serverName} (${tools.length} tools).`);
    } catch (error) {
      console.error(`[mcp-bridge] Failed to connect ${serverName}: ${String(error)}`);
    }
  }
  pi.on("session_shutdown", () => clients.forEach((client) => client.close()));
}
