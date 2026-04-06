import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENCODE_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR || join(process.env.HOME, ".config", "opencode");

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dirname, "..");

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val === "true") fm[key] = true;
    else if (val === "false") fm[key] = false;
    else fm[key] = val.replace(/^["']|["']$/g, "");
  }
  return fm;
}

function loadBridgeConfig() {
  const configPath = join(PLUGIN_ROOT, "config.json");
  if (!existsSync(configPath)) return { default_mode: "manual", agents: {} };
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function loadOpencodeConfig(configDir) {
  const dir = configDir || OPENCODE_CONFIG_DIR;
  const configPath = join(dir, "opencode.json");
  if (!existsSync(configPath)) return {};
  // opencode.json may have JS-style comments — strip them
  const raw = readFileSync(configPath, "utf-8");
  const cleaned = raw.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(cleaned);
}

function discoverAgents(configDir) {
  const dir = configDir || OPENCODE_CONFIG_DIR;
  const agentsDir = join(dir, "agents");
  if (!existsSync(agentsDir)) return [];

  const bridgeConfig = loadBridgeConfig();
  const opencodeConfig = loadOpencodeConfig(configDir);
  const disabledAgents = opencodeConfig.agent || {};

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  return files.map((file) => {
    const name = basename(file, ".md");
    const content = readFileSync(join(agentsDir, file), "utf-8");
    const fm = parseFrontmatter(content);

    const agentBridgeCfg = bridgeConfig.agents?.[name] || {};
    const mode = agentBridgeCfg.mode || bridgeConfig.default_mode || "manual";
    const description =
      agentBridgeCfg.description_override || fm.description || "(no description)";
    const enabled = !disabledAgents[name]?.disable;

    return {
      name,
      description,
      model: fm.model || null,
      enabled,
      mode,
    };
  });
}

function runOpencode(agent, message, { directory, model, variant } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["run", "--agent", agent, "--format", "json"];
    if (directory) args.push("--dir", directory);
    if (model) args.push("--model", model);
    if (variant) args.push("--variant", variant);
    args.push(message);

    const child = execFile("opencode", args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: { ...process.env, NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject(new Error(`Timeout after ${TIMEOUT_MS / 1000}s`));
        } else {
          reject(new Error(`opencode failed (exit ${error.code}): ${stderr || error.message}`));
        }
        return;
      }
      resolve(extractResponse(stdout));
    });
  });
}

function extractResponse(jsonOutput) {
  // opencode --format json emits newline-delimited JSON events.
  // We look for assistant message content.
  const lines = jsonOutput.trim().split("\n");
  const parts = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // Try common event shapes
      if (event.type === "text" && event.text) {
        parts.push(event.text);
      } else if (event.role === "assistant" && event.content) {
        if (typeof event.content === "string") parts.push(event.content);
        else if (Array.isArray(event.content)) {
          for (const block of event.content) {
            if (block.type === "text" && block.text) parts.push(block.text);
          }
        }
      } else if (event.type === "message.delta" && event.delta?.text) {
        parts.push(event.delta.text);
      } else if (event.type === "content" && event.content) {
        parts.push(typeof event.content === "string" ? event.content : JSON.stringify(event.content));
      }
    } catch {
      // Not JSON — accumulate raw text as fallback
      if (line.trim()) parts.push(line);
    }
  }

  return parts.length > 0 ? parts.join("") : jsonOutput;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "claude-opencode-bridge",
  version: "1.0.0",
});

// Tool 1: List agents
server.tool(
  "opencode_list_agents",
  "List all available OpenCode agents with their name, description, enabled status, and invocation mode (auto/manual). Use this to discover what OpenCode agents are available before running them.",
  {
    config_dir: z
      .string()
      .optional()
      .describe("OpenCode config directory (default: ~/.config/opencode)"),
  },
  async ({ config_dir }) => {
    try {
      const agents = discoverAgents(config_dir);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(agents, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error discovering agents: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: Run a single agent
server.tool(
  "opencode_run",
  `Run an OpenCode agent with a message. Returns the agent's response.

IMPORTANT — Invocation modes:
- Agents with mode "auto" can be used proactively when you judge it appropriate.
- Agents with mode "manual" MUST ONLY be used when the user explicitly asks to use that specific agent. For manual agents, you MUST set explicit=true.
- Use opencode_list_agents first if you're unsure about available agents or their modes.`,
  {
    agent: z.string().describe("Name of the OpenCode agent to run"),
    message: z.string().describe("The prompt/message to send to the agent"),
    explicit: z
      .boolean()
      .default(false)
      .describe(
        "Set to true ONLY when the user explicitly requested this agent. Required for manual-mode agents."
      ),
    directory: z
      .string()
      .optional()
      .describe("Working directory for the OpenCode agent"),
    model: z
      .string()
      .optional()
      .describe("Model override in provider/model format (e.g. google/gemini-2.5-pro)"),
    variant: z
      .string()
      .optional()
      .describe("Model variant (e.g. high, max, minimal)"),
  },
  async ({ agent, message, explicit, directory, model, variant }) => {
    try {
      // Check mode guardrail
      const bridgeConfig = loadBridgeConfig();
      const agentCfg = bridgeConfig.agents?.[agent] || {};
      const mode = agentCfg.mode || bridgeConfig.default_mode || "manual";

      if (mode === "manual" && !explicit) {
        return {
          content: [
            {
              type: "text",
              text: `BLOCKED: Agent "${agent}" is in manual mode. It can only be used when the user explicitly requests it. If the user asked for this agent, retry with explicit=true.`,
            },
          ],
          isError: true,
        };
      }

      // Verify agent exists
      const agents = discoverAgents();
      const found = agents.find((a) => a.name === agent);
      if (!found) {
        const names = agents.map((a) => a.name).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Agent "${agent}" not found. Available agents: ${names}`,
            },
          ],
          isError: true,
        };
      }

      if (!found.enabled) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${agent}" is disabled in OpenCode configuration.`,
            },
          ],
          isError: true,
        };
      }

      const result = await runOpencode(agent, message, { directory, model, variant });
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error running agent "${agent}": ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Run multiple agents in parallel
server.tool(
  "opencode_multi_run",
  `Run multiple OpenCode agents in parallel. Each task specifies an agent and message. Returns all results.
Mode rules apply: manual agents require explicit user request for each one.`,
  {
    tasks: z
      .array(
        z.object({
          agent: z.string().describe("Agent name"),
          message: z.string().describe("Prompt for this agent"),
          explicit: z
            .boolean()
            .default(false)
            .describe("Set true if user explicitly requested this agent"),
          directory: z.string().optional().describe("Working directory"),
          model: z.string().optional().describe("Model override"),
          variant: z.string().optional().describe("Model variant"),
        })
      )
      .describe("Array of agent tasks to run in parallel"),
  },
  async ({ tasks }) => {
    const bridgeConfig = loadBridgeConfig();
    const agents = discoverAgents();

    const promises = tasks.map(async (task) => {
      const agentCfg = bridgeConfig.agents?.[task.agent] || {};
      const mode = agentCfg.mode || bridgeConfig.default_mode || "manual";

      if (mode === "manual" && !task.explicit) {
        return {
          agent: task.agent,
          status: "blocked",
          error: `Agent "${task.agent}" is in manual mode — requires explicit user request.`,
        };
      }

      const found = agents.find((a) => a.name === task.agent);
      if (!found) {
        return { agent: task.agent, status: "error", error: "Agent not found" };
      }
      if (!found.enabled) {
        return { agent: task.agent, status: "error", error: "Agent is disabled" };
      }

      try {
        const result = await runOpencode(task.agent, task.message, {
          directory: task.directory,
          model: task.model,
          variant: task.variant,
        });
        return { agent: task.agent, status: "success", result };
      } catch (err) {
        return { agent: task.agent, status: "error", error: err.message };
      }
    });

    const results = await Promise.allSettled(promises);
    const output = results.map((r) =>
      r.status === "fulfilled" ? r.value : { status: "error", error: r.reason?.message }
    );

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
