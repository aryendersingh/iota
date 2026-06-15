import { createInterface } from "node:readline";
import pc from "picocolors";
import type { Agent } from "@mastra/core/agent";
import { store } from "./ui/store.js";
import { runtime } from "./runtime.js";
import { runCommand } from "./commands.js";
import type { Config } from "./config.js";
import type { McpServerInfo } from "./mcp.js";

export interface Session {
  /** Returns "quit" when the session should end. */
  submit(text: string): Promise<"quit" | void>;
  interrupt(): void;
}

/** Drive a turn through the Ink store. */
export function createSession(
  agent: Agent,
  config: Config,
  mcpServers: McpServerInfo[]
): Session {
  let aborter: AbortController | null = null;

  return {
    async submit(text) {
      if (text === "exit" || text === "quit") return "quit";
      if (text.startsWith("/")) {
        const res = runCommand(text, { mcpServers });
        if (res.action === "quit") return "quit";
        if (res.action === "handled") store.pushSystem(res.output);
        return;
      }

      store.addUser(text);
      store.beginTurn();
      aborter = new AbortController();
      try {
        const stream = await agent.stream(text, {
          memory: { resource: config.resource, thread: config.thread },
          abortSignal: aborter.signal,
        } as any);
        for await (const chunk of stream.textStream) store.appendDelta(chunk);
      } catch (e: any) {
        if (aborter.signal.aborted || e?.name === "AbortError") {
          store.pushSystem({ body: "(interrupted)", tone: "info" });
        } else {
          store.pushSystem({ title: "Error", body: e?.message ?? String(e), tone: "error" });
        }
      } finally {
        store.endTurn();
        aborter = null;
      }
    },
    interrupt() {
      aborter?.abort();
    },
  };
}

/**
 * Plain-text fallback for non-TTY stdin (pipes/CI), where Ink can't run. Reuses
 * the same agent/commands but prints directly and wires a readline-based
 * permission prompt + tool sink.
 */
export async function runHeadless(
  agent: Agent,
  config: Config,
  mcpServers: McpServerInfo[]
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
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

  runtime.ui = {
    toolStart(name, detail) {
      process.stdout.write(
        pc.cyan(`\n  ⏺ ${name}`) + pc.dim(detail ? ` · ${detail}` : "") + "\n"
      );
      return "";
    },
    toolEnd(_id, status, result) {
      const color = status === "error" ? pc.red : pc.dim;
      const lines = result
        .split("\n")
        .slice(0, 8)
        .map((l) => "    " + l)
        .join("\n");
      process.stdout.write(color(lines) + "\n");
    },
  };
  runtime.permissions.setRequester(async (summary) => {
    const ans = (await ask(pc.yellow(`  allow ${summary}? [y/n/a] `)))
      .trim()
      .toLowerCase();
    return ans === "a" ? "always" : ans === "y" || ans === "yes" ? "yes" : "no";
  });

  let aborter: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (aborter) aborter.abort();
    else {
      rl.close();
      process.exit(0);
    }
  });

  while (true) {
    const input = (await ask(pc.green("\n› "))).trim();
    if (closed) break;
    if (!input) continue;
    if (input === "exit" || input === "quit") break;
    if (input.startsWith("/")) {
      const res = runCommand(input, { mcpServers });
      if (res.action === "quit") break;
      if (res.action === "handled") {
        if (res.output.title) process.stdout.write("\n  " + pc.bold(res.output.title) + "\n");
        process.stdout.write(
          res.output.body.split("\n").map((l) => "  " + l).join("\n") + "\n"
        );
      }
      continue;
    }

    aborter = new AbortController();
    try {
      const stream = await agent.stream(input, {
        memory: { resource: config.resource, thread: config.thread },
        abortSignal: aborter.signal,
      } as any);
      for await (const chunk of stream.textStream) process.stdout.write(chunk);
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
}
