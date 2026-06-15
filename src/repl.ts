import { createInterface } from "node:readline";
import pc from "picocolors";
import type { Agent } from "@mastra/core/agent";
import { runtime } from "./runtime.js";
import type { Config } from "./config.js";
import type { McpServerInfo } from "./mcp.js";
import { runCommand } from "./commands.js";

export async function startRepl(
  agent: Agent,
  config: Config,
  loadedFiles: string[] = [],
  mcpServers: McpServerInfo[] = []
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Resolve a pending question on stdin EOF so piped input doesn't hang.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      if (closed) return resolve("");
      let settled = false;
      const onClose = () => {
        if (!settled) {
          settled = true;
          resolve("");
        }
      };
      rl.once("close", onClose);
      rl.question(q, (answer) => {
        settled = true;
        rl.off("close", onClose);
        resolve(answer);
      });
    });

  // Share the single readline instance with the permission prompts.
  runtime.permissions.setAsk(ask);

  let aborter: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (aborter) {
      aborter.abort();
    } else {
      rl.close();
      process.exit(0);
    }
  });

  console.log(
    pc.bold(pc.magenta("\n  iota")) +
      pc.dim(`  ${config.model}  ·  thread:${config.thread}`)
  );
  if (loadedFiles.length) {
    console.log(pc.dim(`  context: ${loadedFiles.join(", ")}`));
  }
  const mcpToolCount = mcpServers.reduce((n, s) => n + s.tools.length, 0);
  if (mcpServers.length) {
    console.log(
      pc.dim(
        `  mcp: ${mcpToolCount} tool(s) across ${mcpServers.length} server(s) — /mcp to list`
      )
    );
  }
  console.log(
    pc.dim("  /help for commands. Memory persists in ./.iota. Ctrl-C interrupts, 'exit' quits.\n")
  );

  while (true) {
    const input = (await ask(pc.green("\n› "))).trim();
    if (closed) break;
    if (!input) continue;
    if (input === "exit" || input === "quit") break;
    if (runCommand(input, { mcpServers })) continue;

    aborter = new AbortController();
    try {
      // Mastra loads/saves this thread's history + working memory automatically.
      const stream = await agent.stream(input, {
        memory: { resource: config.resource, thread: config.thread },
        abortSignal: aborter.signal,
      } as any);

      for await (const chunk of stream.textStream) {
        process.stdout.write(chunk);
      }
      process.stdout.write("\n");
    } catch (e: any) {
      if (aborter.signal.aborted || e?.name === "AbortError") {
        process.stdout.write(pc.yellow("\n  (interrupted)\n"));
      } else {
        process.stdout.write(pc.red(`\n  Error: ${e?.message ?? e}\n`));
      }
    } finally {
      aborter = null;
    }
  }

  rl.close();
  console.log(pc.dim("\n  bye\n"));
}
