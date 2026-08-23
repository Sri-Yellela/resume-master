/**
 * AE1/AE2 diagnosis — instrument ONE live run against the real Ashby posting.
 * Reports, in order: readiness, what detectGate matched (per selector, with VISIBILITY),
 * what classifyFlowState returned, and what discovery found per frame.
 * Read-only: nothing is typed, nothing is clicked.
 */
import { launchBrowserPage } from "../services/browserLauncher.js";
import { waitForFormReady, detectGate, classifyFlowState, frameList, discoverFields } from "../services/applyAutomation.js";
import { detectPlatformFromUrl } from "../services/platformDetector.js";

const URL_ = process.argv[2] || "https://jobs.ashbyhq.com/openai/0432731c-f229-476e-92b6-d53491e79096/application";

const { browser, page } = await launchBrowserPage({ headless: "new", mode: "auto" });
try {
  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log(`\n[1] navigated in ${Date.now() - t0}ms -> ${page.url()}`);

  const readiness = await waitForFormReady(page);
  console.log(`[2] readiness: ${JSON.stringify(readiness)}`);

  // Per-selector breakdown of the SAME expression detectGate uses, plus visibility.
  const SELECTORS = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
    '.g-recaptcha', '.h-captcha', '[data-sitekey]',
    'input[type="password"]',
  ];
  const breakdown = await page.evaluate(`(() => {
    const sels = ${JSON.stringify(SELECTORS)};
    const out = [];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push({
          selector: s, tag: el.tagName.toLowerCase(),
          w: Math.round(r.width), h: Math.round(r.height),
          display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
          src: (el.getAttribute('src') || '').slice(0, 120),
          cls: (el.className || '').toString().slice(0, 80),
        });
      }
    }
    return out;
  })()`);
  console.log(`[3] gate-selector matches (${breakdown.length}):`);
  for (const m of breakdown) console.log('    ' + JSON.stringify(m));

  console.log(`[4] detectGate  -> ${await detectGate(page)}`);
  const origin = new URL(URL_).hostname;
  console.log(`[5] classifyFlowState -> ${await classifyFlowState(page, origin)}`);

  const frames = frameList(page);
  console.log(`[6] frames: ${frames.length}`);
  let total = 0;
  for (const f of frames) {
    const fields = await discoverFields(f, detectPlatformFromUrl(URL_)).catch(e => { console.log('    discover error: ' + e.message); return []; });
    total += fields.length;
    console.log(`    frame ${JSON.stringify((f.url()||'').slice(0,70))}: ${fields.length} fields`);
    for (const fl of fields.slice(0, 40)) console.log(`      - ${JSON.stringify({label: fl.label, name: fl.name, type: fl.type, req: fl.is_required})}`);
  }
  console.log(`[7] TOTAL DISCOVERED = ${total}`);
} finally {
  await browser.close();
}
