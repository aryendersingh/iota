#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { loadContext } from "./context.js";
import { loadMcpConfig, connectMcp } from "./mcp.js";
import { runMcpCli } from "./mcp-cli.js";
import { buildAgent } from "./agent.js";
import { runtime } from "./runtime.js";
import { startRepl } from "./repl.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Subcommands (e.g. `iota mcp add …`) run and exit instead of starting the REPL.
  if (argv[0] === "mcp") {
    process.exit(await runMcpCli(argv.slice(1)));
  }

  const config = loadConfig(argv);

  // Populate the shared runtime that tools read from at execution time.
  runtime.cwd = config.cwd;
  runtime.permissions.setSkipAll(config.yolo);

  // Build the system prompt from default + AGENTS.md/CLAUDE.md/SYSTEM.md.
  const context = loadContext(config.cwd);

  // Connect any configured MCP servers and merge their tools.
  const mcpConfig = loadMcpConfig(config.cwd);
  let mcp = null;
  if (Object.keys(mcpConfig.servers).length) {
    console.log(`  connecting to ${Object.keys(mcpConfig.servers).length} MCP server(s)…`);
    try {
      mcp = await connectMcp(mcpConfig.servers);
    } catch (e: any) {
      console.error(`  MCP connection failed: ${e?.message ?? e}`);
    }
  }

  const agent = buildAgent(config, context.systemPrompt, mcp?.tools ?? {});
  try {
    await startRepl(agent, config, context.files, mcp?.servers ?? []);
  } finally {
    await mcp?.client.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
