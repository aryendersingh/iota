import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type ProviderName = "anthropic" | "openai";

export interface Config {
  /** Mastra model-router string, e.g. "anthropic/claude-opus-4-8". */
  model: string;
  provider: ProviderName;
  cwd: string;
  yolo: boolean;
  /** Memory owner (stable across runs so threads persist). */
  resource: string;
  /** Conversation thread id; reused across runs unless --new is passed. */
  thread: string;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
};

/** Minimal .env loader so users don't need an extra dependency. */
function loadDotenv(cwd: string): void {
  let text: string;
  try {
    text = readFileSync(path.join(cwd, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yolo" || a === "--dangerously-skip-permissions") flags.yolo = true;
    else if (a === "--new") flags.new = true;
    else if (a === "--provider") flags.provider = argv[++i] ?? "";
    else if (a === "--model") flags.model = argv[++i] ?? "";
    else if (a === "--cwd") flags.cwd = argv[++i] ?? "";
    else if (a === "--thread") flags.thread = argv[++i] ?? "";
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v ?? true;
    }
  }
  return flags;
}

export function loadConfig(argv: string[]): Config {
  loadDotenv(process.cwd());
  const flags = parseFlags(argv);

  const provider = (flags.provider ||
    process.env.IOTA_PROVIDER ||
    "anthropic") as ProviderName;

  // --model may be a bare name ("gpt-4o") or a full router string ("openai/gpt-4o").
  const modelFlag = (flags.model as string) || process.env.IOTA_MODEL || "";
  let model: string;
  if (modelFlag.includes("/")) {
    model = modelFlag;
  } else {
    const name = modelFlag || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
    model = `${provider}/${name}`;
  }

  return {
    model,
    provider,
    cwd: flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd(),
    yolo: Boolean(flags.yolo),
    resource: process.env.IOTA_RESOURCE || "local",
    thread: flags.new
      ? randomUUID()
      : (flags.thread as string) || process.env.IOTA_THREAD || "main",
  };
}
