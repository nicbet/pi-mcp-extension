import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";

type RegisteredTool = { name: string; execute: (id: string, args: unknown, signal?: AbortSignal) => Promise<unknown> };

function createPi() {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools: RegisteredTool[] = [];
  let activeTools: string[] = [];
  return {
    handlers,
    commands,
    tools,
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
      activeTools = [...activeTools, tool.name];
    },
    getAllTools() {
      return tools.map((tool) => ({ name: tool.name }));
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
  };
}

async function start(pi: ReturnType<typeof createPi>, cwd: string) {
  await pi.handlers.get("session_start")?.[0]({}, { cwd, isProjectTrusted: () => true, hasUI: false });
}

async function stop(pi: ReturnType<typeof createPi>) {
  await pi.handlers.get("session_shutdown")?.[0]({}, {});
}

const stdioServer = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result = {};
    if (message.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    if (message.method === "tools/call") result = { content: [{ type: "text", text: message.params.arguments.message }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`;

test("loads stdio tools and /mcp disables then reconnects a server", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
  const pi = createPi();
  extension(pi as any);
  try {
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { local: { command: process.execPath, args: ["-e", stdioServer] } },
      }),
    );
    await start(pi, cwd);

    expect(pi.tools.map((tool) => tool.name)).toEqual(["mcp__local__echo"]);
    await expect(pi.tools[0]!.execute("call", { message: "hello" })).resolves.toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });

    await pi.commands.get("mcp").handler("disable local", { hasUI: false });
    expect(pi.getActiveTools()).not.toContain("mcp__local__echo");
    await pi.commands.get("mcp").handler("enable local", { hasUI: false });
    expect(pi.getActiveTools()).toContain("mcp__local__echo");
  } finally {
    await stop(pi);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("does nothing when .mcp.json is absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
  const pi = createPi();
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  extension(pi as any);
  try {
    await start(pi, cwd);
    expect(pi.tools).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    console.error = originalError;
    await stop(pi);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects ambiguous server transport configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
  const pi = createPi();
  extension(pi as any);
  try {
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          invalid: { command: "node", url: "https://mcp.example.com/mcp" },
        },
      }),
    );
    await start(pi, cwd);
    expect(pi.tools).toEqual([]);
  } finally {
    await stop(pi);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loads Streamable HTTP tools and forwards bearer authorization", async () => {
  let authorization = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      authorization = request.headers.get("authorization") ?? "";
      return request.json().then((message: any) => {
        let result: unknown = {};
        if (message.method === "tools/list") result = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
        if (message.method === "tools/call") result = { content: [{ type: "text", text: "pong" }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
          headers: { "content-type": "application/json", "mcp-session-id": "test-session" },
        });
      });
    },
  });
  const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-test-"));
  const pi = createPi();
  extension(pi as any);
  try {
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { url: server.url.toString(), headers: { Authorization: "Bearer test-token" } } },
      }),
    );
    await start(pi, cwd);

    expect(pi.tools.map((tool) => tool.name)).toEqual(["mcp__remote__ping"]);
    await expect(pi.tools[0]!.execute("call", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "pong" }],
    });
    expect(authorization).toBe("Bearer test-token");
  } finally {
    await stop(pi);
    server.stop(true);
    await rm(cwd, { recursive: true, force: true });
  }
});
