# iota — Design

This document describes how the iota coding harness works: its architecture, the
flow of a single turn, and the responsibility of each module. iota is a terminal
chat app where you talk to an LLM agent that can read/edit files and run commands
in your project, with persistent memory, project context files (`AGENTS.md`), and
gated tool use. It is built on [Mastra](https://mastra.ai) (agent loop, tool
execution, model routing, memory) with a React **[Ink](https://github.com/vadimdemedes/ink)**
TUI on top; iota supplies the UI, the tools, the context-file loader, and the
permission layer.

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
┌──────────────────────────────────────────────────────────────────────┐
│  index.ts — entry: loadConfig → loadContext → connectMcp → buildAgent  │
│             → (TTY?) render <App>  :  runHeadless                       │
└───────┬───────────────────────────────────────┬──────────────────────┘
        │ systemPrompt (context.ts)             │ runtime singleton
        │                                        │ { cwd, permissions, ui }
┌───────▼───────────────────────────┐           │  ▲ read by tools at
│  Ink TUI  (ui/app.tsx)            │           │  │ execute time
│   Header · <Static> transcript    │           │  │
│   live region · Input · StatusBar │           │  │
└───────┬───────────────────────────┘           │  │
        │ reads/writes                           │  │
┌───────▼───────────────────────────┐           │  │
│  ui/store.ts  (single source)     │◀──────────┼──┘  tools emit toolStart/
│   transcript · live · status ·    │  ui sink  │     toolEnd; permission
│   pendingPermission               │           │     resolves a promise
└───────┬───────────────────────────┘           │
        │ session.ts: submit()/interrupt()       │
        │ agent.stream → appendDelta              │
┌───────▼────────────────────────────────────┐  │
│            Mastra Agent (agent.ts)           │  │
│  model router │ Memory (LibSQL) │ tools      │◀─┘
│  anthropic/openai │ history+wm   │ + MCP      │
└──────────────────────────────────────────────┘
```

Key idea: **one store, no scattered prints.** Mastra runs the tool-call loop;
iota renders everything from `ui/store.ts`. The agent stream, tools, permission
gate, and slash commands all push *state* into the store (never `stdout`), and the
Ink app renders from it. This is what lets spinners, the input box, and live
markdown coexist. The three injection seams are: each tool's `execute`
(toolStart/toolEnd + permission), the stream loop in `session.ts`, and slash
commands (short-circuited in `commands.ts`, never reaching the model).

---

## 3. Module responsibilities

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point. Loads config + context, connects MCP, builds the agent, then renders the Ink app (TTY) or runs headless; disconnects MCP on exit. |
| `src/config.ts` | Parses flags/env, loads `.env`, builds the model-router string, picks memory thread/resource ids. |
| `src/context.ts` | Builds the system prompt from a default base plus AGENTS.md/CLAUDE.md/SYSTEM.md context files. |
| `src/agent.ts` | Constructs the Mastra `Agent`: instructions, model, tools, and a LibSQL-backed `Memory`. |
| `src/session.ts` | Drives a turn: dispatches slash commands, calls `agent.stream`, feeds deltas to the store. Also `runHeadless()` (non-TTY plain-text fallback). |
| `src/tools.ts` | The seven built-in tools as Mastra `createTool` definitions, wrapped by `defineTool()` (emits `runtime.ui` events + permission gate). |
| `src/mcp.ts` | Loads MCP server config, connects via Mastra `MCPClient`, merges their (gated) tools. |
| `src/shells.ts` | Background-shell registry: start/read/kill detached commands, rolling output buffers, teardown on exit. |
| `src/mcp-cli.ts` | The `iota mcp add/list/remove` subcommand that edits the `mcp.json` config files. |
| `src/runtime.ts` | Module-level singleton (`cwd`, `permissions`, `ui` sink) that tools read at execute time. |
| `src/permissions.ts` | y/n/always gate for dangerous tools (UI-agnostic via a requester), with a session allowlist. |
| `src/commands.ts` | Slash commands (`/help`, `/tools`, `/mcp`, `/quit`); returns structured output instead of printing. |
| `src/ui/store.ts` | The single UI source of truth + `useStore` hook; implements the `UISink` for tools. |
| `src/ui/app.tsx` | Root Ink component: Header + `<Static>` transcript + live region + Input/PermissionPrompt + StatusBar. |
| `src/ui/components/*` | `Header`, `Transcript` (Message/ToolCall/SystemOutput), `Input`, `PermissionPrompt`, `StatusBar`, `Spinner`. |
| `src/ui/markdown.ts` | `renderMarkdown()` → ANSI via `marked` + `marked-terminal` (syntax-highlighted code). |
| `src/ui/theme.ts` | Centralized color palette (Ink auto-handles NO_COLOR / non-TTY). |

---

## 4. The lifecycle of a turn

> **Startup (once).** Before the loop, `index.ts` calls `loadContext(cwd)` to
> assemble the system prompt from the default base plus any `AGENTS.md` /
> `CLAUDE.md` / `SYSTEM.md` files (§6), then `buildAgent(config, systemPrompt)`.
> The loaded file paths are shown in the banner.

1. **Input.** The `<Input>` component (Ink `useInput`) collects a line; on ⏎ it
   calls `session.submit(text)`. `exit`/`quit` quit; a line starting with `/` goes
   to `commands.ts` (`runCommand`) — `/help`, `/tools`, `/mcp`, `/jobs`, `/quit` —
   handled locally and pushed to the store as a system item, never reaching the model.

2. **Begin turn.** `session.submit` calls `store.addUser(text)` and
   `store.beginTurn()` (sets `busy`, shows the spinner), then:
   ```ts
   const stream = await agent.stream(input, {
     memory: { resource: config.resource, thread: config.thread },
     abortSignal: aborter.signal,
   });
   ```
   Mastra loads the thread's history + working memory, prepends the system
   instructions (assembled at startup by `context.ts`), and calls the routed model.

3. **Stream.** `session` consumes `stream.textStream`, calling
   `store.appendDelta(chunk)`; the live region re-renders raw text token by token.

4. **Tool calls (handled by Mastra).** When the model requests a tool, Mastra
   validates args against `inputSchema` and invokes `execute`. The `defineTool`
   wrapper: flushes live text, calls `runtime.ui.toolStart(name, detail)` (a live
   spinner row); for **dangerous** tools awaits `runtime.permissions.check(...)`
   (which surfaces `<PermissionPrompt>` and blocks on the answer); runs the body
   against `runtime.cwd`; then `runtime.ui.toolEnd(id, status, result)` moves the
   row into the transcript with ✔/✗ + timing + preview.

5. **Finalize.** On stream end, `store.endTurn()` flushes the buffered assistant
   text into the transcript as one **markdown-rendered** message in `<Static>`, and
   clears `busy`. Mastra has already persisted the messages + working memory to
   LibSQL under this `resource`/`thread`.

6. **Done.** The store update re-renders; the `<Input>` reappears for the next turn,
   which automatically sees the updated memory.

### Interrupt & EOF handling
`<App>` registers a global `useInput` (render runs with `exitOnCtrlC:false`): Ctrl-C
during a turn calls `session.interrupt()` (`aborter.abort()`, surfaced as
`(interrupted)`); at idle it exits. The non-TTY headless runner keeps the old
`readline` + `close`-race so `printf 'hi\n' | iota` exits cleanly at EOF.

---

## 5. Tools

Each tool is a Mastra `createTool` with an `id`, `description`, a Zod
`inputSchema`, and an `execute`. iota wraps them in `defineTool()` so every tool
shares the same cross-cutting behavior in one place:

```
defineTool({ id, description, risk?, schema, detail, permKey?, run })
   └─ createTool({
        id, description, inputSchema: schema, outputSchema: { result: string },
        execute: async (raw) => {
          args = readInput(raw)                        // version-tolerant input
          id = runtime.ui.toolStart(id, detail(args))  // live spinner row
          if risk === "dangerous":                     // permission gate
            if !permissions.check(permKey, summary): { ui.toolEnd(id,"error",…); return denial }
          try   result = await run(args); ui.toolEnd(id,"done",result); return {result}
          catch ui.toolEnd(id,"error",msg); return { result: "Error: …" } // never throw
      })
```

This keeps each tool body (`run`) a small, pure function while UI events,
permissions, error handling, and the Mastra wiring live once in the wrapper. All
UI goes through `runtime.ui` (the store, or the headless sink) — never `stdout`.

| Tool | Risk | Notes |
| --- | --- | --- |
| `read` | safe | Returns file contents with line numbers; supports offset/limit. |
| `ls` | safe | Lists a directory (dirs shown with trailing `/`). |
| `glob` | safe | File-name matching; ignores `node_modules`/`.git`. |
| `grep` | safe | Content search; uses ripgrep if installed, else a JS fallback. |
| `write` | dangerous | Creates/overwrites a file (makes parent dirs). |
| `edit` | dangerous | Exact-string replace; unique match required unless `replace_all`. |
| `bash` | dangerous | Runs a shell command. Foreground (timeout, bounded output) or `background:true` → returns a `bash_id`. |
| `bash_output` | safe | Read new output + status from a background shell since the last poll. |
| `kill_shell` | safe | Stop a background shell. |

Tool names the model sees come from the **keys** of the `tools` object passed to
the Agent (`{ read, write, edit, … }`).

### Background shells (`shells.ts`)
`bash(background:true)` calls `startShell()`, which `spawn`s the command with no
timeout, accumulates stdout/stderr into a rolling buffer (capped, with a read
cursor so each `bash_output` returns only new bytes), and returns a `bg_N` id
immediately. `bash_output`/`kill_shell` map to `readShell`/`killShell`. The
registry is a module singleton (independent of the UI); it exposes
`onShellsChange` so `index.ts` mirrors `listShells()` into the store (status-bar
`▸ N bg`, `/jobs`). `killAll()` runs in the `index.ts` `finally` so nothing is
left running on exit.

### Why the `runtime` singleton
Mastra hands a tool's `execute` only its validated input — it has no reference to
iota's app state. Tools need three things: the working directory (`cwd`), the
permission prompt (`permissions`), and the UI sink (`ui`). Rather than thread
these through Mastra's context, iota keeps a module-level
`runtime = { cwd, permissions, ui }`, populated once at startup in `index.ts`
(`ui` = the store in TTY mode, a console sink in headless). Tools import it
directly — the deliberate coupling that keeps tool bodies simple and renderer-agnostic.

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

The loaded paths are shown in the header. This is the "remembered facts you own as
files" complement to Mastra's DB-backed memory.

---

## 6b. UI (Ink)

The interface is a React **Ink** app driven by a single external store
(`ui/store.ts`), consumed via `useSyncExternalStore`. Nothing else writes stdout.

- **Store** holds the `transcript` (finalized items), the `live` turn (streaming
  text + running tools), `status`/`busy`, and `pendingPermission`. Actions:
  `addUser`, `beginTurn`/`appendDelta`/`endTurn`, `toolStart`/`toolEnd` (the
  `UISink`), `requestPermission`, `pushSystem`.
- **Static vs live.** Finalized items render in Ink's `<Static>` (printed once,
  natural scrollback); the in-progress turn renders in a live region below. The
  **header is the first `<Static>` item** because Ink always hoists `<Static>`
  above the live frame.
- **Streaming + markdown.** While streaming, the live region shows **raw** text
  (responsive). On `endTurn` the buffered message is flushed into `<Static>` and
  rendered as **markdown** (`ui/markdown.ts`, `marked` + `marked-terminal` with
  syntax-highlighted code) — so markdown never reflows per token.
- **Components** (`ui/components/`): `Header` (boxed), `Transcript`
  (`Message`/`ToolCall`/`SystemOutput`), `Input` (custom `useInput`),
  `PermissionPrompt`, `StatusBar`, `Spinner`. Colors come from `ui/theme.ts`.
- **Input modes.** Exactly one of `<PermissionPrompt>`, a "working…" line, or
  `<Input>` is mounted at a time, so only one `useInput` consumes keys. A global
  `useInput` in `<App>` handles Ctrl-C (`exitOnCtrlC:false`).
- **Headless fallback.** When `!process.stdin.isTTY`, `runHeadless()` (in
  `session.ts`) runs the same agent/commands over `readline` with a plain-text
  `UISink` and `readline` permission requester.

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
of a given **kind**, `check()` awaits a **requester** (`(summary) => Promise<"yes"
|"no"|"always">`) wired at startup — in TTY mode `store.requestPermission`, which
surfaces `<PermissionPrompt>` and resolves the promise on the keypress; in headless
mode a `readline` prompt. The manager is thus UI-agnostic.

- `y` allows once, `n` denies (the tool returns a denial the model can react to),
  `a` adds the kind to a session allowlist so it won't ask again.
- The allowlist **key** is the tool id, except `bash`, which is keyed by the first
  word of the command (`bash:npm`) so "always" is scoped to that command family
  rather than all shell access.
- `--yolo` short-circuits every check. The allowlist is in-memory and resets each
  run.

Because the prompt is a promise the tool awaits, the agent stream simply suspends
on that tool until the user answers — no special pausing logic.

---

## 9. Boundaries & extension points

- **Add a tool:** write a `defineTool({...})` in `tools.ts` and add it to the
  exported `tools` object. Permission, UI events, and error handling come for free.
- **Add a UI element:** add a component under `ui/components/` and render it from
  `ui/app.tsx`, reading state via `useStore()`; extend the store if it needs state.
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

### Current limitations
- Tool activity is driven by `runtime.ui` events the wrappers emit, not by the
  model stream's structured `fullStream` events.
- Assistant markdown renders only on the finalized message (raw while streaming);
  headings keep their literal `#` (a marked-terminal quirk) though still styled.
- `<Input>` is minimal: typing, backspace, ⏎ — no cursor movement or history yet.
- No context compaction beyond `lastMessages: 30`; long threads rely on that window
  plus working memory rather than summarization.
- Permission "always" approvals are session-scoped, not persisted. MCP tools reuse
  the same gate rather than Mastra's native `RequireToolApproval` hook.
- Slash commands are inspect-only (`/help`, `/tools`, `/mcp`, `/jobs`, `/quit`);
  none mutate session state yet (e.g. switching thread or model mid-run).
- Non-TTY stdin uses the plain-text headless runner (no Ink); a piped multi-line
  command script isn't reliably executed line-by-line (it exits at EOF).
