// routes/domainProfiles.js — Domain profile CRUD + chip generation
import { Router }        from "express";
import Anthropic         from "@anthropic-ai/sdk";
import { createRequire } from "module";
import fs                from "fs";
import path              from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Inline fallback — always available even when the JSON file can't be read
// (e.g. Railway container filesystem restrictions). Update this when the
// DOMAIN_METADATA_REGISTRY.json file changes.
const BUILTIN_REGISTRY = {
  engineering: { label:"Software Engineering", roleFamily:"engineering", suggestedTitles:["Software Engineer","Backend Engineer","Frontend Engineer","Full Stack Engineer","Software Developer","Site Reliability Engineer","Platform Engineer","Staff Engineer"], keywords:["distributed systems","microservices","REST APIs","system design","cloud infrastructure","CI/CD","kubernetes","docker","scalability","reliability","performance optimisation","code review","technical leadership","agile","object oriented"], actionVerbs:["Built","Designed","Deployed","Migrated","Refactored","Optimised","Implemented","Automated","Architected","Scaled","Shipped","Debugged","Instrumented","Integrated","Reduced"], tools:["Python","Java","Go","TypeScript","React","Node.js","PostgreSQL","Redis","Kafka","AWS","GCP","Azure","Terraform","Git","Kubernetes","Docker","Spark","Airflow"] },
  data: { label:"Data Science & Analytics", roleFamily:"data", suggestedTitles:["Data Scientist","Data Analyst","ML Engineer","Analytics Engineer","Research Scientist","Quantitative Analyst","Business Intelligence Analyst","Data Engineer"], keywords:["machine learning","statistical modelling","A/B testing","data pipelines","feature engineering","model deployment","experimentation","SQL","data warehousing","ETL","business intelligence","predictive modelling","NLP","deep learning","data visualisation","hypothesis testing"], actionVerbs:["Analysed","Modelled","Forecasted","Built","Deployed","Evaluated","Identified","Quantified","Surfaced","Synthesised","Designed","Implemented","Optimised","Automated","Presented"], tools:["Python","R","SQL","TensorFlow","PyTorch","Spark","Airflow","dbt","Tableau","Looker","BigQuery","Snowflake","Databricks","MLflow","Pandas","scikit-learn","Jupyter"] },
  pm_general: { label:"Product Management", roleFamily:"pm", suggestedTitles:["Product Manager","Senior Product Manager","Associate Product Manager","Group Product Manager","Director of Product","Technical Product Manager","Principal Product Manager"], keywords:["product roadmap","user research","go-to-market","stakeholder management","product strategy","OKRs","KPIs","product lifecycle","prioritisation","agile","scrum","sprint planning","product vision","market analysis","customer discovery","cross-functional","feature definition"], actionVerbs:["Led","Launched","Defined","Prioritised","Delivered","Aligned","Drove","Partnered","Coordinated","Influenced","Managed","Shipped","Analysed","Identified","Presented"], tools:["Jira","Confluence","Figma","Amplitude","Mixpanel","Looker","SQL","Tableau","ProductBoard","Roadmunk","Linear","Asana","Notion","Miro","Excel","PowerPoint"] },
  pm_construction: { label:"Construction Project Management", roleFamily:"pm", suggestedTitles:["Project Coordinator","Project Manager","Construction Project Manager","Assistant Project Manager","Construction Manager","Site Manager","Program Manager","Owner's Representative"], keywords:["RFIs","submittals","change orders","procurement","subcontractor management","schedule management","budget management","project closeout","punch list","commissioning","contract administration","scope management","quality control","safety compliance","stakeholder reporting","bid process","LEED","value engineering"], actionVerbs:["Managed","Coordinated","Procured","Oversaw","Delivered","Negotiated","Monitored","Reviewed","Facilitated","Implemented","Resolved","Tracked","Commissioned","Inspected","Reported"], tools:["Procore","Bluebeam","AutoCAD","Revit","PlanGrid","Microsoft Project","Primavera P6","BIM 360","CoConstruct","Buildertrend","Excel","PowerPoint","Smartsheet","Egnyte"] },
  pm_it: { label:"IT / Technical Program Management", roleFamily:"pm", suggestedTitles:["IT Project Manager","Technical Program Manager","IT Program Manager","Scrum Master","Delivery Manager","Release Manager","Project Manager","PMO Manager"], keywords:["SDLC","agile","scrum","kanban","waterfall","program management","risk management","resource planning","stakeholder management","IT governance","change management","vendor management","SLA management","project portfolio","PMO","PMP","PRINCE2","dependency management","release planning"], actionVerbs:["Led","Managed","Delivered","Coordinated","Facilitated","Planned","Tracked","Reported","Escalated","Resolved","Aligned","Drove","Governed","Implemented","Streamlined"], tools:["Jira","Confluence","MS Project","ServiceNow","Azure DevOps","Monday.com","Smartsheet","Trello","Asana","Excel","PowerPoint","Visio","SharePoint","Notion"] },
  finance: { label:"Finance & Accounting", roleFamily:"finance", suggestedTitles:["Financial Analyst","Senior Financial Analyst","FP&A Analyst","Investment Banking Analyst","Credit Analyst","Portfolio Analyst","Corporate Finance Analyst","Accounting Analyst","Controller","Finance Manager"], keywords:["financial modelling","DCF","LBO","M&A","variance analysis","budget forecasting","financial reporting","P&L management","cash flow analysis","capital markets","risk management","due diligence","GAAP","IFRS","regulatory compliance","portfolio management","valuation","treasury","accounts payable","accounts receivable"], actionVerbs:["Analysed","Modelled","Forecasted","Evaluated","Structured","Negotiated","Reported","Managed","Identified","Quantified","Presented","Reviewed","Reconciled","Optimised","Delivered"], tools:["Excel","PowerPoint","Bloomberg","Capital IQ","SAP","Oracle","Hyperion","Tableau","SQL","Python","QuickBooks","NetSuite","Anaplan","Workiva","Refinitiv"] },
  marketing: { label:"Marketing & Growth", roleFamily:"marketing", suggestedTitles:["Marketing Manager","Growth Manager","Digital Marketing Manager","Brand Manager","Content Marketing Manager","Demand Generation Manager","Performance Marketing Manager","CMO","Marketing Analyst","SEO Manager"], keywords:["go-to-market","brand strategy","demand generation","content marketing","SEO","SEM","paid media","customer acquisition","conversion optimisation","marketing analytics","campaign management","product marketing","email marketing","social media","ABM","pipeline generation","CAC","LTV","marketing attribution"], actionVerbs:["Launched","Grew","Optimised","Managed","Drove","Developed","Executed","Analysed","Increased","Built","Delivered","Led","Created","Tested","Scaled"], tools:["HubSpot","Salesforce","Marketo","Google Ads","Meta Ads","Google Analytics","Tableau","Semrush","Ahrefs","Mailchimp","Pardot","Amplitude","Mixpanel","Figma","Excel"] },
  hr: { label:"Human Resources & People Operations", roleFamily:"hr", suggestedTitles:["HR Manager","People Operations Manager","HR Business Partner","Talent Acquisition Manager","Recruiter","Compensation Analyst","HR Generalist","Learning & Development Manager","HR Director","Chief People Officer"], keywords:["talent acquisition","employee relations","performance management","compensation benefits","HRIS","workforce planning","onboarding","learning development","HR compliance","diversity equity inclusion","succession planning","organisational development","HR analytics","employee engagement","labour relations","headcount planning","culture"], actionVerbs:["Recruited","Managed","Designed","Implemented","Led","Partnered","Facilitated","Developed","Drove","Reduced","Improved","Built","Coordinated","Advised","Delivered"], tools:["Workday","BambooHR","ADP","Greenhouse","Lever","LinkedIn Recruiter","Excel","PowerPoint","Tableau","SAP SuccessFactors","ServiceNow HR","Lattice","Culture Amp","Slack","Notion"] },
  design: { label:"Design & UX", roleFamily:"design", suggestedTitles:["UX Designer","Product Designer","UI/UX Designer","Senior Product Designer","Interaction Designer","Visual Designer","UX Researcher","Design Lead","Brand Designer","Motion Designer"], keywords:["user research","interaction design","information architecture","wireframing","prototyping","usability testing","design systems","user flows","accessibility","visual design","responsive design","design thinking","A/B testing","design critique","cross-functional collaboration","design strategy"], actionVerbs:["Designed","Created","Built","Led","Facilitated","Delivered","Collaborated","Researched","Tested","Iterated","Defined","Prototyped","Shipped","Launched","Improved"], tools:["Figma","Sketch","Adobe XD","InVision","Framer","Zeplin","Principle","Maze","UserTesting","Miro","Notion","Jira","Lottie","After Effects","Illustrator"] },
  legal: { label:"Legal & Compliance", roleFamily:"legal", suggestedTitles:["Legal Counsel","Corporate Counsel","Compliance Manager","Paralegal","Contract Manager","General Counsel","Regulatory Affairs Manager","Privacy Counsel","Associate Attorney","Legal Operations Manager"], keywords:["contract negotiation","regulatory compliance","corporate governance","intellectual property","employment law","privacy law","GDPR","securities law","M&A due diligence","litigation","legal research","risk assessment","policy development","legal operations","commercial agreements","SLAs","NDAs"], actionVerbs:["Negotiated","Drafted","Reviewed","Advised","Managed","Led","Coordinated","Analysed","Implemented","Monitored","Resolved","Counselled","Mitigated","Assessed","Delivered"], tools:["Westlaw","LexisNexis","DocuSign","Ironclad","Clio","ContractPodAi","SharePoint","Microsoft Office","Jira","Confluence","Excel","Relativity","Kira Systems"] },
  operations: { label:"Operations & Supply Chain", roleFamily:"operations", suggestedTitles:["Operations Manager","Supply Chain Manager","Logistics Manager","Operations Analyst","Business Operations Manager","Strategy & Operations Manager","Program Manager","Chief Operating Officer"], keywords:["process improvement","supply chain optimisation","logistics","inventory management","procurement","vendor management","operational efficiency","lean","six sigma","KPI tracking","capacity planning","cost reduction","cross-functional operations","SLA management","risk mitigation","forecasting","P&L"], actionVerbs:["Managed","Optimised","Reduced","Implemented","Delivered","Coordinated","Streamlined","Led","Negotiated","Drove","Built","Scaled","Improved","Launched","Facilitated"], tools:["SAP","Oracle","Excel","Tableau","SQL","Salesforce","Jira","Asana","Monday.com","NetSuite","Coupa","Ariba","PowerBI","Smartsheet","Looker"] },
  healthcare: { label:"Healthcare & Clinical", roleFamily:"healthcare", suggestedTitles:["Registered Nurse","Nurse Practitioner","Clinical Project Manager","Healthcare Administrator","Medical Affairs Manager","Clinical Research Associate","Health Informatics Analyst","Patient Care Coordinator","Clinical Operations Manager"], keywords:["patient care","clinical operations","HIPAA compliance","EHR","EMR","clinical research","IRB","FDA regulations","care coordination","quality improvement","clinical trials","protocol development","interdisciplinary collaboration","patient safety","healthcare analytics","population health","case management"], actionVerbs:["Managed","Coordinated","Implemented","Led","Delivered","Monitored","Assessed","Facilitated","Educated","Collaborated","Improved","Reduced","Developed","Documented","Administered"], tools:["Epic","Cerner","Meditech","Allscripts","REDCap","Veeva","Excel","PowerPoint","Tableau","SQL","Salesforce Health Cloud","ServiceNow","SharePoint"] },
  general: { label:"Other / General", roleFamily:"general", suggestedTitles:[], keywords:["project management","stakeholder management","cross-functional collaboration","communication","problem solving","analytical thinking","leadership","strategy","planning","reporting","budgeting","coordination"], actionVerbs:["Managed","Led","Delivered","Coordinated","Implemented","Improved","Analysed","Built","Developed","Facilitated","Drove","Reported","Resolved","Launched","Optimised"], tools:["Excel","PowerPoint","Word","Google Suite","Slack","Zoom","Jira","Asana","Notion","Confluence","Tableau","SQL"] },
};

// Try to load from the JSON file (preferred — easier to update).
// Fall back to BUILTIN_REGISTRY if the file can't be read on the deployment host.
let _registry = null;
function getRegistry() {
  if (_registry) return _registry;
  const candidates = [
    path.join(__dirname, "..", "data", "DOMAIN_METADATA_REGISTRY.json"),
    path.join(process.cwd(), "data", "DOMAIN_METADATA_REGISTRY.json"),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Object.keys(parsed).length > 0) { _registry = parsed; return _registry; }
    } catch { /* try next */ }
  }
  console.warn("[domain-registry] JSON file not found — using built-in registry");
  _registry = BUILTIN_REGISTRY;
  return _registry;
}

export function createDomainProfilesRouter(db, anthropic, emitToUser = () => {}) {
  const router = Router();

  // ── GET /api/domain-profiles ──────────────────────────────────
  // Returns all profiles for the authenticated user.
  router.get("/", (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM domain_profiles WHERE user_id = ? ORDER BY is_active DESC, created_at ASC
    `).all(req.user.id);
    res.json(rows.map(r => ({
      ...r,
      target_titles:      JSON.parse(r.target_titles      || "[]"),
      selected_keywords:  JSON.parse(r.selected_keywords  || "[]"),
      selected_verbs:     JSON.parse(r.selected_verbs     || "[]"),
      selected_tools:     JSON.parse(r.selected_tools     || "[]"),
    })));
  });

  // ── POST /api/domain-profiles ─────────────────────────────────
  // Create a new profile. Max 4 per user. First profile is set active.
  router.post("/", (req, res) => {
    const { profile_name, role_family, domain, seniority,
            target_titles, selected_keywords, selected_verbs, selected_tools } = req.body;
    if (!profile_name || !role_family || !domain || !seniority) {
      return res.status(400).json({ error: "profile_name, role_family, domain, seniority required" });
    }
    const existing = db.prepare("SELECT COUNT(*) as c FROM domain_profiles WHERE user_id=?").get(req.user.id);
    if (existing.c >= 4) {
      return res.status(400).json({ error: "Maximum 4 profiles allowed per user" });
    }
    const isFirst = existing.c === 0 ? 1 : 0;

    const result = db.prepare(`
      INSERT INTO domain_profiles
        (user_id, profile_name, role_family, domain, seniority,
         target_titles, selected_keywords, selected_verbs, selected_tools, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, profile_name, role_family, domain, seniority,
      JSON.stringify(target_titles     || []),
      JSON.stringify(selected_keywords || []),
      JSON.stringify(selected_verbs    || []),
      JSON.stringify(selected_tools    || []),
      isFirst,
    );

    // Mark onboarding complete (first profile creation)
    db.prepare("UPDATE users SET domain_profile_complete=1 WHERE id=?").run(req.user.id);

    const row = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(result.lastInsertRowid);
    res.json({
      ...row,
      target_titles:     JSON.parse(row.target_titles     || "[]"),
      selected_keywords: JSON.parse(row.selected_keywords || "[]"),
      selected_verbs:    JSON.parse(row.selected_verbs    || "[]"),
      selected_tools:    JSON.parse(row.selected_tools    || "[]"),
    });
  });

  // ── PUT /api/domain-profiles/:id ──────────────────────────────
  // Update a profile. Must belong to req.user.id.
  router.put("/:id", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const allowed = ["profile_name","role_family","domain","seniority",
                     "target_titles","selected_keywords","selected_verbs","selected_tools"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: "No fields to update" });

    // JSON-encode array fields
    for (const arrKey of ["target_titles","selected_keywords","selected_verbs","selected_tools"]) {
      if (updates[arrKey] !== undefined) updates[arrKey] = JSON.stringify(updates[arrKey]);
    }

    const set  = Object.keys(updates).map(k => `${k}=?`).join(",");
    const vals = Object.values(updates);
    db.prepare(`UPDATE domain_profiles SET ${set}, updated_at=unixepoch() WHERE id=? AND user_id=?`)
      .run(...vals, req.params.id, req.user.id);

    const updated = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(req.params.id);
    res.json({
      ...updated,
      target_titles:     JSON.parse(updated.target_titles     || "[]"),
      selected_keywords: JSON.parse(updated.selected_keywords || "[]"),
      selected_verbs:    JSON.parse(updated.selected_verbs    || "[]"),
      selected_tools:    JSON.parse(updated.selected_tools    || "[]"),
    });
  });

  // ── DELETE /api/domain-profiles/:id ──────────────────────────
  // Delete a profile. Cannot delete if it is the only profile.
  router.delete("/:id", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const count = db.prepare("SELECT COUNT(*) as c FROM domain_profiles WHERE user_id=?").get(req.user.id).c;
    if (count <= 1) return res.status(400).json({ error: "Cannot delete your only profile" });

    db.prepare("DELETE FROM domain_profiles WHERE id=? AND user_id=?").run(req.params.id, req.user.id);

    // If deleted profile was active, activate the next one
    if (profile.is_active) {
      const next = db.prepare("SELECT id FROM domain_profiles WHERE user_id=? ORDER BY created_at ASC LIMIT 1")
        .get(req.user.id);
      if (next) db.prepare("UPDATE domain_profiles SET is_active=1 WHERE id=?").run(next.id);
    }
    res.json({ ok: true });
  });

  // ── POST /api/domain-profiles/:id/activate ────────────────────
  // Set this profile as active; deactivate all others for this user.
  router.post("/:id/activate", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    db.prepare("UPDATE domain_profiles SET is_active=0 WHERE user_id=?").run(req.user.id);
    db.prepare("UPDATE domain_profiles SET is_active=1, updated_at=unixepoch() WHERE id=?").run(req.params.id);

    const updated = db.prepare("SELECT * FROM domain_profiles WHERE id=?").get(req.params.id);
    emitToUser(req.user.id, { type: "profile_switched", profileId: req.params.id });
    res.json({
      ...updated,
      target_titles:     JSON.parse(updated.target_titles     || "[]"),
      selected_keywords: JSON.parse(updated.selected_keywords || "[]"),
      selected_verbs:    JSON.parse(updated.selected_verbs    || "[]"),
      selected_tools:    JSON.parse(updated.selected_tools    || "[]"),
    });
  });

  // ── GET /api/domain-metadata/:domain ─────────────────────────
  // Returns chip arrays for a domain key. Public — no auth.
  router.get("/metadata/:domain", (req, res) => {
    const registry = getRegistry();
    const entry = registry[req.params.domain];
    if (!entry) return res.status(404).json({ error: "Domain not found" });
    res.json(entry);
  });

  // ── GET /api/domain-metadata (list all) ──────────────────────
  router.get("/metadata", (_req, res) => {
    const registry = getRegistry();
    // Return lightweight list (no chip arrays) for domain picker
    res.json(Object.entries(registry).map(([key, v]) => ({
      key,
      label:           v.label,
      roleFamily:      v.roleFamily,
      exampleTitles:   v.suggestedTitles.slice(0, 4),
    })));
  });

  // ── POST /api/domain-profiles/generate-chips ─────────────────
  // Haiku call: suggest additional chips beyond the base registry set.
  router.post("/generate-chips", async (req, res) => {
    const { domain, roleFamily, existingKeywords = [], existingVerbs = [], existingTools = [] } = req.body;
    if (!domain || !roleFamily) return res.status(400).json({ error: "domain and roleFamily required" });

    const prompt = `You are a resume expert. Given the domain and role family below, suggest additional resume chips that are NOT already in the existing lists.

Domain: ${domain}
Role Family: ${roleFamily}

Existing keywords (do not repeat): ${existingKeywords.join(", ")}
Existing action verbs (do not repeat): ${existingVerbs.join(", ")}
Existing tools (do not repeat): ${existingTools.join(", ")}

Return ONLY valid JSON in this exact format — no markdown, no explanation:
{
  "keywords": ["keyword1", "keyword2", ...],
  "verbs": ["Verb1", "Verb2", ...],
  "tools": ["Tool1", "Tool2", ...]
}

Rules:
- keywords: exactly 10 short phrases (2-4 words each), domain-specific, not in existing list
- verbs: exactly 5 action verbs (Title Case), not in existing list
- tools: exactly 5 software tools or platforms, not in existing list`;

    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      res.json({
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        verbs:    Array.isArray(parsed.verbs)    ? parsed.verbs    : [],
        tools:    Array.isArray(parsed.tools)    ? parsed.tools    : [],
      });
    } catch(e) {
      res.status(500).json({ error: "Chip generation failed: " + e.message });
    }
  });

  return router;
}
