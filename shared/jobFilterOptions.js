/**
 * THE FILTER OPTION CONTRACT — one definition per filterable dimension, in one file.
 *
 * WHY THIS FILE EXISTS. Every board filter is a contract with two sides: a `value` a UI control
 * emits, and a value the database actually holds. Nothing checks that the two sides meet, and when
 * they do not the control does not error — it silently matches zero rows, which reads to the user
 * as "there are no such jobs". Two of those shipped:
 *
 *     the select said        the column holds       result
 *     'mid level'            'mid'                  0 rows, forever
 *     'ai ml'                'ai_ml'                0 rows, forever
 *
 * Both were invisible for as long as the controls were wired to nothing, and became live defects
 * the moment they were wired up. They are the same defect class as three hardcoded tab lists
 * (fixed by appTabs), a filter row of no-op callbacks, half-migrated model IDs, and mapJobRow vs
 * normalizeApiJob: two sides of a contract that do not meet, with nothing failing loudly.
 *
 * De-duplication is the whole point — this changes no filter BEHAVIOUR. The values below are the
 * ones that already work; they are gathered here so they cannot diverge again.
 *
 * THREE RULES.
 *
 *   1. `value` IS THE DATABASE VALUE. Not a display slug, not a humanised string. If a dimension's
 *      column holds `ai_ml`, that is what appears here, and the human-readable form goes in
 *      `label`. Anything that needs prose derives it from `label`; anything that needs to query
 *      derives it from `value`.
 *   2. NO LITERAL OPTION VALUE ANYWHERE ELSE. UI options render FROM these arrays and query params
 *      are built FROM them. A hardcoded `<option value="senior">` is the bug, not a shortcut.
 *   3. DB VALUES IN USE THAT ARE DELIBERATELY NOT OFFERED ARE NAMED, NOT OMITTED. Each dimension
 *      carries `dbOnly` for values the column really holds that no control should offer — each with
 *      its label AND the reason it is not offered, in data rather than in a comment. That keeps the
 *      reconciliation test honest: a value has to be listed in one of the two places ON PURPOSE, so
 *      accidental drift still fails, and "why is this not a filter?" has an answer next to it.
 *
 * Consumed by the client (client/src/components/UnifiedSearchBar.jsx, client/src/panels/
 * JobsPanel.jsx, client/src/App.jsx), by the ingest writers whose enums define what the column can
 * hold (services/jobs/schema.js, services/jobs/enrichJob.js), by the profile bridge's level
 * ordering (services/jobs/profileFilterBridge.js), and by GET /api/jobs, which VALIDATES against
 * it so an unknown value is a 400 rather than an empty board.
 *
 * The reconciliation test is test/filterOptionContract.test.js. It asserts the join in BOTH
 * directions — a UI option with no DB counterpart, and a DB value in use with no UI option — the
 * same shape as test/privacyReconciliation.test.js. Without it, the next dimension added drifts
 * exactly the way these two did.
 */

// ── Experience level — scraped_jobs.experience_level ────────────────────────────────────────────
//
// Written by services/jobs/schema.js's normalizeExperienceLevel() at ingest and by
// services/jobs/enrichJob.js's coerceEnum() during enrichment; both now take their enum FROM here.
// Ordered junior -> senior, and that order is load-bearing: services/jobs/profileFilterBridge.js
// walks it to widen a derived level by one, and GET /api/jobs ranks by it for the YoE sorts.
export const EXPERIENCE_LEVELS = {
  param: "experience_levels",
  column: "sj.experience_level",
  multi: true,
  options: [
    { value: "intern",    label: "Intern"    },
    { value: "entry",     label: "Entry"     },
    { value: "mid",       label: "Mid"       },
    { value: "senior",    label: "Senior"    },
    { value: "lead",      label: "Lead"      },
    { value: "executive", label: "Executive" },
  ],
  dbOnly: [],
};

// ── Domain — scraped_jobs.bucket_domain ────────────────────────────────────────────────────────
//
// Written by services/jobs/classifyJob.js's detectDomain(). That function keeps its own
// DOMAIN_PATTERNS table because a domain is inseparable from the regex that detects it; the
// reconciliation test asserts the two tables name the same domains rather than importing one into
// the other and pretending the regexes live here.
export const DOMAINS = {
  param: "domain",
  column: "sj.bucket_domain",
  multi: false,
  options: [
    { value: "saas",       label: "Tech / SaaS"  },
    { value: "fintech",    label: "Fintech"      },
    { value: "healthtech", label: "Healthtech"   },
    { value: "ai_ml",      label: "AI / ML"      },
    { value: "ecommerce",  label: "E-commerce"   },
    { value: "climate",    label: "Climate Tech" },
    { value: "devtools",   label: "Dev Tools"    },
    { value: "edtech",     label: "EdTech"       },
  ],
  dbOnly: [
    { value: "general", label: "General", why:
      "detectDomain's fallback for 'matched no pattern' — 714 of 1,253 rows on this database. It " +
      "is the ABSENCE of a domain, not a domain, so offering it would read as a category." },
  ],
};

// ── Work model — scraped_jobs.workplace_type ───────────────────────────────────────────────────
//
// NOT scraped_jobs.work_type, which no write path populates. The legacy single-select over that
// column was removed for exactly that reason; this filters the column enrichment actually fills.
export const WORK_MODELS = {
  param: "work_models",
  column: "sj.workplace_type",
  multi: true,
  options: [
    { value: "remote", label: "Remote" },
    { value: "hybrid", label: "Hybrid" },
    { value: "onsite", label: "Onsite" },
  ],
  dbOnly: [],
};

// ── Employment type — scraped_jobs.employment_type ─────────────────────────────────────────────
// The canonical set is exactly what services/jobs/schema.js's EMPLOYMENT_TYPE_SYNONYMS maps ONTO,
// which is these four. Note what is NOT here: `temporary`. The synonym table folds it into
// `contract`, so the column can never hold it — server.js's dead VALID_EMP_TYPES listed it anyway,
// which is what a validation set that nothing reads decays into.
export const EMPLOYMENT_TYPES = {
  param: "employment_types",
  legacyParam: "employmentType",
  column: "sj.employment_type",
  multi: true,
  options: [
    { value: "full-time",  label: "Full-time"  },
    { value: "contract",   label: "Contract"   },
    { value: "internship", label: "Internship" },
    { value: "part-time",  label: "Part-time"  },
  ],
  dbOnly: [],
};

// ── Provider — scraped_jobs.source ───────────────────────────────────────────────────────────
//
// A HARD match, unlike the soft-null dimensions above: every scraped_jobs writer sets `source`, so
// there is no "not classified yet" state to protect.
//
// THIS DIMENSION HELD A THIRD INSTANCE OF THE 'mid level' / 'ai ml' DEFECT, and reconciling it is
// what found it. The drawer offered `LinkedIn`. No writer emits that; the extension's capture path
// writes `linkedin_extension` (services/jobs/aggregator.js's SOURCE_LABELS). So the option was
// unmatchable on its face, exactly like the two W1 fixed, and had been since it was added.
//
//   UI offered            writers emit           verdict
//   LinkedIn              linkedin_extension     never matched a row -> value corrected
//   (nothing)             workday                 real provider, unfilterable -> added
//   (nothing)             smartrecruiters         real provider, unfilterable -> added
//   (nothing)             workable                real provider, unfilterable -> added
//   (nothing)             recruitee               real provider, unfilterable -> added
//
// Labels are SOURCE_LABELS' labels, which is why `serpapi` reads "Google Jobs" and not "SerpAPI":
// the job cards have always called it that, and one provider with two names in two surfaces is the
// same drift in miniature. aggregator.js now derives SOURCE_LABELS from here.
//
// Measured on this database: greenhouse 626, ashby 626, import 1. The other options carry zero rows
// today and are still offered — the drawer shows a live "(0)" beside each from jobQuery.js's
// `sources` facet, so an empty provider is a visible fact about the data rather than a dead control.
export const SOURCES = {
  param: "sources_include",
  excludeParam: "sources_exclude",
  legacyParam: "source",
  column: "sj.source",
  multi: true,
  options: [
    { value: "greenhouse",         label: "Greenhouse"      },
    { value: "lever",              label: "Lever"           },
    { value: "ashby",              label: "Ashby"           },
    { value: "workday",            label: "Workday"         },
    { value: "smartrecruiters",    label: "SmartRecruiters" },
    { value: "workable",           label: "Workable"        },
    { value: "recruitee",          label: "Recruitee"       },
    { value: "jobo",               label: "Jobo"            },
    { value: "adzuna",             label: "Adzuna"          },
    { value: "serpapi",            label: "Google Jobs"     },
    { value: "linkedin_extension", label: "LinkedIn (Saved)" },
  ],
  dbOnly: [
    { value: "import", label: "Imported", why:
      "A job the user imported by hand. Not a provider you would browse the board by — it is the " +
      "user's own act, and the star Saved tab already answers 'the ones I chose'." },
  ],
};

// ── Automation tier — scraped_jobs.automation_tier ─────────────────────────────────────────────
//
// Values and order are services/jobs/automationTier.js's AUTOMATION_TIERS, which now imports them
// from here. Order is DECREASING confidence. The hints are the point of this control: "account" is
// the one that changes what the user has to do, and "unknown" must read as an open question rather
// than as either a promise or a warning.
export const AUTOMATION_TIERS = {
  param: "tiers_include",
  excludeParam: "tiers_exclude",
  column: "sj.automation_tier",
  multi: true,
  options: [
    { value: "direct",  label: "Direct",  hint: "No account — one-page apply" },
    { value: "guest",   label: "Guest",   hint: "Account optional, guest path exists" },
    { value: "account", label: "Account", hint: "You sign in once, then autofill takes over" },
    { value: "gated",   label: "Gated",   hint: "Account + CAPTCHA/ID check — cannot be automated" },
    { value: "unknown", label: "Unknown", hint: "Not established — may be either" },
  ],
  dbOnly: [],
};

// ── Board status — the user's own relationship to a row, not a column on the job ───────────────
//
// Each value maps to a DIFFERENT query param, which is why `param` is per-option here: this is one
// control over three unrelated predicates, and flattening it to a single param is what would need
// a translation layer somewhere else.
export const BOARD_STATUS = {
  param: "status",
  multi: false,
  options: [
    { value: "",        label: "All Jobs", emits: null },
    { value: "new",     label: "New Only", emits: { visited: "0" } },
    { value: "starred", label: "Starred",  emits: { starred: "1" } },
    { value: "applied", label: "Applied",  emits: { applied: "1" } },
  ],
  dbOnly: [],
};

// ── Sort — no column of its own; GET /api/jobs turns each into an ORDER BY ─────────────────────
export const SORTS = {
  param: "sort",
  multi: false,
  default: "dateDesc",
  options: [
    { value: "dateDesc", label: "Newest"          },
    { value: "dateAsc",  label: "Oldest"          },
    { value: "compHigh", label: "Pay high to low" },
    { value: "compLow",  label: "Pay low to high" },
    { value: "yoeLow",   label: "Exp low to high" },
    { value: "yoeHigh",  label: "Exp high to low" },
    { value: "atsScore", label: "ATS Sort"        },
  ],
  dbOnly: [
    { value: "applicantCount", label: "Fewest applicants", why:
      "Accepted by the handler's ORDER BY chain, offered by no control — sj.applicant_count has no " +
      "writer, so the ordering is real but the data is not. Named so the reconciliation test does " +
      "not read it as drift and nobody deletes the branch as dead." },
  ],
};

// ── Posting age — a named interval, not a date ─────────────────────────────────────────────────
//
// `days` is the definition; GET /api/jobs's AGE_MAP and JobsPanel's AGE_DAYS_MAP were two copies
// of it and both now read from here. `posted_after` is derived from the same number, so the two
// clauses that apply it cannot disagree about what "past week" means.
export const POSTING_AGE = {
  param: "ageFilter",
  derivedParam: "posted_after",
  multi: false,
  options: [
    { value: "",   label: "Any time",     days: null },
    { value: "1d", label: "Past 24h",     days: 1    },
    { value: "2d", label: "Past 2 days",  days: 2    },
    { value: "3d", label: "Past 3 days",  days: 3    },
    { value: "1w", label: "Past week",    days: 7    },
    { value: "1m", label: "Past month",   days: 30   },
  ],
  dbOnly: [],
};

// ── Visited — user_jobs.visited ────────────────────────────────────────────────────────────────
export const VISITED = {
  param: "visited",
  column: "uj.visited",
  multi: false,
  options: [
    { value: "",  label: "Visited & unvisited" },
    { value: "0", label: "Unvisited only"      },
    { value: "1", label: "Visited only"        },
  ],
  dbOnly: [],
};

/**
 * Every dimension, by name. The reconciliation test iterates THIS — so a dimension added below
 * without being registered here is itself caught, rather than being silently unguarded.
 */
export const FILTER_DIMENSIONS = {
  experienceLevel: EXPERIENCE_LEVELS,
  domain:          DOMAINS,
  workModel:       WORK_MODELS,
  employmentType:  EMPLOYMENT_TYPES,
  source:          SOURCES,
  automationTier:  AUTOMATION_TIERS,
  boardStatus:     BOARD_STATUS,
  sort:            SORTS,
  postingAge:      POSTING_AGE,
  visited:         VISITED,
};

// ── Readers ────────────────────────────────────────────────────────────────────────────────────
//
// Everything below derives from the tables above. None of it holds a value of its own.

/** DB values a control offers, in the dimension's own order. Excludes the empty "any" option. */
export function values(dim) {
  return dim.options.map(o => o.value).filter(v => v !== "");
}

/** Values the column holds that no control offers, each with its reason. */
export function dbOnlyValues(dim) {
  return (dim.dbOnly || []).map(d => d.value);
}

/** Every DB value the dimension can legitimately carry — offered or deliberately db-only. */
export function allValues(dim) {
  return [...values(dim), ...dbOnlyValues(dim)];
}

/** The enum a WRITER should coerce against: what the column is allowed to hold. */
export function valueSet(dim) {
  return new Set(allValues(dim));
}

/**
 * Human label for a DB value — offered or db-only. A db-only value still has to render somewhere
 * (an imported job's source chip says "Imported"), which is why the label lives with the value
 * rather than in a second map beside it.
 */
export function labelFor(dim, value) {
  return dim.options.find(o => o.value === value)?.label
      ?? (dim.dbOnly || []).find(d => d.value === value)?.label
      ?? String(value);
}

/** `{ value: label }` over EVERY value the dimension can carry. */
export function labelMap(dim) {
  return Object.fromEntries(allValues(dim).map(v => [v, labelFor(dim, v)]));
}

/**
 * Is this a value the dimension recognises? Used by GET /api/jobs to reject loudly.
 *
 * The empty string is always valid and always means "no opinion" — every caller relies on an
 * absent filter being expressible, and treating "" as unknown would 400 the default board.
 */
export function isValid(dim, value) {
  if (value === "" || value === null || value === undefined) return true;
  return allValues(dim).includes(String(value));
}

/**
 * Validate a comma-joined or single value, returning the offending entries.
 *
 * Multi-valued params arrive as "remote,hybrid" from the client's `.join(",")`, so a single
 * unknown entry inside an otherwise-valid list has to be reported by name — "invalid work_models"
 * with no indication of which one is the same dead end as the silent empty board.
 */
export function invalidEntries(dim, raw) {
  if (raw === "" || raw === null || raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map(v => v.trim()).filter(v => v !== "" && !isValid(dim, v));
}

/** Days for a posting-age key. The one place that mapping lives. */
export function ageDays(value) {
  return POSTING_AGE.options.find(o => o.value === value)?.days ?? null;
}

/** `{ "1d": 1, ... }` — the shape the two former hardcoded AGE maps had, built from the table. */
export function ageDaysMap() {
  return Object.fromEntries(
    POSTING_AGE.options.filter(o => o.days != null).map(o => [o.value, o.days]),
  );
}

/** Experience levels junior -> senior. The bridge's widening walks this. */
export const EXPERIENCE_LEVEL_ORDER = values(EXPERIENCE_LEVELS);
