# claude-opencode-bridge

A Claude Code plugin that lets Claude discover, launch, and orchestrate [OpenCode](https://opencode.ai) agents.

## Why

OpenCode connects to 75+ LLM providers — Google Gemini, local models via Ollama, custom endpoints, and more. Its agents are specialized markdown-defined workflows (browser automation, content processing, code validation, etc.) that run on these providers.

Claude Code is powerful but limited to Anthropic models. This plugin bridges the two: Claude Code becomes the orchestrator, delegating work to OpenCode agents that run on whatever model is best for the job. You get Claude's planning and reasoning with access to third-party models and OpenCode's specialized agent ecosystem.

Concrete use cases:

- Claude delegates browser automation to an OpenCode agent running Gemini (which has native Playwright MCP access)
- Claude fans out content processing tasks to multiple OpenCode agents in parallel, each running on a cost-effective model
- Claude orchestrates a pipeline: one agent researches, another validates, another writes — each on the model best suited for it

## Prerequisites

- [Claude Code](https://claude.ai/download) installed and authenticated
- [OpenCode](https://opencode.ai) installed and configured with at least one agent
- Node.js >= 18

## Install

### Option A: Load during development

```bash
claude --plugin-dir ~/dev/claude-opencode-bridge
```

### Option B: Install permanently

If you have a [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) configured, add this plugin to it. Otherwise, use `--plugin-dir` or symlink it into your plugin directory.

### Dependencies

Dependencies are installed automatically on first session start via the `SessionStart` hook. If you prefer to install manually:

```bash
cd ~/dev/claude-opencode-bridge
npm install --production
```

## Configuration

### OpenCode config directory

The plugin reads OpenCode agents from `~/.config/opencode/agents/` by default. To change this, edit the `OPENCODE_CONFIG_DIR` environment variable in `.mcp.json`:

```json
{
  "mcpServers": {
    "opencode": {
      "env": {
        "OPENCODE_CONFIG_DIR": "/path/to/your/opencode/config"
      }
    }
  }
}
```

### Agent invocation modes — `config.json`

Each OpenCode agent has an invocation mode that controls whether Claude can use it autonomously or only when you ask:

| Mode | Behavior |
|------|----------|
| `auto` | Claude can use this agent proactively, whenever it judges it appropriate |
| `manual` | Claude uses this agent **only** when you explicitly ask for it |

The file lives in the **plugin root directory** (next to `plugin.json` and `package.json`). Copy the example to get started:

```bash
cd /path/to/claude-opencode-bridge   # wherever you cloned/installed the plugin
cp config.example.json config.json
```

Then customize `config.json`:

```json
{
  "default_mode": "manual",
  "agents": {
    "browser": {
      "mode": "auto",
      "description_override": "Browser automation — use proactively to navigate web pages"
    },
    "astro-deslop": { "mode": "manual" },
    "astro-polish": { "mode": "manual" },
    "leb-precision": { "mode": "manual" }
  }
}
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `default_mode` | No | Mode for agents not listed. Default: `"manual"` |
| `agents.<name>.mode` | No | `"auto"` or `"manual"`. Overrides `default_mode` for this agent |
| `agents.<name>.description_override` | No | Replaces the agent's description in tool listings. Useful to give Claude better context on when to use an `auto` agent |

**How the guardrail works:**

1. **Soft guardrail** — the tool description instructs Claude to respect agent modes
2. **Hard guardrail** — the MCP server blocks execution of `manual` agents unless the `explicit` parameter is set to `true` (which Claude only sets when you explicitly asked for that agent)

Agents not listed in `config.json` inherit `default_mode`.

## Usage — `@opencode:<name>`

At every session start, the plugin scans your OpenCode agents directory and auto-generates a Claude Code subagent for each one, under the `opencode:` namespace. No hardcoded list — if you add or remove an agent in OpenCode, it appears or disappears in Claude Code on next session.

Reference them with `@opencode:<name>` in your prompts:

```
@opencode:browser naviga su example.com e dimmi il titolo della pagina

Istruisci @opencode:astro-deslop per pulire il file content/learn-astrology/mars-in-aries.md

Lancia @opencode:astro-deslop e @opencode:astro-polish in parallelo sul file content/learn-astrology/venus.md
```

Claude spawns the subagent, which calls the corresponding OpenCode agent via MCP tool. The result flows back to the main conversation.

`auto` agents: Claude may delegate to them without being asked. `manual` agents: only used when you explicitly mention them.

Run `/agents` in Claude Code to see all currently registered agents. Run `/reload-plugins` to re-sync after adding new OpenCode agents mid-session.

## MCP Tools

The plugin also exposes three lower-level MCP tools that Claude uses under the hood (or that you can invoke directly):

### `opencode_list_agents`

Lists all available OpenCode agents with their name, description, enabled status, and invocation mode.

```
"List the available OpenCode agents"
```

Returns:
```json
[
  { "name": "browser", "description": "Browser automation via Playwright", "model": "google/gemini-2.5-pro", "enabled": true, "mode": "auto" },
  { "name": "code-review", "description": "Reviews code for quality", "model": null, "enabled": true, "mode": "manual" }
]
```

### `opencode_run`

Runs a single OpenCode agent with a message.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agent` | Yes | Agent name |
| `message` | Yes | Prompt to send |
| `explicit` | No | `true` if you explicitly requested this agent (required for `manual` agents) |
| `directory` | No | Working directory for the agent |
| `model` | No | Model override (`provider/model` format) |
| `variant` | No | Model variant (e.g. `high`, `max`, `minimal`) |

```
"Use the browser agent to check if example.com is up"
```

### `opencode_multi_run`

Runs multiple agents in parallel. Each task is an object with the same parameters as `opencode_run`.

```
"Run astro-deslop and astro-polish in parallel on the file content/mars.md"
```

Returns an array of results:
```json
[
  { "agent": "astro-deslop", "status": "success", "result": "..." },
  { "agent": "astro-polish", "status": "success", "result": "..." }
]
```

## How it works

```
Session start
  └── hooks/hooks.json
        ├── npm install (if needed)
        └── bin/sync-agents.mjs
              ├── reads ~/.config/opencode/agents/*.md
              ├── reads ~/.config/opencode/opencode.json (enabled/disabled)
              ├── reads config.json (modes: auto/manual)
              └── generates agents/*.md (Claude Code subagents)

During conversation
  Claude Code  --(MCP stdio)-->  server.mjs  --(CLI)-->  opencode run --agent <name> --format json "<msg>"
  Claude Code  --(subagent)-->   @opencode:<name>  -->  opencode_run MCP tool  -->  opencode run ...
```

1. At session start, `sync-agents.mjs` scans the OpenCode agents directory and generates a Claude Code subagent wrapper for each one
2. The MCP server (`server.mjs`) starts and exposes `opencode_list_agents`, `opencode_run`, `opencode_multi_run`
3. Claude can use agents via `@opencode:<name>` (subagent path) or via MCP tools directly
4. Each invocation spawns a fresh `opencode run` process — stateless, no persistent server required
5. The server parses OpenCode's JSON event stream and extracts the assistant's response
6. Parallel runs use `Promise.allSettled()` so one failure doesn't block others

## Adding new OpenCode agents

1. Create a markdown file in your OpenCode agents directory (e.g. `~/.config/opencode/agents/my-agent.md`)
2. Optionally, set its mode in `config.json`:
   ```json
   "my-agent": { "mode": "auto" }
   ```
   If you don't add it, it inherits `default_mode` (default: `"manual"`)
3. Start a new Claude Code session or run `/reload-plugins` — the agent is auto-discovered and appears as `@opencode:my-agent`

Removing an agent from OpenCode's directory automatically removes its wrapper on next session start.

## File structure

```
claude-opencode-bridge/
├── .claude-plugin/
│   └── plugin.json         # Plugin manifest (name, version, description)
├── .mcp.json               # MCP server config — auto-starts on plugin load
├── config.json             # Your agent modes — gitignored, create from config.example.json
├── config.example.json     # Template for config.json
├── bin/
│   └── sync-agents.mjs     # Generates agents/ from OpenCode config at session start
├── agents/                  # Auto-generated — one wrapper per OpenCode agent (gitignored)
│   ├── browser.md
│   ├── my-agent.md
│   └── ...
├── src/
│   └── server.mjs          # MCP server implementation
├── hooks/
│   └── hooks.json          # SessionStart hook: installs deps + syncs agents
├── package.json            # Node.js dependencies
└── README.md
```

## Auto-configure with Claude

You can ask Claude to configure the plugin for you. Copy-paste one of these prompts into Claude Code:

### First-time setup

```
Read the OpenCode agents directory at ~/.config/opencode/agents/ and the OpenCode config
at ~/.config/opencode/opencode.json. For each agent found, determine if it should be "auto"
or "manual" based on this logic:
- General-purpose utility agents (browser, search, file processing) → "auto"
- Domain-specific or destructive agents (content rewriting, data validation) → "manual"

Then update config.json in the claude-opencode-bridge plugin at the claude-opencode-bridge plugin's config.json
with the discovered agents. Keep default_mode as "manual". For auto agents, write a clear
description_override that explains when you should use the agent proactively.

Show me the result before writing.
```

### When you add new OpenCode agents

```
Check ~/.config/opencode/agents/ for any agents not yet listed in
the claude-opencode-bridge plugin's config.json. For each new agent, ask me whether it should
be "auto" or "manual", then update config.json accordingly.
```

### Switch all agents to a specific mode

```
Set all agents in the claude-opencode-bridge plugin's config.json to mode "manual" (or "auto").
```

## Limitations

- Each `opencode_run` starts a new OpenCode session (no conversation continuity between calls)
- Timeout is 5 minutes per agent invocation
- OpenCode must be installed and in `PATH`
- Agents disabled in `opencode.json` cannot be run (the server reports them as disabled)

## License

MIT
