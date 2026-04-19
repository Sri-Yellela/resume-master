// ============================================================
// services/promptAssembler.js - layered prompt assembler
// ============================================================
// Loads the three-layer prompt files at startup and assembles the
// Anthropic system blocks for each generation call.
//
// Compatibility note:
//   Active prompt overlays are named Generate and A+. Legacy DB/API mode values
//   still map here so historical rows and persisted apply_mode values keep
//   working without leaking old names into the active prompt architecture.
// ============================================================

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

const _layer1Cache = { text: null };
const _layer2Cache = new Map(); // domainModuleKey -> text
const _layer3Cache = new Map(); // normalized mode -> text

const MODE_ALIASES = new Map([
  ["TAILORED", "GENERATE"],
  ["GENERATE", "GENERATE"],
  ["CUSTOM_SAMPLER", "A_PLUS"],
  ["A_PLUS", "A_PLUS"],
]);

function normalizeModeKey(mode) {
  const key = String(mode || "").trim().toUpperCase();
  return MODE_ALIASES.get(key) || key;
}

export function loadAllPrompts() {
  const l1Path = path.join(PROMPTS_DIR, "layer1_global_rules.md");
  try {
    _layer1Cache.text = fs.readFileSync(l1Path, "utf8");
    console.log(`[prompt] Layer 1 loaded (${_layer1Cache.text.length} chars)`);
  } catch {
    console.error("[prompt] CRITICAL: layer1_global_rules.md not found - generation will fail");
  }

  const domainDir = path.join(PROMPTS_DIR, "layer2_domains");
  const loaded = [];
  try {
    const files = fs.readdirSync(domainDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const key = path.basename(file, ".md");
      const text = fs.readFileSync(path.join(domainDir, file), "utf8");
      _layer2Cache.set(key, text);
      loaded.push(key);
    }
    console.log(`[prompt] Loaded ${loaded.length} domain modules: ${loaded.sort().join(", ")}`);
  } catch(e) {
    console.warn("[prompt] layer2_domains/ directory not found:", e.message);
  }

  const modesDir = path.join(PROMPTS_DIR, "layer3_modes");
  try {
    const files = fs.readdirSync(modesDir).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const key = path.basename(file, ".md").toUpperCase();
      const text = fs.readFileSync(path.join(modesDir, file), "utf8");
      _layer3Cache.set(normalizeModeKey(key), text);
    }
    console.log(`[prompt] Loaded ${_layer3Cache.size} mode overlays: ${[..._layer3Cache.keys()].join(", ")}`);
  } catch(e) {
    console.warn("[prompt] layer3_modes/ directory not found:", e.message);
  }
}

// mode accepts active labels ("GENERATE" | "A_PLUS") and legacy DB labels.
export function assemblePrompt(domainModuleKey, mode, runtimeInputs) {
  if (!_layer1Cache.text) {
    throw new Error("Prompt assembler not initialised - call loadAllPrompts() at startup");
  }

  let layer2Text = _layer2Cache.get(domainModuleKey);
  if (!layer2Text) {
    console.warn(`[prompt] Domain module "${domainModuleKey}" not found, falling back to "general"`);
    layer2Text = _layer2Cache.get("general") || "";
  }

  const modeKey = normalizeModeKey(mode);
  const layer3Text = _layer3Cache.get(modeKey) || "";
  if (!layer3Text) {
    console.warn(`[prompt] Mode overlay for "${modeKey}" not found - proceeding without it`);
  }

  const systemBlocks = [
    {
      type: "text",
      text: _layer1Cache.text,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: layer2Text,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: layer3Text,
      ...(layer3Text ? { cache_control: { type: "ephemeral" } } : {}),
    },
  ];

  return { systemBlocks, userMessage: runtimeInputs };
}
