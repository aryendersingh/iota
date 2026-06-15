import pc from "picocolors";
import { tools as builtinTools } from "./tools.js";
import type { McpServerInfo } from "./mcp.js";

/** State the slash commands can read. */
export interface CommandContext {
  mcpServers: McpServerInfo[];
}

const HELP: Array<[string, string]> = [
  ["/help", "show this help"],
  ["/tools", "list all available tools (built-in + MCP)"],
  ["/mcp", "list connected MCP servers and their tools"],
  ["exit", "quit iota"],
];

/**
 * Handle a slash command. Returns true if the input was a command (and should
 * not be sent to the agent), false otherwise.
 */
export function runCommand(input: string, ctx: CommandContext): boolean {
  if (!input.startsWith("/")) return false;
  const [cmd] = input.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "help":
      printHelp();
      return true;
    case "tools":
      printTools(ctx);
      return true;
    case "mcp":
      printMcp(ctx);
      return true;
    default:
      console.log(pc.red(`  unknown command: /${cmd}`));
      printHelp();
      return true;
  }
}

function printHelp(): void {
  console.log(pc.bold("\n  commands:"));
  for (const [name, desc] of HELP) {
    console.log(`    ${pc.cyan(name.padEnd(8))} ${pc.dim(desc)}`);
  }
}

function printTools(ctx: CommandContext): void {
  console.log(pc.bold("\n  built-in:"));
  console.log(pc.dim("    " + Object.keys(builtinTools).join(", ")));
  const mcp = ctx.mcpServers.flatMap((s) => s.tools);
  if (mcp.length) {
    console.log(pc.bold("  mcp:"));
    console.log(pc.dim("    " + mcp.join(", ")));
  }
}

function printMcp(ctx: CommandContext): void {
  if (ctx.mcpServers.length === 0) {
    console.log(
      pc.dim(
        "\n  no MCP servers configured. Add ~/.iota/mcp.json or <project>/.iota/mcp.json"
      )
    );
    return;
  }
  console.log("");
  for (const s of ctx.mcpServers) {
    const tag = s.trusted ? pc.green(" (trusted)") : "";
    if (s.error) {
      console.log(pc.bold(`  ${s.name}`) + tag + pc.red(`  ✗ ${s.error}`));
      continue;
    }
    console.log(pc.bold(`  ${s.name}`) + tag + pc.dim(`  ${s.tools.length} tool(s)`));
    for (const t of s.tools) console.log(pc.dim(`    - ${t}`));
  }
}
