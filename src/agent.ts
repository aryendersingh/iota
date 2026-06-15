import { mkdirSync } from "node:fs";
import path from "node:path";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { tools } from "./tools.js";
import type { Config } from "./config.js";

export function buildAgent(
  config: Config,
  systemPrompt: string,
  mcpTools: Record<string, unknown> = {}
): Agent {
  // LibSQL persists conversation history + working memory to a file per project.
  const dbDir = path.join(config.cwd, ".iota");
  mkdirSync(dbDir, { recursive: true });

  const memory = new Memory({
    storage: new LibSQLStore({
      id: "iota-memory",
      url: `file:${path.join(dbDir, "memory.db")}`,
    }),
    options: {
      lastMessages: 30,
      workingMemory: { enabled: true },
    },
  });

  return new Agent({
    id: "iota",
    name: "iota",
    instructions: systemPrompt,
    model: config.model,
    tools: { ...tools, ...mcpTools } as typeof tools,
    memory,
  });
}
