#!/usr/bin/env node

/**
 * Reads OpenCode agents from the config directory and generates
 * Claude Code subagent wrapper files in the plugin's agents/ directory.
 *
 * Run automatically via SessionStart hook, or manually:
 *   node bin/sync-agents.mjs
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

const OPENCODE_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR || join(process.env.HOME, ".config", "opencode");
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dirname, "..");
const AGENTS_OUT_DIR = join(PLUGIN_ROOT, "agents");
const CONFIG_PATH = join(PLUGIN_ROOT, "config.json");

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
  if (!existsSync(CONFIG_PATH)) return { default_mode: "manual", agents: {} };
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function loadOpencodeConfig() {
  const p = join(OPENCODE_CONFIG_DIR, "opencode.json");
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf-8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const agentsDir = join(OPENCODE_CONFIG_DIR, "agents");
if (!existsSync(agentsDir)) {
  console.error(`[sync-agents] No agents directory at ${agentsDir}`);
  process.exit(0);
}

const bridgeConfig = loadBridgeConfig();
const opencodeConfig = loadOpencodeConfig();
const disabledAgents = opencodeConfig.agent || {};

mkdirSync(AGENTS_OUT_DIR, { recursive: true });

// Track which agents we generate so we can clean up stale ones
const generated = new Set();

const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

for (const file of files) {
  const name = basename(file, ".md");
  const content = readFileSync(join(agentsDir, file), "utf-8");
  const fm = parseFrontmatter(content);

  const agentCfg = bridgeConfig.agents?.[name] || {};
  const mode = agentCfg.mode || bridgeConfig.default_mode || "manual";
  const enabled = !disabledAgents[name]?.disable;
  const description =
    agentCfg.description_override || fm.description || `OpenCode agent: ${name}`;

  // Build the description line for Claude Code
  const modeHint =
    mode === "auto"
      ? "Use proactively when appropriate."
      : "Only use when the user explicitly asks for this agent.";

  const enabledNote = enabled ? "" : " (currently DISABLED in OpenCode config)";

  const md = `---
name: ${name}
description: "OpenCode agent: ${description.replace(/"/g, '\\"')} ${modeHint}${enabledNote}"
model: haiku
---

You are a bridge to the OpenCode "${name}" agent.

When you receive a task:

1. Call the \`opencode_run\` MCP tool with:
   - \`agent\`: \`"${name}"\`
   - \`message\`: the full task description from the user
   - \`explicit\`: \`true\`
   - \`directory\`: the project directory if the user specified one
2. Return the agent's response verbatim. Do not summarize unless asked.

If the agent returns an error, report it clearly.
`;

  writeFileSync(join(AGENTS_OUT_DIR, file), md);
  generated.add(file);
}

// Clean up agent wrappers that no longer have a corresponding OpenCode agent
const existing = readdirSync(AGENTS_OUT_DIR).filter((f) => f.endsWith(".md"));
for (const file of existing) {
  if (!generated.has(file)) {
    unlinkSync(join(AGENTS_OUT_DIR, file));
    console.log(`[sync-agents] Removed stale wrapper: ${file}`);
  }
}

console.log(`[sync-agents] Synced ${generated.size} agents from ${agentsDir}`);
