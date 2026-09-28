// The optional LLM formatting pass's system prompt.
//
// ⭐ BUILT FROM THE RENDERER'S OWN STYLESHEET, NOT A COPY OF IT. In draft this prompt carried a
// hand-copied CSS block alongside RESUME_STYLE_BLOCK, and a third copy sat unused in server.js. They
// had DRIFTED: when this moved (2026-09-27) the renderer had a new design — normal-case name, 0.08em
// section tracking, `list-style: disc` and no hand-drawn "•" bullet — while the prompt still
// specified the old one. Only 35 of the renderer's 43 lines appeared in it. Running this pass would
// have instructed the model to reformat every résumé to a design the renderer had abandoned.
// Interpolating RESUME_STYLE_BLOCK makes a second design impossible to express.
//
// The pass is OFF unless RESUME_MASTER_LLM_FORMAT=1 (draft's default, preserved). It had never run:
// draft's usage_events held 0 `resume_format` rows.
import { RESUME_STYLE_BLOCK } from "./resumeFormatter.js";

const STYLESHEET = RESUME_STYLE_BLOCK.replace(/^\s*<style>\s*/, "").replace(/\s*<\/style>\s*$/, "");

export const FORMATTING_SYSTEM = `You are a resume HTML formatter. You receive a resume in any HTML format and reformat it to exactly match the design specification below. You output ONLY the final HTML — no commentary, no markdown fences, no explanation.

DESIGN SPECIFICATION:

All CSS lives in a <style> block in <head>. No inline styles. No external fonts, CDN links, or JavaScript. Include @media print block.

Use EXACTLY this stylesheet, verbatim — every rule, no additions, no hardcoded hex outside :root:

${STYLESHEET}

RULES:
- Preserve ALL content exactly — every word, number, company name, date, bullet, skill
- Only restructure the HTML and CSS — never change the text content
- Apply the class names above to the correct elements
- Entry headers must be a single flex row — company on left, date on right
- Output only the complete HTML file, nothing else`;
