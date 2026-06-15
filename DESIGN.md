# iota — Design

This document describes how the iota coding harness works: its architecture, the
flow of a single turn, and the responsibility of each module. iota is a
terminal REPL where you talk to an LLM agent that can read/edit files and run
commands in your project, with persistent memory, project context files
(`AGENTS.md`), and gated tool use. It is built on [Mastra](https://mastra.ai),
which provides the agent loop, tool execution, model routing, and memory; iota
supplies the terminal UI, the tool implementations, the context-file loader, and
the permission layer.

---

## 1. Design goals

- **Thin over Mastra.** Let the framework own the hard parts (the tool-call loop,
  streaming, provider routing, memory persistence). iota is the parts a framework
  can't give you: the terminal experience, the project tools, and a human
  permission gate.
- **Multi-provider.** Switch between Anthropic and OpenAI with a flag; no
  per-provider code in iota — Mastra's model router handles it.
- **Persistent, per-project memory.** Conversations and learned facts survive
  across runs, stored locally per project.
- **Safe by default.** Anything that writes files or runs commands asks first,
  unless explicitly disabled.

---

## 2. High-level architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  index.ts  — entry point                                             │
│   loadConfig → loadContext → connectMcp → buildAgent → startRepl     │
└───────┬───────────────────────────────────┬────────────────────────┘
        │ builds systemPrompt               │ shares { cwd, permissions }
┌───────▼──────────────────────┐    ┌───────▼──────────────────┐
│  context.ts                  │    │  runtime.ts (singleton)  │
│  AGENTS.md / CLAUDE.md /     │    │  { cwd, permissions }    │
│  SYSTEM.md  → systemPrompt   │    └───────────┬──────────────┘
└───────┬──────────────────────┘                │ read by tools
        │ instructions                           │ at execute time
        │       ┌───────────────────────┐        │
        │       │   repl.ts             │        │
        │       │  readline loop        │        │
        │       │  /cmds → commands.ts  │        │
        │       └───────────┬───────────┘        │
        │   agent.stream(input,                  │
        │     {memory:{resource,thread}})        │
┌───────▼────────────────────────────────────┐  │
│              Mastra Agent (agent.ts)         │  │
│  ┌────────────┐  ┌────────────────┐          │  │
│  │ model      │  │ Memory (LibSQL)│          │  │
│  │ router     │  │ history +      │          │  │
│  │ anthropic/ │  │ working memory │          │  │
│  │ openai     │  │ ./.iota/*.db   │          │  │
│  └────────────┘  └────────────────┘          │  │
│  ┌────────────────────────────────┐          │  │
│  │ tools: read/write/edit/bash/   │◀─────────┼──┘
│  │   grep/glob/ls (tools.ts)      │          │
│  │   + MCP server_tool (mcp.ts)   │          │
│  └───────────────┬────────────────┘          │
└──────────────────┼───────────────────────────┘
                   │ dangerous tools call
           ┌───────▼─────────┐
           │ permissions.ts  │  prompts via shared readline
           └─────────────────┘
```

Key idea: **Mastra runs the loop, iota runs the edges.** The Agent decides when
to call tools and feeds results back to the model on its own. iota only injects
behavior at three seams — inside each tool's `execute` (banners + permission
gate), around the stream (the REPL UI), and before the stream (slash commands,
which short-circuit to `commands.ts` and never reach the model).

---

## 3. Module responsibilities

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point. Loads config + context, connects MCP, fills the `runtime` singleton, builds the agent, starts the REPL, disconnects MCP on exit. |
| `src/config.ts` | Parses flags/env, loads `.env`, builds the model-router string, picks memory thread/resource ids. |
| `src/context.ts` | Builds the system prompt from a default base plus AGENTS.md/CLAUDE.md/SYSTEM.md context files. |
| `src/agent.ts` | Constructs the Mastra `Agent`: instructions, model, tools, and a LibSQL-backed `Memory`. |
| `src/tools.ts` | The seven built-in tools as Mastra `createTool` definitions, wrapped by a shared `defineTool()` helper. |
| `src/mcp.ts` | Loads MCP server config, connects via Mastra `MCPClient`, and merges their (permission-gated) tools. |
| `src/mcp-cli.ts` | The `iota mcp add/list/remove` subcommand that edits the `mcp.json` config files. |
| `src/runtime.ts` | Module-level singleton (`cwd`, `permissions`) that tools read at execution time. |
| `src/permissions.ts` | Interactive y/n/always gate for dangerous tools, with a session allowlist. |
| `src/repl.ts` | The readline loop: reads input, dispatches slash commands, streams the agent's response, handles Ctrl-C/EOF. |
| `src/commands.ts` | Slash commands (`/help`, `/tools`, `/mcp`) handled locally without calling the model. |
| `src/ui/render.ts` | Terminal rendering: tool-call banners, result previews, errors. |

---

## 4. The lifecycle of a turn

> **Startup (once).** Before the loop, `index.ts` calls `loadContext(cwd)` to
> assemble the system prompt from the default base plus any `AGENTS.md` /
> `CLAUDE.md` / `SYSTEM.md` files (§6), then `buildAgent(config, systemPrompt)`.
> The loaded file paths are shown in the banner.

1. **Input.** The REPL (`repl.ts`) reads a line from the prompt via `readline`.
   `exit`/`quit` (and stdin EOF) ends the session; empty lines are ignored. A line
   starting with `/` is dispatched to `commands.ts` (`runCommand`) and handled
   locally — `/help`, `/tools`, `/mcp` — without ever calling the model.

2. **Stream start.** The REPL calls:
   ```ts
   const stream = await agent.stream(input, {
     memory: { resource: config.resource, thread: config.thread },
     abortSignal: aborter.signal,
   });
   ```
   Mastra loads the thread's recent history and working memory, prepends the
   system instructions (assembled at startup by `context.ts`), and sends
   everything to the routed model.

3. **Model streams.** The REPL consumes `stream.textStream` and writes deltas
   straight to stdout, so the user sees the response token by token.

4. **Tool calls (handled by Mastra).** When the model requests a tool, Mastra
   validates the arguments against the tool's `inputSchema` and invokes its
   `execute`. Inside `execute` (via the `defineTool` wrapper) iota:
   - prints a banner — `⏺ edit(src/foo.ts)` — via `ui.renderToolCall`,
   - for **dangerous** tools (`write`, `edit`, `bash`), calls
     `runtime.permissions.check(...)` and aborts with a denial message if refused,
   - runs the tool body against `runtime.cwd`,
   - previews the result and returns `{ result }`.
   Mastra feeds the result back to the model and the loop continues — more text,
   more tools — until the model stops calling tools.

5. **Persist.** Mastra writes the new messages (and any working-memory updates)
   to LibSQL under this `resource`/`thread`. Nothing extra is needed from iota.

6. **Done.** The REPL prints a trailing newline and loops back to step 1. The
   next turn automatically sees the updated memory.

### Interrupt & EOF handling
The REPL installs a `SIGINT` handler. During a turn, Ctrl-C calls
`aborter.abort()`, which cancels the Mastra stream (surfaced as an interrupt
message); at an idle prompt, Ctrl-C exits. Each turn gets a fresh
`AbortController`.

Stdin **EOF** is handled too: `ask()` races `readline`'s `close` event against
the question callback, so a closed stream resolves the pending prompt and the
loop breaks (`if (closed) break`) instead of hanging — `echo "hi" | iota` exits
cleanly rather than blocking forever.

---

## 5. Tools

Each tool is a Mastra `createTool` with an `id`, `description`, a Zod
`inputSchema`, and an `execute`. iota wraps them in `defineTool()` so every tool
shares the same cross-cutting behavior in one place:

```
defineTool({ id, description, risk?, schema, summarize, permKey?, run })
   └─ createTool({
        id, description, inputSchema: schema, outputSchema: { result: string },
        execute: async (raw) => {
          args = readInput(raw)             // version-tolerant input extraction
          renderToolCall(summarize(args))   // banner
          if risk === "dangerous":          // permission gate
            if !permissions.check(permKey, summary): return denial
          try   result = await run(args); renderToolResult(result); return {result}
          catch return { result: "Error: …" }  // never throw out of the loop
      })
```

This keeps each tool body (`run`) a small, pure function while banners,
permissions, error handling, and the Mastra wiring live once in the wrapper.

| Tool | Risk | Notes |
| --- | --- | --- |
| `read` | safe | Returns file contents with line numbers; supports offset/limit. |
| `ls` | safe | Lists a directory (dirs shown with trailing `/`). |
| `glob` | safe | File-name matching; ignores `node_modules`/`.git`. |
| `grep` | safe | Content search; uses ripgrep if installed, else a JS fallback. |
| `write` | dangerous | Creates/overwrites a file (makes parent dirs). |
| `edit` | dangerous | Exact-string replace; unique match required unless `replace_all`. |
| `bash` | dangerous | Runs a shell command with a timeout and bounded output. |

Tool names the model sees come from the **keys** of the `tools` object passed to
the Agent (`{ read, write, edit, … }`).

### Why the `runtime` singleton
Mastra hands a tool's `execute` only its validated input — it has no reference to
iota's CLI state. Tools need two things from that state: the working directory
and the permission prompt. Rather than thread these through Mastra's context,
iota keeps a tiny module-level `runtime = { cwd, permissions }`, populated once at
startup in `index.ts`. Tools import it directly. This is the deliberate coupling
that lets tool bodies stay simple.

### MCP tools (`mcp.ts`)
External [MCP](https://modelcontextprotocol.io) servers extend the tool set
without any code change. At startup `index.ts`:

1. `loadMcpConfig(cwd)` reads `~/.iota/mcp.json` then `<cwd>/.iota/mcp.json` and
   merges them (project wins). Each server is **stdio** (`command`/`args`/`env`)
   or **remote** (`url`), with an optional `trusted` flag.
2. `connectMcp(servers)` builds a Mastra `MCPClient` and calls
   `listToolsetsWithErrors()` — resilient: a server that fails to connect is
   reported and skipped, the rest still load.
3. Each returned tool is **namespaced** `server_tool` and **gated**: `gate()`
   wraps its `execute` in place to print a banner and, unless the server is
   `trusted`, run the same `permissions.check` used by built-in tools (keyed
   `mcp:<name>`). On denial it throws, which Mastra reports back to the model.
4. The gated tools are spread into the Agent's `tools` alongside the built-ins
   (`{ ...tools, ...mcpTools }`), so the model sees one flat tool set.

The `MCPClient` is disconnected in a `finally` when the REPL exits. Because MCP
tools arrive pre-built from Mastra (not through `defineTool`), `gate()` is the MCP
analogue of the `defineTool` wrapper — it re-applies iota's banner + permission
concerns to tools it didn't define.

---

## 6. Memory

Memory is Mastra's, backed by **LibSQL** persisted to `./.iota/memory.db` — one
database per project directory.

```ts
new Memory({
  storage: new LibSQLStore({ id: "iota-memory", url: "file:./.iota/memory.db" }),
  options: { lastMessages: 30, workingMemory: { enabled: true } },
})
```

- **Conversation history** — the last 30 messages of the active thread are
  reloaded every turn, so context survives across runs.
- **Working memory** — a durable scratchpad the agent maintains about the user and
  project (stack, conventions, goals), persisted between sessions. The system
  instructions explicitly ask the agent to use it.
- **Threads & resources** — every call passes `{ resource, thread }`. The
  `resource` is the owner (default `local`); the `thread` is the conversation
  (default `main`). Same pair ⇒ same remembered history. `--thread <id>` switches
  conversations and `--new` starts a fresh one.
- **Semantic recall** (vector search over old messages) is **off** by default
  because it needs a vector store and an embedding model. It can be enabled in
  `agent.ts`.

### Project context files (the standing half of memory)
Separate from conversational memory, `context.ts` assembles the system prompt at
startup from pi-style files, so a project carries its own durable instructions:

- **`AGENTS.md` / `CLAUDE.md`** — loaded from the global dir (`~/.iota/`), then
  every ancestor directory down to the cwd, then the cwd. All matches concatenate,
  most-specific last, under a header marking them authoritative.
- **`.iota/SYSTEM.md`** — replaces the default base prompt (project over global).
- **`.iota/APPEND_SYSTEM.md`** — appended last (global, then project).

The loaded paths are returned to the REPL and shown in the banner. This is the
"remembered facts you own as files" complement to Mastra's DB-backed memory.

---

## 7. Configuration & model routing

`config.ts` resolves settings from flags, then environment, then defaults:

- **Model string.** Mastra's model router takes a `provider/name` string. A
  `--model` containing `/` is used verbatim; a bare name is combined with
  `--provider` (e.g. `--provider openai --model gpt-4o` ⇒ `openai/gpt-4o`).
  Defaults: `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`.
- **API keys.** Read from the environment (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`),
  loaded from a project `.env` by a minimal built-in loader. Mastra routes to the
  matching provider and surfaces a clear error if the key is missing.
- **Other flags.** `--cwd` sets the working directory; `--yolo` /
  `--dangerously-skip-permissions` bypass all prompts; `--thread` / `--new`
  control memory threading.

---

## 8. Permissions

`PermissionManager` gates the three dangerous tools. On the first dangerous call
of a given **kind**, it prompts via the REPL's shared readline:

```
permission required: bash(npm test)
allow? [y]es / [n]o / [a]lways this kind:
```

- `y` allows once, `n` denies (the tool returns a denial the model can react to),
  `a` adds the kind to a session allowlist so it won't ask again.
- The allowlist **key** is the tool id, except `bash`, which is keyed by the first
  word of the command (`bash:npm`) so "always" is scoped to that command family
  rather than all shell access.
- `--yolo` short-circuits every check. The allowlist is in-memory and resets each
  run.

The manager shares the REPL's single `readline` interface (wired via `setAsk`),
so prompts and the main input loop never fight over stdin.

---

## 9. Boundaries & extension points

- **Add a tool:** write a `defineTool({...})` in `tools.ts` and add it to the
  exported `tools` object. Permission/banner/error handling come for free.
- **Add an MCP server:** run `iota mcp add <name> -- <command> [args...]` (or
  `--url`), which writes `~/.iota/mcp.json` or `<project>/.iota/mcp.json`. No code
  change; its tools appear namespaced and gated on the next run. `iota mcp` is a
  subcommand intercepted in `index.ts` before the REPL starts (`mcp-cli.ts`).
- **Add a slash command:** add a `case` to `runCommand` in `commands.ts`. It runs
  locally and never reaches the model; extend `CommandContext` if it needs more
  state.
- **Add a provider:** nothing in iota — pass a different `provider/name`; Mastra's
  router handles it (given the right API key).
- **Enable semantic recall:** add a vector store + embedder to the `Memory` config
  in `agent.ts`.
- **Richer tool UI:** the REPL currently renders `textStream`; switching to
  Mastra's `fullStream` would expose structured tool-call/step events for fancier
  rendering.

### Current limitations
- Tool-call display comes from banners the tools print themselves (simple and
  version-robust), not from the model stream's structured events.
- No context compaction beyond `lastMessages: 30`; very long threads rely on that
  window plus working memory rather than summarization.
- Permission "always" approvals are session-scoped, not persisted. MCP tools reuse
  the same gate rather than Mastra's native `RequireToolApproval` hook.
- Slash commands are inspect-only (`/help`, `/tools`, `/mcp`); none mutate session
  state yet (e.g. switching thread or model mid-run).
- The REPL is interactive-first: piping a multi-line command script in at once is
  not reliably executed line-by-line (it exits at EOF rather than hanging).
