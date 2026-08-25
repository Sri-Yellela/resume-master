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

/**
 * Prompt-file conditionals, so an opt-out section's RULES never reach the model (AI1 requirement 3).
 *
 * WHY NOT STRIP THE OUTPUT INSTEAD
 * Generating a summary and deleting it downstream pays for tokens that are thrown away, and leaves
 * a stripping step that fails OPEN — one regex that stops matching and the section the candidate
 * turned off is on their resume, silently. The rule coming out of the prompt has no such failure
 * mode: the model is never told to write the section, so there is nothing to remove.
 *
 * WHY MARKERS IN THE MARKDOWN RATHER THAN A SECOND PROMPT FILE
 * The SUMMARY rules are not one contiguous block — the output contract lists the section, the
 * STRUCTURE rules normalise its label and fix its position, and the final silent check names its
 * length. A parallel copy of layer 1 would be four places to keep in step and one place to forget.
 * Markers keep the two variants adjacent to each other and to the rules they qualify.
 *
 * Syntax, deliberately HTML comments so the files stay readable markdown:
 *   <!--IF:SUMMARY-->kept when the flag is on<!--ENDIF-->
 *   <!--IFNOT:SUMMARY-->kept when the flag is off<!--ENDIF-->
 * Spans may be inline or span lines. An unknown flag name is treated as OFF rather than ignored:
 * a typo that silently kept a rule would defeat the point of removing it.
 */
const CONDITIONAL_RE = /<!--\s*(IF|IFNOT):([A-Z_]+)\s*-->([\s\S]*?)<!--\s*ENDIF\s*-->/g;

export function applyPromptConditionals(text, flags = {}) {
  return String(text ?? "").replace(CONDITIONAL_RE, (_m, kind, name, body) => {
    const on = flags[name] === true;
    return (kind === "IF") === on ? body : "";
  })
    // A removed block leaves the blank lines that framed it; three or more in a row become two so
    // the assembled prompt reads as prose rather than as something with holes cut in it.
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\r\n){3,}/g, "\r\n\r\n");
}

// mode accepts active labels ("GENERATE" | "A_PLUS") and legacy DB labels.
//
// `flags` gates the prompt-file conditionals above. SUMMARY defaults to FALSE — the same default
// as the per-profile preference it carries, so a caller that forgets to pass it gets the documented
// product default rather than a quietly different resume.
export function assemblePrompt(domainModuleKey, mode, runtimeInputs, flags = {}) {
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

  // Resolved against the CACHED file text, never written back to the cache — the same process
  // serves users whose preferences differ, and a resolved copy in _layer1Cache would leak one
  // user's setting into the next request.
  //
  // Prompt caching still works: SUMMARY has two values, so there are two stable variants of each
  // block rather than one, and each is byte-identical call to call.
  const resolvedFlags = { SUMMARY: flags.SUMMARY === true };
  const layer1Resolved = applyPromptConditionals(_layer1Cache.text, resolvedFlags);
  const layer2Resolved = applyPromptConditionals(layer2Text, resolvedFlags);
  const layer3Resolved = applyPromptConditionals(layer3Text, resolvedFlags);

  const systemBlocks = [
    {
      type: "text",
      text: layer1Resolved,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: layer2Resolved,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: layer3Resolved,
      ...(layer3Resolved ? { cache_control: { type: "ephemeral" } } : {}),
    },
  ];

  return { systemBlocks, userMessage: runtimeInputs, flags: resolvedFlags };
}
