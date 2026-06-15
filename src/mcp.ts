import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCPClient } from "@mastra/mcp";
import { runtime } from "./runtime.js";

/**
 * MCP (Model Context Protocol) support. Servers are declared in JSON, connected
 * at startup, and their tools are merged into the agent's tool set — each one
 * routed through iota's permission gate just like the built-in dangerous tools.
 *
 * Config files (merged, project wins over global):
 *   ~/.iota/mcp.json      (global)
 *   <cwd>/.iota/mcp.json  (project)
 *
 * Shape (Claude-Desktop-compatible `mcpServers` key):
 *   {
 *     "mcpServers": {
 *       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *       "github":     { "url": "https://api.example.com/mcp" },
 *       "internal":   { "command": "node", "args": ["server.js"], "trusted": true }
 *     }
 *   }
 * A server marked `"trusted": true` skips the permission prompt.
 */

interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  trusted?: boolean;
}

export interface McpServerInfo {
  name: string;
  trusted: boolean;
  /** Namespaced (`server_tool`) tool names exposed by this server. */
  tools: string[];
  /** Set when the server failed to connect. */
  error?: string;
}

export interface McpHandle {
  client: MCPClient;
  /** Namespaced (`server_tool`) tools, ready to spread into the agent. */
  tools: Record<string, unknown>;
  /** Per-server breakdown for the /mcp command. */
  servers: McpServerInfo[];
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Same defensive input read as the built-in tools (version-tolerant). */
function readInput(raw: any): any {
  return raw && typeof raw === "object" && "context" in raw ? raw.context : raw;
}

function preview(input: any): string {
  if (!input || typeof input !== "object") return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  } catch {
    return "";
  }
}

export function loadMcpConfig(cwd: string): {
  servers: Record<string, ServerConfig>;
  sources: string[];
} {
  const merged: Record<string, ServerConfig> = {};
  const sources: string[] = [];
  for (const file of [
    path.join(os.homedir(), ".iota", "mcp.json"),
    path.join(cwd, ".iota", "mcp.json"),
  ]) {
    const json = readJson(file);
    const servers = json?.mcpServers ?? json?.servers;
    if (servers && typeof servers === "object") {
      Object.assign(merged, servers);
      sources.push(file);
    }
  }
  return { servers: merged, sources };
}

/** Wrap an MCP tool's execute with a UI event + permission gate (in place). */
function gate(name: string, tool: any, trusted: boolean): unknown {
  const orig = tool?.execute?.bind(tool);
  if (!orig) return tool;
  tool.execute = async (...callArgs: any[]) => {
    const input = readInput(callArgs[0]);
    const id = runtime.ui.toolStart(name, preview(input));
    if (!trusted) {
      const ok = await runtime.permissions.check(`mcp:${name}`, `${name} ${preview(input)}`);
      if (!ok) {
        runtime.ui.toolEnd(id, "error", "Denied by user.");
        throw new Error("User denied permission to run this MCP tool.");
      }
    }
    try {
      const out = await orig(...callArgs);
      runtime.ui.toolEnd(id, "done", typeof out === "string" ? out : JSON.stringify(out));
      return out;
    } catch (e: any) {
      runtime.ui.toolEnd(id, "error", e?.message ?? String(e));
      throw e;
    }
  };
  return tool;
}

/**
 * Connect to all configured MCP servers and return their namespaced, gated
 * tools. Returns null when nothing is configured. Servers that fail to connect
 * are reported and skipped — the rest still load.
 */
export async function connectMcp(
  servers: Record<string, ServerConfig>
): Promise<McpHandle | null> {
  const names = Object.keys(servers);
  if (names.length === 0) return null;

  const trusted = new Set(names.filter((n) => servers[n].trusted));
  const defs: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.url) {
      defs[name] = { url: new URL(cfg.url) };
    } else if (cfg.command) {
      defs[name] = { command: cfg.command, args: cfg.args ?? [], env: cfg.env };
    } else {
      console.error(`  MCP server '${name}' has neither command nor url; skipping.`);
    }
  }

  const client = new MCPClient({ id: "iota-mcp", servers: defs });
  const { toolsets, errors } = await client.listToolsetsWithErrors();

  const tools: Record<string, unknown> = {};
  const serverInfos: McpServerInfo[] = [];

  for (const [server, serverTools] of Object.entries(toolsets ?? {})) {
    const isTrusted = trusted.has(server);
    const names: string[] = [];
    for (const [toolName, tool] of Object.entries(serverTools)) {
      const fq = `${server}_${toolName}`;
      tools[fq] = gate(fq, tool, isTrusted);
      names.push(fq);
    }
    serverInfos.push({ name: server, trusted: isTrusted, tools: names });
  }

  for (const [server, message] of Object.entries(errors ?? {})) {
    console.error(`  MCP server '${server}' failed: ${message}`);
    serverInfos.push({ name: server, trusted: trusted.has(server), tools: [], error: message });
  }

  return { client, tools, servers: serverInfos };
}
