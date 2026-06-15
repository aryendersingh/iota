import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";

/**
 * `iota mcp <add|list|remove>` — manage MCP server entries in the JSON config
 * files that `mcp.ts` reads at startup:
 *   ~/.iota/mcp.json       (--scope global)
 *   <cwd>/.iota/mcp.json   (--scope project, default)
 */

interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  trusted?: boolean;
}

type Scope = "project" | "global";

function configFile(scope: Scope, cwd: string): string {
  return scope === "global"
    ? path.join(os.homedir(), ".iota", "mcp.json")
    : path.join(cwd, ".iota", "mcp.json");
}

/** Read a config file. Missing file → empty config; malformed → error (ok:false). */
function loadFile(file: string): { ok: boolean; json: any } {
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (json.servers && !json.mcpServers) {
      json.mcpServers = json.servers;
      delete json.servers;
    }
    return { ok: true, json };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: true, json: {} };
    console.error(pc.red(`  cannot read ${file}: ${e?.message ?? e}`));
    return { ok: false, json: {} };
  }
}

function saveFile(file: string, json: any): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
}

function describe(s: ServerConfig): string {
  const target = s.url ? s.url : [s.command, ...(s.args ?? [])].join(" ");
  return target + (s.trusted ? pc.green(" (trusted)") : "");
}

export async function runMcpCli(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return mcpAdd(rest);
    case "list":
    case "ls":
      return mcpList(rest);
    case "remove":
    case "rm":
      return mcpRemove(rest);
    default:
      printHelp();
      return sub ? 1 : 0;
  }
}

function printHelp(): void {
  console.log(`
${pc.bold("iota mcp")} — manage MCP servers

  ${pc.cyan("iota mcp add <name> [opts] -- <command> [args...]")}   add a stdio server
  ${pc.cyan("iota mcp add <name> --url <url> [opts]")}              add a remote server
  ${pc.cyan("iota mcp list")}                                       list configured servers
  ${pc.cyan("iota mcp remove <name> [opts]")}                       remove a server

  options:
    --scope project|global   where to write (default: project)
    --global                 shorthand for --scope global
    --cwd <dir>              project dir for project scope (default: cwd)
    --env KEY=VALUE          env var for a stdio server (repeatable)
    --trusted               skip the permission prompt for this server's tools

  examples:
    iota mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
    iota mcp add github --url https://api.example.com/mcp
    iota mcp add internal --trusted --env API_KEY=xyz -- node server.js
`);
}

interface CommonOpts {
  scope: Scope;
  cwd: string;
}

/** Pull --scope/--global/--cwd out of a token list, returning the rest. */
function takeCommon(tokens: string[]): { opts: CommonOpts; rest: string[] } {
  const opts: CommonOpts = { scope: "project", cwd: process.cwd() };
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === "--global") opts.scope = "global";
    else if (a === "--scope") opts.scope = (tokens[++i] as Scope) ?? "project";
    else if (a === "--cwd") opts.cwd = path.resolve(tokens[++i] ?? ".");
    else rest.push(a);
  }
  return { opts, rest };
}

function mcpAdd(args: string[]): number {
  const sepIdx = args.indexOf("--");
  const head = sepIdx === -1 ? args : args.slice(0, sepIdx);
  const cmdParts = sepIdx === -1 ? [] : args.slice(sepIdx + 1);

  const { opts, rest } = takeCommon(head);

  let name: string | undefined;
  let url: string | undefined;
  let trusted = false;
  const env: Record<string, string> = {};

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--url") url = rest[++i];
    else if (a === "--trusted") trusted = true;
    else if (a === "--env") {
      const kv = rest[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq <= 0) {
        console.error(pc.red(`  --env expects KEY=VALUE, got '${kv}'`));
        return 1;
      }
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (!a.startsWith("--") && !name) {
      name = a;
    } else {
      console.error(pc.red(`  unknown option: ${a}`));
      return 1;
    }
  }

  if (!name) {
    console.error(pc.red("  usage: iota mcp add <name> [--url <url> | -- <command> [args...]]"));
    return 1;
  }

  const server: ServerConfig = {};
  if (url && cmdParts.length) {
    console.error(pc.red("  provide either --url or a -- <command>, not both"));
    return 1;
  } else if (url) {
    server.url = url;
  } else if (cmdParts.length) {
    server.command = cmdParts[0];
    if (cmdParts.length > 1) server.args = cmdParts.slice(1);
  } else {
    console.error(pc.red("  provide either --url <url> or -- <command> [args...]"));
    return 1;
  }
  if (Object.keys(env).length) server.env = env;
  if (trusted) server.trusted = true;

  const file = configFile(opts.scope, opts.cwd);
  const { ok, json } = loadFile(file);
  if (!ok) return 1;

  const existed = Boolean(json.mcpServers?.[name]);
  json.mcpServers = { ...(json.mcpServers ?? {}), [name]: server };
  saveFile(file, json);

  console.log(
    pc.green(`  ${existed ? "updated" : "added"}`) +
      ` MCP server '${pc.bold(name)}' (${opts.scope}) → ${describe(server)}`
  );
  console.log(pc.dim(`  ${file}`));
  return 0;
}

function mcpList(args: string[]): number {
  const { opts } = takeCommon(args);
  let any = false;
  for (const scope of ["global", "project"] as Scope[]) {
    const file = configFile(scope, opts.cwd);
    const { json } = loadFile(file);
    const servers: Record<string, ServerConfig> = json.mcpServers ?? {};
    const names = Object.keys(servers);
    console.log(pc.bold(`\n  ${scope}`) + pc.dim(`  ${file}`));
    if (!names.length) {
      console.log(pc.dim("    (none)"));
      continue;
    }
    any = true;
    for (const n of names) console.log(`    ${n}  ${pc.dim("→")} ${describe(servers[n])}`);
  }
  if (!any) console.log(pc.dim("\n  No MCP servers configured. Add one with: iota mcp add …"));
  return 0;
}

function mcpRemove(args: string[]): number {
  const { opts, rest } = takeCommon(args);
  const name = rest.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error(pc.red("  usage: iota mcp remove <name> [--scope project|global]"));
    return 1;
  }
  const file = configFile(opts.scope, opts.cwd);
  const { ok, json } = loadFile(file);
  if (!ok) return 1;
  if (!json.mcpServers?.[name]) {
    console.error(pc.red(`  no MCP server '${name}' in ${opts.scope} config (${file})`));
    return 1;
  }
  delete json.mcpServers[name];
  saveFile(file, json);
  console.log(pc.green(`  removed`) + ` MCP server '${pc.bold(name)}' (${opts.scope})`);
  return 0;
}
