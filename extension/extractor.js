// Injected into the page by chrome.scripting.executeScript, under the activeTab grant the user's
// own invocation creates. It is NOT a content script and must never become one — a content script
// needs a host permission for every origin it runs on, which is exactly the constraint that kept
// capture off Greenhouse boards embedded on a company's own careers domain.
//
// THESE FUNCTIONS ARE SERIALISED. executeScript sends the function's SOURCE to the page, so nothing
// outside a function body travels with it: no imports, no module constants, no shared helpers at
// file scope. Everything each entry point needs is nested inside it. That is why EXTRACTORS is
// declared inside extractJobPayload() rather than hoisted, and why the two exports below duplicate
// nothing between them — there is no scope in which they could share.

/**
 * Everything the capture needs, read from whatever page the user invoked on.
 *
 * Returns { ok, title, company, location, url, text }. `text` is the flattened block the importer
 * takes; sending it is what stops the server round-tripping a needsClientCapture back to the client
 * that already holds the content.
 */
export function extractJobPayload() {
  // ── JSON-LD first. Most modern boards publish a JobPosting and it beats every selector. ──
  function extractJsonLdJobPosting() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        let data = JSON.parse(s.textContent);
        if (data['@graph']) data = data['@graph'];
        if (Array.isArray(data)) {
          const hit = data.find(item => item['@type'] === 'JobPosting');
          if (hit) return hit;
        } else if (data['@type'] === 'JobPosting') {
          return data;
        }
      } catch (_) {}
    }
    return null;
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.innerText || div.textContent || '').trim();
  }

  // Per-site description containers, for pages with no JSON-LD. Keyed by registrable domain and
  // matched with hostname.includes(), so job-boards.greenhouse.io and boards.greenhouse.io both
  // resolve to the greenhouse entry.
  //
  // This map is now an OPTIMISATION, not a gate. Before capture moved to activeTab it doubled as
  // the list of sites that worked at all; an unlisted site could not be captured because no content
  // script ran there. Now an unlisted site falls through to the generic path below and still works
  // — worse-targeted, not broken — which is what makes an embedded Greenhouse board on a company's
  // own domain capturable at all.
  const EXTRACTORS = {
    'linkedin.com': () => trySelectors([
      '.job-details-module__content',
      '.jobs-description__content',
      '#job-details',
      '[data-test-job-details-description]',
      '.jobs-description__content .jobs-box__html-content',
      '.jobs-description-content__text',
      '.job-view-layout',
    ]),
    'indeed.com':    () => trySelectors(['#jobDescriptionText']),
    'glassdoor.com': () => trySelectors(['.jobDescriptionContent']),
    'lever.co':      () => trySelectors(['.posting-description', '.section-wrapper']),
    // boards.greenhouse.io 301s to job-boards.greenhouse.io for every board, and #content — the
    // selector this used to carry — exists on neither.
    'greenhouse.io': () => trySelectors(['.job__description', 'main.job-post']),
    'workable.com':  () => trySelectors(['.job-description']),
    // Ashby renders through CSS modules, so its description class carries a build hash —
    // `_descriptionText_5yu8i_201` today, something else after their next deploy. An earlier version
    // of this file pinned one of those hashes verbatim, which never matched anything and was only
    // harmless because Ashby also publishes JSON-LD and that path wins first. `#overview` is theirs
    // and stable; the attribute-contains selector survives the hash rotating.
    'ashbyhq.com':   () => trySelectors(['#overview', '[class*="descriptionText"]']),
    // Workday's automation ids are contractual — they exist so their own test tooling can find
    // things — which makes them the most durable hooks on any board here.
    //
    // ADDING THIS EXTRACTOR DOES NOT MEAN ADDING A WORKDAY HOST PERMISSION, and it must never come
    // to mean that. Workday is the gated portal the handoff fills; its pages are reached only
    // through the activeTab grant the user's own invocation creates, and a host permission would
    // silently convert that into standing access to every tenant. Capture reaching a Workday
    // posting is the same per-invocation read as any other page.
    'myworkdayjobs.com': () => trySelectors([
      '[data-automation-id="jobPostingDescription"]',
      '[data-automation-id="job-posting-details"]',
    ]),
  };

  function trySelectors(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el?.innerText?.trim().length > 100) return el.innerText.trim();
      } catch (_) {}
    }
    return genericDescription();
  }

  // The fallback that makes an unknown site work. Prefers the largest plausible content block over
  // document.body, because body on a careers page is mostly chrome — nav, cookie banner, footer.
  function genericDescription() {
    const candidates = [
      ...document.querySelectorAll('main, article, [role="main"], [class*="description"], [id*="description"], [class*="job"], [id*="content"]'),
    ];
    let best = null;
    for (const el of candidates) {
      const len = el.innerText?.trim().length || 0;
      // An element that is almost the whole page is the page, not the description.
      if (len > 200 && len < 40000 && (!best || len > best.len)) best = { el, len };
    }
    if (best) return best.el.innerText.trim().slice(0, 12000);
    return (document.body?.innerText || '').trim().slice(0, 12000);
  }

  function extractJobText() {
    const posting = extractJsonLdJobPosting();
    if (posting?.description) return stripHtml(posting.description).slice(0, 12000);
    const key = Object.keys(EXTRACTORS).find(k => window.location.hostname.includes(k));
    return key ? EXTRACTORS[key]() : genericDescription();
  }

  function extractSalary() {
    const sels = [
      '.job-details-jobs-unified-top-card__job-insight span[aria-hidden="true"]',
      '.compensation__salary',
      '[data-test-compensation-summary]',
      '.salary-main-rail__formatted-salary',
    ];
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const txt = el.textContent.trim();
          if (/\$|£|€|\/yr|\/hr|per year|per hour|salary/i.test(txt)) return txt;
        }
      } catch (_) {}
    }
    return null;
  }

  function firstText(selectors) {
    for (const sel of selectors) {
      try {
        const t = document.querySelector(sel)?.innerText?.trim();
        if (t) return t;
      } catch (_) {}
    }
    return '';
  }

  // LinkedIn earns its own selector set: it publishes no JSON-LD on the job view and its markup is
  // stable enough to be worth naming. Everything else goes through the generic path.
  function linkedInData() {
    const ld = extractJsonLdJobPosting();
    const ldOrg = ld?.hiringOrganization;
    const ldLoc = ld?.jobLocation;
    const ldCity = Array.isArray(ldLoc) ? ldLoc[0]?.address?.addressLocality : ldLoc?.address?.addressLocality;

    return {
      title: (ld?.title?.trim() || firstText([
        '.job-details-jobs-unified-top-card__job-title h1',
        '.job-details-jobs-unified-top-card__job-title',
        '[data-test-job-details-title]',
        '.jobs-unified-top-card__job-title h1',
        'h1.t-24',
      ]) || document.title.replace(/ \| LinkedIn$/, '')).trim(),
      company: ((typeof ldOrg === 'string' ? ldOrg : ldOrg?.name)?.trim() || firstText([
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__primary-description-container a',
        '[data-test-job-details-company-name]',
        '.jobs-unified-top-card__company-name a',
        '.jobs-unified-top-card__company-name',
      ])).trim(),
      location: (ldCity?.trim() || firstText([
        '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
        '.job-details-jobs-unified-top-card__workplace-type',
        '[data-test-job-details-location]',
        '.jobs-unified-top-card__bullet',
        '.job-details-jobs-unified-top-card__bullet',
      ])).trim(),
      workType: firstText([
        '.jobs-unified-top-card__workplace-type',
        '.job-details-jobs-unified-top-card__workplace-type',
      ]),
      salary: extractSalary(),
    };
  }

  /**
   * The employer's own spelling of `token`, found wherever the page already writes it.
   *
   * A hostname tells you WHICH word is the company but not how the company capitalises it, and
   * "Nvidia" is not how NVIDIA writes it. So the host decides the token and the page decides the
   * casing. Returns '' when the page never spells the token out, which is the signal to fall back
   * rather than to invent something.
   */
  function casedToken(token, extraSources = []) {
    if (!token) return '';
    const re = new RegExp('\\b' + token.replace(/[^a-z0-9]/gi, '.') + '\\b', 'i');
    for (const src of [...extraSources, document.title,
                       document.querySelector('h1')?.innerText || '',
                       document.querySelector('meta[property="og:site_name"]')?.content || '',
                       ...[...document.querySelectorAll('img')].map(i => i.alt || '')]) {
      const m = src && re.exec(src);
      if (m) return m[0];
    }
    return '';
  }

  // Hosts that belong to an applicant tracking system rather than to an employer. On these the
  // hostname says who runs the job board, not who is hiring — deriving a company from it would file
  // every Lever posting under "Lever". This list is the load-bearing half of the host fallback
  // below; without it the fallback is actively worse than leaving the company blank.
  const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|workable\.com|linkedin\.com|indeed\.com|glassdoor\.com|smartrecruiters\.com|icims\.com|jobvite\.com|breezy\.hr|teamtailor\.com|recruitee\.com|bamboohr\.com|paylocity\.com|dayforcehcm\.com|taleo\.net|successfactors\.com|eightfold\.ai|ripplingats\.com|pinpointhq\.com|personio\.de)$/i;

  /**
   * The employer, inferred from their own domain — for career pages that state the company nowhere
   * a machine can read it.
   *
   * databricks.com serves a posting with no JSON-LD, no og:site_name, and the company only as a
   * title suffix ("… - Databricks"). Employers hosting their own listings are the common case for
   * this, and they are exactly the pages the extension could not reach at all before capture moved
   * to activeTab, so nothing here had to be right until now.
   *
   * Deliberately conservative: it runs only when nothing else produced a company, never on an ATS
   * host, and never invents a name the page does not already contain.
   */
  function companyFromEmployerHost() {
    const host = location.hostname.replace(/^www\./, '');
    if (ATS_HOSTS.test(host)) return '';
    const parts = host.split('.');
    // Walk in from the TLD past registry suffixes, so foo.co.uk yields "foo" rather than "co".
    let i = parts.length - 2;
    while (i > 0 && /^(co|com|org|net|gov|ac|edu)$/i.test(parts[i])) i--;
    return casedToken(parts[i] || '');
  }

  // Workday's hiringOrganization is an internal org unit, not the employer. Measured across two
  // tenants: "2100 NVIDIA USA" and "100 Salesforce, Inc." — a numeric company code, then a regional
  // or legal-entity variant of the name. Stored as-is, neither would match the same employer
  // captured from Greenhouse or LinkedIn, so the cross-source reconciler would treat them as
  // different companies. The tenant is the FIRST label here, not the registrable domain.
  function workdayCompany(rawOrg) {
    const tenant = location.hostname.split('.')[0];
    const stripped = (rawOrg || '').replace(/^\d+\s+/, '').trim();
    if (!tenant) return stripped;
    // The org name goes in front: it is where the employer's real casing usually appears.
    const cased = casedToken(tenant, [rawOrg]);
    if (cased) return cased;
    // The tenant is an abbreviation the page never spells out (ipg, hcahealthcare). The org name
    // with its code stripped is then the better of the two, not the worse.
    return stripped || tenant.charAt(0).toUpperCase() + tenant.slice(1);
  }

  function genericData() {
    const ld = extractJsonLdJobPosting();
    const ldOrg = ld?.hiringOrganization;
    const ldLoc = ld?.jobLocation;
    const ldCity = Array.isArray(ldLoc) ? ldLoc[0]?.address?.addressLocality : ldLoc?.address?.addressLocality;

    let title = ld?.title?.trim() || '';
    let company = (typeof ldOrg === 'string' ? ldOrg : ldOrg?.name)?.trim() || '';

    if (!title) {
      // "Title at Company - Site", the shape almost every ATS uses for <title>. The site suffix
      // list is a convenience: an unmatched suffix costs a slightly noisier title, not a failure.
      const clean = document.title
        // Greenhouse titles every posting "Job Application for <role>", which would otherwise be
        // stored as the job title verbatim. Measured on real job-boards.greenhouse.io pages.
        .replace(/^\s*Job Application for\s+/i, '')
        .replace(/\s*[-–—|]\s*(Indeed|Glassdoor|Workable|Greenhouse|Lever|Ashby|Careers?|Jobs).*$/i, '')
        .trim();
      const parts = clean.split(/\s+(?:at|@)\s+/i);
      title = parts[0]?.trim() || clean;
      if (!company) company = parts[1]?.trim() || '';
    }
    if (!title) title = firstText(['h1']);

    if (location.hostname.includes('myworkdayjobs.com')) company = workdayCompany(company);
    if (!company) company = companyFromEmployerHost();

    // "<role> - Databricks". Once the company is known it can be taken off the end of the title,
    // which the fixed suffix list above could never do — it only knows the ATS vendors, and an
    // employer's own careers page is titled with the employer.
    if (company) {
      title = title.replace(
        new RegExp('\\s*[-–—|]\\s*' + company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'),
        '').trim();
    }

    return { title, company, location: ldCity?.trim() || '', workType: '', salary: null };
  }

  const isLinkedIn = window.location.hostname.includes('linkedin.com');
  const data = isLinkedIn ? linkedInData() : genericData();
  const description = extractJobText();

  const text = [
    data.title    && `Title: ${data.title}`,
    data.company  && `Company: ${data.company}`,
    data.location && `Location: ${data.location}`,
    data.workType && `Work Type: ${data.workType}`,
    data.salary   && `Salary: ${data.salary}`,
    '',
    description || '',
  ].filter(v => v !== '' && v !== false).join('\n');

  return {
    // A title alone is not a job. Requiring a description too is what stops a stray page with an
    // <h1> being filed as a posting now that capture is no longer fenced to six known sites.
    ok: !!data.title && (description || '').length > 120,
    title: data.title,
    company: data.company,
    location: data.location,
    url: window.location.href,
    text,
  };
}

/**
 * The capture result, shown in the page the user is looking at.
 *
 * This used to be part of the content script, so it only ever appeared on the six declared boards.
 * Injected on demand it now appears wherever the user captured, which is the whole point.
 */
export function showCaptureToast(message, success) {
  let toast = document.getElementById('rm-capture-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rm-capture-toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      zIndex: '2147483647', color: '#fff',
      borderRadius: '10px', padding: '10px 16px', fontSize: '13px', fontWeight: '600',
      boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      transition: 'opacity 0.2s ease', opacity: '0',
    });
    document.body.appendChild(toast);
  }
  toast.style.background = success ? '#437A22' : '#a12c2c';
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 4000);
}
