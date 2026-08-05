import { Router } from "express";
import { confirmOrgUnit } from "../services/kb/orgLayer.js";
import { getHiringSignals } from "../services/jobs/hiringSignals.js";

function mapOrgUnitRow(row) {
  return {
    orgUnit:            row.org_unit,
    domain:             row.domain,
    stacks:             JSON.parse(row.stacks_json || '[]'),
    seniority:          JSON.parse(row.seniority_json || '{}'),
    confidence:         row.confidence,
    corroborationCount: row.corroboration_count,
    status:             row.status,
    firstSeen:          row.first_seen,
    lastSeen:           row.last_seen,
    sourcePostings:     JSON.parse(row.source_postings_json || '[]'),
  };
}

// Read surface for the two Company KB layers (Task 9.5 org units, Task 9.7 hiring signals).
// No UI in either task — API only, FE later. `requireAdmin` is passed in from server.js's
// existing middleware (already gating /api/admin/*) rather than duplicated here.
export function createCompanyKbRouter(db, requireAdmin) {
  const router = Router();

  router.get("/:company/org-units", (req, res) => {
    const { company } = req.params;
    const { status } = req.query;
    const rows = status
      ? db.prepare(`SELECT * FROM company_org_units WHERE company = ? AND status = ? ORDER BY confidence DESC`).all(company, status)
      : db.prepare(`SELECT * FROM company_org_units WHERE company = ? ORDER BY confidence DESC`).all(company);
    res.json({ company, orgUnits: rows.map(mapOrgUnitRow) });
  });

  // Admin/owner-gated: this writes ground truth (a human-confirmed org unit), never public.
  router.post("/:company/org-units/:orgUnit/confirm", requireAdmin, (req, res) => {
    const { company, orgUnit } = req.params;
    const ok = confirmOrgUnit(db, company, orgUnit);
    if (!ok) return res.status(404).json({ error: "Org unit not found for this company" });
    res.json({ ok: true });
  });

  router.get("/:company/hiring-signals", (req, res) => {
    const { company } = req.params;
    const history = req.query.history === '1';
    const signals = getHiringSignals(db, company, { history });
    res.json({ company, signals });
  });

  return router;
}
