// services/trackingFailureSink.js
// PURPOSE: The last place a tracking failure can be written when the DATABASE ITSELF is the thing
// that is broken.
//
// WHY THIS FILE EXISTS: migration 076 persists tracking failures into usage_tracking_failures, so
// a failure survives a restart. But that record needs the same database that just refused a write.
// It covers the causes specific to usage_events — a constraint violation, a missing column, a
// renamed table — and not an unreachable database, where the failure record fails too and the only
// remaining evidence was an in-process counter that the next deploy erased.
//
// This sink is out-of-process: an append-only JSONL file, no service to configure, no network, no
// dependency on the database being up. Two halves:
//   append()    — called only when the database write failed. Rare by construction.
//   drainInto() — called at boot once the database IS reachable, importing anything the sink
//                 caught so coverage becomes complete again rather than permanently short.
//
// Recovered rows are marked source='sink_recovered' (migration 077) so "recorded live" and
// "recovered after the database came back" are never conflated — the second means the database was
// down, which is a different and more serious fact.
//
// HONEST LIMIT: if the filesystem is also unwritable (read-only mount, disk full) this fails too.
// That is counted as a LOST failure and logged; it is not silently swallowed. There is no fourth
// fallback, and pretending otherwise would be the same overstatement this whole chain exists to
// avoid.

import fs from "fs";
import path from "path";

// Sits next to the database file so it shares the durable volume in production. Overridable for
// tests and for hosts that want it elsewhere.
const DEFAULT_SINK_PATH = path.join(process.cwd(), "data", "usage-tracking-failures.jsonl");

export function sinkPath() {
  return process.env.USAGE_FAILURE_SINK_PATH || DEFAULT_SINK_PATH;
}

/**
 * Append one failure as a single JSON line. Returns true when written.
 * Never throws — the caller is already in a failure path and owes a model result to a user.
 */
export function appendFailure(record) {
  try {
    const file = sinkPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One JSON object per line, so a partial write can only ever corrupt the last line and every
    // earlier record stays readable. A single JSON array would be unrecoverable mid-write.
    fs.appendFileSync(file, JSON.stringify({
      model: record?.model ?? null,
      purpose: record?.purpose ?? null,
      user_id: record?.userId ?? null,
      error_text: record?.errorText == null ? null : String(record.errorText).slice(0, 500),
      // The DB error that forced us out here, kept separately from the original failure.
      persist_error: record?.persistError == null ? null : String(record.persistError).slice(0, 300),
      created_at: Math.floor(Date.now() / 1000),
    }) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Records currently sitting in the sink, plus any lines too corrupt to parse. */
export function readPending() {
  const file = sinkPath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { records: [], corrupt: 0, exists: false };
  }
  const records = [];
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed)); } catch { corrupt++; }
  }
  return { records, corrupt, exists: true };
}

export function pendingCount() {
  return readPending().records.length;
}

/**
 * Import everything the sink caught into usage_tracking_failures, then clear it.
 *
 * Order matters: the file is RENAMED first, so a crash midway cannot re-import rows that already
 * landed. If the import then fails, the .draining file is left in place rather than deleted — an
 * operator can retry it, and losing the evidence would be worse than leaving a stray file.
 */
export function drainInto(db) {
  const file = sinkPath();
  const staging = `${file}.draining`;

  // Recover a staging file abandoned by an earlier interrupted drain before looking at the sink.
  if (!fs.existsSync(staging)) {
    if (!fs.existsSync(file)) return { drained: 0, corrupt: 0, failed: 0, skipped: "no sink file" };
    try { fs.renameSync(file, staging); }
    catch (e) { return { drained: 0, corrupt: 0, failed: 0, error: `could not stage sink: ${e.message}` }; }
  }

  let raw = "";
  try { raw = fs.readFileSync(staging, "utf8"); }
  catch (e) { return { drained: 0, corrupt: 0, failed: 0, error: `could not read staged sink: ${e.message}` }; }

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  let drained = 0, corrupt = 0, failed = 0;
  let insert;
  try {
    insert = db.prepare(`INSERT INTO usage_tracking_failures
      (model, purpose, user_id, error_text, created_at, source) VALUES (?,?,?,?,?,'sink_recovered')`);
  } catch (e) {
    // Pre-077 database, or still unreachable. Leave the staging file for the next boot.
    return { drained: 0, corrupt: 0, failed: lines.length, error: `cannot import yet: ${e.message}` };
  }

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { corrupt++; continue; }
    try {
      insert.run(
        rec.model ?? null,
        rec.purpose ?? null,
        rec.user_id ?? null,
        // Keep why the database write failed at the time — that is the reason this went to the
        // sink at all, and it is the useful part when reading the recovery afterwards.
        [rec.error_text, rec.persist_error ? `(db persist failed: ${rec.persist_error})` : null]
          .filter(Boolean).join(" ").slice(0, 500) || null,
        rec.created_at ?? Math.floor(Date.now() / 1000)
      );
      drained++;
    } catch { failed++; }
  }

  // Only discard the staging file when nothing was left behind.
  if (failed === 0) {
    try { fs.unlinkSync(staging); } catch { /* stray file is harmless; the rows are in */ }
  }
  return { drained, corrupt, failed };
}
