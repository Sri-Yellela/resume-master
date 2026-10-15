// A97 — what the service spent on the model, from the model_usage ledger. Read-only; counts only.
//
//   node scripts/modelUsageReport.mjs [--db <path>] [--since YYYY-MM-DD] [--json]
//
// --db defaults to the store the service itself opens (RM_DB_PATH, else the Railway volume), so on
// the server `railway ssh -s resume-master -- node scripts/modelUsageReport.mjs --since 2026-10-14`
// reads the live ledger. Totals are per UTC day × client × route × model × key; "unpriced" counts
// rows whose model has no price in src/model/prices.js (their cost is missing from the total).
import { openStoreReadOnly, resolveStorePath } from "../src/store/db.js";
import { modelUsageSummary } from "../src/accounts/modelUsage.js";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const file = arg("--db") || resolveStorePath(process.env);
if (!file) { console.error("no store: pass --db <path>, or set RM_DB_PATH / attach the volume"); process.exit(2); }
const sinceArg = arg("--since");
const since = sinceArg ? Math.floor(Date.parse(`${sinceArg}T00:00:00Z`) / 1000) : 0;
if (Number.isNaN(since)) { console.error(`--since: not a date: ${sinceArg}`); process.exit(2); }

const db = openStoreReadOnly(file);
const rows = modelUsageSummary(db, { since });
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows));
} else {
  console.table(rows);
  const total = rows.reduce((n, r) => n + (r.cost_usd || 0), 0);
  const unpriced = rows.reduce((n, r) => n + r.unpriced, 0);
  console.log(`total $${total.toFixed(4)} over ${rows.reduce((n, r) => n + r.calls, 0)} calls` +
    (unpriced ? ` — ⚠ ${unpriced} unpriced call(s) not in the total` : ""));
}
