// The company avatar — ONE copy (TASK AE5).
//
// This existed three times: in JobCard.jsx, JobDetailPanel.jsx and JobsPanel.jsx, byte-for-byte
// identical apart from a default `size` and a corner radius. AE5 found out the hard way that three
// copies is not a tidiness complaint: the logo fallback was added to JobsPanel's copy, the board
// renders JobCard's, and the change had no effect at all on the surface it was written for. The
// harness caught it because it measures rendered <img> elements rather than reading the source.
//
// So the three are now one, and `radius` is a prop because that is the only thing the three callers
// ever genuinely disagreed about.
//
// THE LOGO, AND WHY THE FALLBACK MATTERS
// A row's own `companyIconUrl` wins: it came from the feed that found the job and is the most
// specific thing we know. Failing that, the known-domain table in shared/companyLogos.js resolves
// one with no request — the same table the server's enrichment uses, imported rather than restated.
// `scraped_jobs.company_icon_url` is only populated by the writers whose feed happens to carry a
// logo, so before this every jobo/greenhouse/ashby row on the board showed a coloured letter.
//
// A GUESS IS NOT A LOGO. getKnownLogoUrl returns null for a company it does not know, so an unknown
// employer still gets the lettered tile. Handing it a slug guess would render a broken image for
// every small company on the board, which is worse than a letter, not better.
//
// `onError` keeps the last line of defence: a URL that 404s falls back to the letter at runtime.
//
// WHY THE FAILURE MEMO IS MODULE-LEVEL, NOT COMPONENT STATE (TASK X)
// `failed` is per-instance, so it only ever silenced the card it was set on. The board unmounts and
// remounts cards as it scrolls and paginates, and a remount starts at `failed = false` — so a dead
// logo host was re-requested per card, and again per scroll, for the whole session. With Clearbit's
// DNS gone that was a failing request on every board render, which is the actual cost of this bug;
// the missing image was only the visible half.
//
// A Set keyed by URL fixes that for every card at once: the first failure anywhere is remembered,
// and no component asks for that URL again. It is deliberately session-scoped and deliberately not
// state — persisting it would cache a transient network blip forever, and making it state would put
// a shared value back inside one component's lifecycle, which is the bug.
import { useState } from "react";
import { getKnownLogoUrl } from "../../../../shared/companyLogos.js";

const failedLogoUrls = new Set();

export default function CompanyIcon({ company, iconUrl, size = 48, radius = 10 }) {
  const [, forceRender] = useState(0);
  const letter = (company || "?")[0].toUpperCase();
  // Deterministic colour from the company name, so a given employer's tile is always the same one.
  const colors = ["#0A66C2", "#7c3aed", "#0891b2", "#16a34a", "#dc2626", "#d97706", "#9333ea"];
  let hash = 0;
  for (const c of company || "") hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  const bg = colors[hash % colors.length];

  const resolved = iconUrl || getKnownLogoUrl(company);

  if (resolved && !failedLogoUrls.has(resolved)) {
    return (
      <img src={resolved} alt={company}
        onError={() => { failedLogoUrls.add(resolved); forceRender(n => n + 1); }}
        style={{ width: size, height: size, borderRadius: radius, objectFit: "contain",
                 border: "1px solid transparent", background: "transparent", flexShrink: 0 }}/>
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: radius, background: bg, color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 800, fontSize: Math.round(size * 0.38), flexShrink: 0,
                  letterSpacing: "-0.5px" }}>
      {letter}
    </div>
  );
}
