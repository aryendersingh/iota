#!/usr/bin/env node
import { createElement } from "react";
import { loadConfig } from "./config.js";
import { loadContext } from "./context.js";
import { loadMcpConfig, connectMcp } from "./mcp.js";
import { runMcpCli } from "./mcp-cli.js";
import { buildAgent } from "./agent.js";
import { runtime } from "./runtime.js";
import { listShells, onShellsChange, killAll } from "./shells.js";
import { createSession, runHeadless } from "./session.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Subcommands (e.g. `iota mcp add …`) run and exit instead of starting a session.
  if (argv[0] === "mcp") {
    process.exit(await runMcpCli(argv.slice(1)));
  }

  const config = loadConfig(argv);
  runtime.cwd = config.cwd;
  runtime.permissions.setSkipAll(config.yolo);

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
  const mcpServers = mcp?.servers ?? [];

  try {
    if (process.stdin.isTTY) {
      // Interactive Ink TUI.
      const { store } = await import("./ui/store.js");
      const { App } = await import("./ui/app.js");
      const { render } = await import("ink");

      store.init(config.model, config.thread);
      runtime.ui = store;
      runtime.permissions.setRequester((summary) => store.requestPermission(summary));
      onShellsChange(() => store.setShells(listShells()));

      const session = createSession(agent, config, mcpServers);
      const mcpToolCount = mcpServers.reduce((n, s) => n + s.tools.length, 0);
      const header = {
        model: config.model,
        thread: config.thread,
        context: context.files.join(", ") || undefined,
        mcp: mcpToolCount
          ? `mcp: ${mcpToolCount} tool(s) across ${mcpServers.length} server(s)`
          : undefined,
      };

      const app = render(createElement(App, { session, header }), {
        exitOnCtrlC: false,
      });
      await app.waitUntilExit();
    } else {
      // Non-TTY (pipes/CI): plain-text fallback.
      await runHeadless(agent, config, mcpServers);
    }
  } finally {
    killAll();
    await mcp?.client.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
