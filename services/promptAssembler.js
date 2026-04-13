// ============================================================
// services/promptAssembler.js — Layered prompt assembler
// ============================================================
// What this file does:
//   Loads the three-layer prompt files at startup and assembles
//   the system blocks array for each generation call. This is the
//   single integration point between the file system and the
//   Anthropic API call.
//
// What to change here if intent changes:
//   - CACHE STRATEGY: Layer 1 (global rules) is always identical → always hits cache.
//     Layer 2 (domain module) is identical for all calls with the same domainModuleKey
//     → hits cache within a session when user generates for the same domain.
//     Layer 3 (mode overlay) is not cached — it is small.
//     If modes diverge significantly, add cache_control to the Layer 3 block too.
//   - TO ADD A NEW DOMAIN: create prompts/layer2_domains/{key}.md and add the key
//     to the domainModuleKey derivation in services/classifier.js.
//   - To change which layers are cached: edit the cache_control assignments below.
//
// Depends on: prompts/layer1_global_rules.md, prompts/layer2_domains/*, prompts/layer3_modes/*
// ============================================================

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

// Layer file caches (loaded once at startup)
const _layer1Cache    = { text: null };
const _layer2Cache    = new Map();   // domainModuleKey → text
const _layer3Cache    = new Map();   // mode → text

// Load and cache all prompt files at startup
export function loadAllPrompts() {
  // Layer 1
  const l1Path = path.join(PROMPTS_DIR, "layer1_global_rules.md");
  try {
    _layer1Cache.text = fs.readFileSync(l1Path, "utf8");
    console.log(`[prompt] Layer 1 loaded (${_layer1Cache.text.length} chars)`);
  } catch {
    console.error("[prompt] CRITICAL: layer1_global_rules.md not found — generation will fail");
  }

  // Layer 2 — all domain modules
  const domainDir = path.join(PROMPTS_DIR, "layer2_domains");
  const loaded = [];
  try {
    const files = fs.readdirSync(domainDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const key  = path.basename(file, ".md");
      const text = fs.readFileSync(path.join(domainDir, file), "utf8");
      _layer2Cache.set(key, text);
      loaded.push(key);
    }
    console.log(`[prompt] Loaded ${loaded.length} domain modules: ${loaded.sort().join(", ")}`);
  } catch(e) {
    console.warn("[prompt] layer2_domains/ directory not found:", e.message);
  }

  // Layer 3 — mode overlays
  const modesDir = path.join(PROMPTS_DIR, "layer3_modes");
  try {
    const files = fs.readdirSync(modesDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const key  = path.basename(file, ".md").toUpperCase();
      const text = fs.readFileSync(path.join(modesDir, file), "utf8");
      // Map file stems to mode names used in server
      const modeKey = file.includes("tailored")      ? "TAILORED"
                    : file.includes("custom_sampler") ? "CUSTOM_SAMPLER"
                    : key;
      _layer3Cache.set(modeKey, text);
    }
    console.log(`[prompt] Loaded ${_layer3Cache.size} mode overlays: ${[..._layer3Cache.keys()].join(", ")}`);
  } catch(e) {
    console.warn("[prompt] layer3_modes/ directory not found:", e.message);
  }
}

// Assemble the system blocks and user message for a generation call.
// domainModuleKey: e.g. "engineering", "pm_construction", "finance"
// mode: "TAILORED" | "CUSTOM_SAMPLER"
// runtimeInputs: string from buildRuntimeInputs()
export function assemblePrompt(domainModuleKey, mode, runtimeInputs) {
  if (!_layer1Cache.text) {
    throw new Error("Prompt assembler not initialised — call loadAllPrompts() at startup");
  }

  // Layer 2: use requested domain or fall back to general
  let layer2Text = _layer2Cache.get(domainModuleKey);
  if (!layer2Text) {
    console.warn(`[prompt] Domain module "${domainModuleKey}" not found, falling back to "general"`);
    layer2Text = _layer2Cache.get("general") || "";
  }

  // Layer 3: mode overlay (optional, no cache breakpoint)
  const layer3Text = _layer3Cache.get(mode) || "";
  if (!layer3Text) {
    console.warn(`[prompt] Mode overlay for "${mode}" not found — proceeding without it`);
  }

  const systemBlocks = [
    {
      type: "text",
      text: _layer1Cache.text,
      cache_control: { type: "ephemeral" },  // breakpoint 1: global rules always cached
    },
    {
      type: "text",
      text: layer2Text,
      cache_control: { type: "ephemeral" },  // breakpoint 2: domain cached per domain
    },
    {
      type: "text",
      text: layer3Text,
      // no cache_control: mode overlay is small, not worth a breakpoint
    },
  ];

  return { systemBlocks, userMessage: runtimeInputs };
}
