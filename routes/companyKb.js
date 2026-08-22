import { Router } from "express";
import { confirmOrgUnit, mapOrgUnitRow } from "../services/kb/orgLayer.js";
import { mapFormSchemaRow } from "../services/kb/formSchemaLayer.js";
import { getHiringSignals } from "../services/jobs/hiringSignals.js";
import { getCompanyLca } from "../services/kb/lcaLayer.js";

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

  // The application forms we have learned for this company (TASK G4). Sits beside org-units because
  // a form schema is the same kind of fact: something the company publishes about itself, mined,
  // corroborated and decayed the same way.
  //
  // The full field list, unlike /api/apply/form-schema, which returns counts for the queue. This is
  // the read the imported-careers-page consumer needs — it wants the shape, not a summary of it.
  router.get("/:company/form-schemas", (req, res) => {
    const { company } = req.params;
    const rows = db.prepare(
      `SELECT * FROM company_form_schemas WHERE company = ? ORDER BY last_seen DESC`
    ).all(company);
    res.json({ company, formSchemas: rows.map(mapFormSchemaRow) });
  });

  // H-1B sponsorship evidence from DOL LCA filings (TASK X3). Returned WHOLE, including a match we
  // refuse to present — `presentable: false` with the reason is the answer to "why does the company
  // view say nothing about sponsorship for Mercury?", and hiding the row would make that
  // unanswerable. The client renders on `presentable`; this endpoint explains.
  router.get("/:company/lca", (req, res) => {
    const { company } = req.params;
    const lca = getCompanyLca(db, company);
    if (!lca) return res.json({ company, lca: null, reason: "not reconciled against LCA data yet" });
    res.json({ company, lca });
  });

  router.get("/:company/hiring-signals", (req, res) => {
    const { company } = req.params;
    const history = req.query.history === '1';
    const signals = getHiringSignals(db, company, { history });
    res.json({ company, signals });
  });

  return router;
}
