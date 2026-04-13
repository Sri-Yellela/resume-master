<!--
  What this file does:
    Domain module for construction project management roles.
    Applied when roleFamily="pm" and domain="construction".
    Provides construction-specific tool registry, keyword classes, action verbs,
    and summary framing for roles in GC, specialty contractor, owner/developer,
    civil/infrastructure, and public sector construction environments.

  What to change here if intent changes:
    - To add new construction software or companies: edit section B.
    - To add contract types or delivery methods: edit section C.
    - For general PM roles: edit pm_general.md.
    - For IT project management: edit pm_it.md.

  Depends on:
    - services/classifier.js (sets domainModuleKey="pm_construction")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: PROJECT MANAGEMENT — CONSTRUCTION

### A. DOMAIN CONTEXT

Construction project managers plan, budget, schedule, and coordinate multi-trade projects from pre-construction through closeout. Success is measured by on-budget delivery, schedule adherence, safety record, and subcontractor performance. The vocabulary is trade-specific and schedule-driven: RFIs, submittals, change orders, CPM scheduling, punch lists, lien waivers, bid levelling, value engineering, and commissioning.

### B. CANONICAL TOOL REGISTRY

- **General contractors (Turner, Skanska, Gilbane, McCarthy, Hensel Phelps):** Procore, Primavera P6, Bluebeam Revu, Autodesk Build, Microsoft Project, PlanGrid, BIM 360, Textura, SharePoint
- **Specialty contractors (mechanical, electrical, plumbing):** Trimble, Accubid, Viewpoint, Procore, PlanGrid, Bluebeam
- **Owners/developers (Boston Properties, Related Companies):** Procore, CMiC, JD Edwards, Oracle Primavera, Yardi, PlanGrid
- **Civil and infrastructure (AECOM, Jacobs, WSP):** Primavera P6, BIM 360, Oracle Aconex, HCSS, Trimble
- **Design-build firms (DPR, Mortenson):** BIM 360, Procore, Autodesk Construction Cloud, RIB iTWO
- **Public sector/transit (MTA, MBTA capital programs):** Oracle Aconex, Primavera P6, SharePoint, Unifier

### C. TIER 1 KEYWORD CLASSES

- Scheduling tools and methodologies (CPM, Gantt, look-ahead schedules)
- Construction management platforms
- BIM and digital delivery tools
- Contract types (GMP, lump sum, IDIQ, design-build)
- Procurement and subcontractor management
- Safety programmes (OSHA 30, site safety plans)
- Cost control and forecasting (GMP, cost-to-complete, change order management)
- Quality and commissioning
- Specific trade or project type vocabulary

### D. ACTION VERB POOL

Managed, Coordinated, Procured, Negotiated, Scheduled, Delivered, Supervised, Commissioned, Tracked, Resolved, Prepared, Reviewed, Approved, Executed, Mitigated, Forecasted, Administered, Inspected, Facilitated, Closed out, Value-engineered, Bid-levelled, Escalated, Monitored, Reported

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and project type (commercial, infrastructure, healthcare, multi-family, etc.). Name scheduling platform, contracting method expertise, and typical project scale (dollar value range). Close using delivery vocabulary from the JD.
