# iota

A terminal-based coding harness in the spirit of Claude Code, built on
[**Mastra**](https://mastra.ai). A REPL where you talk to an agent that can read
and edit files and run commands in your project — with **persistent memory** and
gated tool use. Mastra owns the agent loop, tool execution, model routing, and
memory; iota is the terminal UI, the tools, and the permission layer on top.

## Setup

```bash
npm install
cp .env.example .env   # add the key for whichever provider you use
```

## Run

```bash
npm run dev                          # Anthropic (default), claude-sonnet-4-6
npm run dev -- --provider openai     # OpenAI, gpt-4o
npm run dev -- --model claude-opus-4-8
npm run dev -- --new                 # start a fresh memory thread
```

Build a runnable binary with `npm run build && npm start`.

### Flags & env

| Flag | Env | Default |
| --- | --- | --- |
| `--provider <anthropic\|openai>` | `IOTA_PROVIDER` | `anthropic` |
| `--model <name or provider/name>` | `IOTA_MODEL` | per-provider default |
| `--thread <id>` | `IOTA_THREAD` | `main` |
| `--new` | — | reuse `main` |
| `--cwd <dir>` | — | current directory |
| `--yolo` / `--dangerously-skip-permissions` | — | off |

Models use Mastra's **model router**: pass `provider/name` (e.g.
`anthropic/claude-opus-4-8`, `openai/gpt-4o`) or just a bare name combined with
`--provider`. Keys come from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (read from
`.env` or the environment); Mastra routes to the right provider.

## Commands

At the `›` prompt, lines starting with `/` are commands (everything else goes to
the agent):

| Command | Description |
| --- | --- |
| `/help` | List commands. |
| `/tools` | List all available tools (built-in + MCP). |
| `/mcp` | List connected MCP servers and their tools (with status). |
| `exit` / `quit` | Quit (also Ctrl-D / Ctrl-C at the prompt). |

## How it works

```
repl ──▶ Mastra Agent ──▶ model router (Anthropic | OpenAI)
              │   ├─ tools: read/write/edit/bash/grep/glob/ls  (createTool)
              │   └─ Memory (LibSQL) ── history + working memory, persisted
              └─ tools gate write/edit/bash through the permission prompt
```

The REPL calls `agent.stream(input, { memory: { resource, thread } })` and pipes
`textStream` to the terminal. Mastra runs the tool-call loop itself; each tool is
a `createTool` definition (`src/tools.ts`). Tools reach the working directory and
the permission prompt through a small module-level `runtime` singleton, since
Mastra only hands tools their validated input.

## Memory

Memory is Mastra's, backed by **LibSQL** persisted to `./.iota/memory.db` (one
store per project):

- **Conversation history** — the last 30 messages of the thread are reloaded
  automatically every turn, so context survives across runs of the same thread.
- **Working memory** — the agent maintains a durable scratchpad of facts about
  you and the project (stack, conventions, goals) that persists between sessions.
- **Threads** — `--thread <id>` switches conversations; `--new` starts a fresh
  one. Same `resource`/`thread` => same remembered history.

Semantic recall (vector search over past messages) is off by default — it needs a
vector store and an embedder; enable it in `src/agent.ts` if you want it.

## Project context files (AGENTS.md)

<!-- we good -->

On startup iota loads standing instructions into the system prompt, pi-style
(`src/context.ts`):

- **`AGENTS.md` / `CLAUDE.md`** — read from the global dir (`~/.iota/`), then every
  ancestor directory down to the cwd, then the cwd itself. All matches are
  concatenated, **most-specific last**, and treated as authoritative project
  instructions and conventions.
- **`.iota/SYSTEM.md`** — replaces the default system prompt entirely (a project
  file wins over a global one).
- **`.iota/APPEND_SYSTEM.md`** — appended after everything (global, then project).

The banner prints which files were loaded. Put repo-wide conventions in an
`AGENTS.md` at your project root and they'll be in context every session.

## Tools

`read`, `write`, `edit`, `bash`, `grep` (uses ripgrep if installed), `glob`, `ls`.
`write`, `edit`, and `bash` prompt for permission unless `--yolo` is set; answer
`a` to allow that kind of action for the rest of the session.

## MCP servers

iota can connect to [MCP](https://modelcontextprotocol.io) servers and expose
their tools to the agent. Declare servers in JSON (merged, project wins):

- `~/.iota/mcp.json` — global
- `<project>/.iota/mcp.json` — project

Manage them from the CLI (writes the JSON for you):

```bash
iota mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
iota mcp add github --url https://api.example.com/mcp
iota mcp add internal --trusted --env API_KEY=xyz -- node server.js
iota mcp list
iota mcp remove github
```

Add `--global` (or `--scope global`) to write to `~/.iota/mcp.json` instead of the
project; `--cwd <dir>` targets a different project. Or edit the JSON by hand:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "github":     { "url": "https://api.example.com/mcp" },
    "internal":   { "command": "node", "args": ["server.js"], "trusted": true }
  }
}
```

(See `mcp.example.json`.) Each server is either **stdio** (`command`/`args`/`env`)
or **remote** (`url`). Tools are namespaced `server_tool` (e.g. `filesystem_read_file`)
and shown in the banner at startup. MCP tools go through the same permission
prompt as built-in dangerous tools; mark a server `"trusted": true` to skip the
prompt for tools you control. Servers that fail to connect are reported and
skipped — the rest still load.
