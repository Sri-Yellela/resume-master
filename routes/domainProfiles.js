// routes/domainProfiles.js — Domain profile CRUD + chip generation
import { Router }        from "express";
import Anthropic         from "@anthropic-ai/sdk";
import { createRequire } from "module";
import fs                from "fs";
import path              from "path";
import { fileURLToPath } from "url";
import {
  getBaseResumeRecord,
  loadOrCreateSimpleApplyProfile,
  normaliseStructuredFacts,
  saveBaseResumeRecord,
  upsertSimpleApplyProfile,
} from "../services/simpleApplyProfile.js";
import {
  addProfileSignalSuggestions,
  computeEnhancementStatus,
  listProfileEnhancementHistory,
  listProfileSignalSuggestions,
  syncSelectedSkillSuggestions,
} from "../services/profileSignalAggregator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Inline fallback — always available even when the JSON file can't be read
// (e.g. Railway container filesystem restrictions). Update this when the
// DOMAIN_METADATA_REGISTRY.json file changes.
const BUILTIN_REGISTRY = {
  engineering: { label:"Software Engineering", roleFamily:"engineering", suggestedTitles:["Software Engineer","Backend Engineer","Frontend Engineer","Full Stack Engineer","Software Developer","Site Reliability Engineer","Platform Engineer","Systems Software Engineer","Staff Engineer","Performance Engineer"], keywords:["distributed systems","microservices","REST APIs","system design","cloud infrastructure","CI/CD","kubernetes","docker","scalability","reliability","performance optimisation","code review","technical leadership","agile","object oriented","concurrency","multithreading","test automation","database internals","security engineering"], actionVerbs:["Built","Designed","Deployed","Migrated","Refactored","Optimised","Implemented","Automated","Architected","Scaled","Shipped","Debugged","Instrumented","Integrated","Reduced"], tools:["Python","Java","Go","TypeScript","React","Node.js","PostgreSQL","Redis","Kafka","AWS","GCP","Azure","Terraform","Git","Kubernetes","Docker","Spark","Airflow","Linux","gdb","C++"] },
  engineering_embedded_firmware: { label:"Firmware, Embedded & Device Software", roleFamily:"engineering", suggestedTitles:["Firmware Engineer","Embedded Software Engineer","Embedded Systems Engineer","Device Driver Engineer","BSP Engineer","Board Support Package Engineer","RTOS Engineer","Hardware Debug Engineer","Firmware Debug Engineer","SoC Bring-Up Engineer","Chip Bring-Up Engineer","Post-Silicon Validation Engineer"], keywords:["embedded software","firmware development","embedded C","embedded C++","RTOS","device drivers","kernel drivers","board bring-up","BSP","hardware software co-debug","registers and memory","peripherals","JTAG debugging","Lauterbach TRACE32 debugging","T32 debugging","PCIe debugging","protocol debugging","SPI protocol","I2C protocol","low-level diagnostics","real-time systems","bootloaders","silicon validation","post-silicon validation","SoC bring-up"], actionVerbs:["Developed","Debugged","Validated","Brought Up","Instrumented","Integrated","Diagnosed","Optimised","Verified","Traced","Automated","Tested","Ported","Profiled","Resolved"], tools:["C","C++","Python","RTOS","Linux kernel","Zephyr","FreeRTOS","JTAG","OpenOCD","TRACE32","T32","Lauterbach","LTB","gdb","LLDB","Oscilloscope","Logic analyzer","UART","SPI","I2C","PCIe","CAN","Git"] },
  engineering_systems_low_level: { label:"Systems, Platform & Performance Engineering", roleFamily:"engineering", suggestedTitles:["Systems Software Engineer","Platform Software Engineer","Operating Systems Engineer","Kernel Engineer","Compiler Engineer","Software Tools Engineer","Performance Engineer","Systems Performance Engineer","Infrastructure Engineer","Distributed Systems Engineer"], keywords:["operating systems","kernel development","compiler engineering","software tools","distributed systems","database internals","concurrency","multithreading","synchronization","memory management","performance profiling","latency optimisation","runtime systems","debug tooling","systems performance","load testing","observability","networking"], actionVerbs:["Architected","Built","Optimised","Profiled","Instrumented","Debugged","Scaled","Reduced","Benchmarked","Implemented","Automated","Refactored","Stabilised","Diagnosed","Shipped"], tools:["C","C++","Rust","Go","Python","Linux","gdb","perf","eBPF","Valgrind","LLVM","GCC","Kubernetes","Docker","Kafka","PostgreSQL","Redis","Prometheus","Grafana","Git"] },
  engineering_specialist: { label:"Engineering Specialties", roleFamily:"engineering", suggestedTitles:["Android Engineer","Mobile Engineer","Computer Vision Engineer","Graphics Engineer","Audio Video Engineer","Payments Engineer","Security Engineer","Test Automation Engineer","UI Engineer","Wireless Software Engineer"], keywords:["advanced algorithms","android development","audio video systems","payments platforms","compilers and tools","computer vision","graphics and imaging","information retrieval","data mining","internationalization","security and cryptography","test automation","UI implementation","web applications","multi-tier systems","windows development","wireless applications","performance tuning"], actionVerbs:["Built","Designed","Optimised","Implemented","Automated","Integrated","Validated","Secured","Profiled","Shipped","Debugged","Scaled","Tested","Refactored","Launched"], tools:["Kotlin","Swift","C++","Python","OpenCV","CUDA","OpenGL","Vulkan","FFmpeg","Android Studio","Xcode","React","TypeScript","Playwright","Selenium","Windows",".NET","Wireshark","Git"] },
  other_profile_request: { label:"Other Job Profile", roleFamily:"general", requestOnly:true, suggestedTitles:["Request support for another role"], keywords:[], actionVerbs:["Managed","Led","Built","Analysed","Delivered"], tools:[] },
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

function cleanStringArray(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseProfileRow(row) {
  return {
    ...row,
    target_titles: JSON.parse(row.target_titles || "[]"),
    selected_keywords: JSON.parse(row.selected_keywords || "[]"),
    selected_verbs: JSON.parse(row.selected_verbs || "[]"),
    selected_tools: JSON.parse(row.selected_tools || "[]"),
  };
}

export function createDomainProfilesRouter(db, anthropic, emitToUser = () => {}) {
  const router = Router();

  // ── GET /api/domain-profiles ──────────────────────────────────
  // Returns all profiles for the authenticated user.
  router.get("/", (req, res) => {
    let rows = db.prepare(`
      SELECT dp.*,
             EXISTS(
               SELECT 1 FROM profile_base_resumes pbr
               WHERE pbr.profile_id = dp.id AND TRIM(pbr.content) != ''
             ) AS has_base_resume,
             (
               SELECT pbr.updated_at FROM profile_base_resumes pbr
               WHERE pbr.profile_id = dp.id
             ) AS base_resume_updated_at
      FROM domain_profiles dp
      WHERE dp.user_id = ?
      ORDER BY dp.is_active DESC, dp.created_at ASC
    `).all(req.user.id);
    if (rows.length && !rows.some(r => r.is_active)) {
      db.prepare("UPDATE domain_profiles SET is_active=1, updated_at=unixepoch() WHERE id=? AND user_id=?")
        .run(rows[0].id, req.user.id);
      try { db.prepare("UPDATE users SET domain_profile_complete=1 WHERE id=?").run(req.user.id); } catch {}
      rows = db.prepare(`
        SELECT dp.*,
               EXISTS(
                 SELECT 1 FROM profile_base_resumes pbr
                 WHERE pbr.profile_id = dp.id AND TRIM(pbr.content) != ''
               ) AS has_base_resume,
               (
                 SELECT pbr.updated_at FROM profile_base_resumes pbr
                 WHERE pbr.profile_id = dp.id
               ) AS base_resume_updated_at
        FROM domain_profiles dp
        WHERE dp.user_id = ?
        ORDER BY dp.is_active DESC, dp.created_at ASC
      `).all(req.user.id);
    } else {
      try { db.prepare("UPDATE users SET domain_profile_complete=? WHERE id=?").run(rows.length ? 1 : 0, req.user.id); } catch {}
    }
    res.json(rows.map(parseProfileRow));
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
    res.json(parseProfileRow(row));
  });

  // Store unsupported-role requests for product/admin review. The user may
  // still create a generic profile from the same wizard submission.
  router.post("/requests", (req, res) => {
    const desiredTitle = String(req.body?.desired_title || "").trim();
    if (!desiredTitle) return res.status(400).json({ error: "desired_title required" });

    const roleFamily = String(req.body?.role_family || "").trim() || null;
    const seniority = String(req.body?.seniority || "").trim() || null;
    const workPreference = String(req.body?.work_preference || "").trim() || null;
    const notes = String(req.body?.notes || "").trim() || null;

    const result = db.prepare(`
      INSERT INTO domain_profile_requests
        (user_id, desired_title, role_family, target_titles_json,
         skills_json, tools_json, industries_json, keywords_json,
         seniority, work_preference, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id,
      desiredTitle,
      roleFamily,
      JSON.stringify(cleanStringArray(req.body?.target_titles)),
      JSON.stringify(cleanStringArray(req.body?.skills)),
      JSON.stringify(cleanStringArray(req.body?.tools)),
      JSON.stringify(cleanStringArray(req.body?.industries)),
      JSON.stringify(cleanStringArray(req.body?.keywords)),
      seniority,
      workPreference,
      notes,
    );

    const row = db.prepare("SELECT * FROM domain_profile_requests WHERE id=?").get(result.lastInsertRowid);
    res.json({ ok: true, request: row });
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
    res.json(parseProfileRow(updated));
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
    res.json(parseProfileRow(updated));
  });

  router.get("/:id/base-resume", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const row = getBaseResumeRecord(db, { userId: req.user.id, profileId: profile.id });
    res.json(row ? {
      content: row.content,
      name: row.name,
      updatedAt: row.updated_at,
      enhancedAt: row.enhanced_at || null,
      enhancedAtsDelta: row.enhanced_ats_delta ?? null,
      hasEnhancedDraft: !!String(row.enhanced_content || "").trim(),
    } : { content: null, name: null, updatedAt: null, hasEnhancedDraft: false });
  });

  router.post("/:id/base-resume", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const { content, name } = req.body || {};
    if (content === undefined) return res.status(400).json({ error: "content required" });
    saveBaseResumeRecord(db, { userId: req.user.id, profileId: profile.id }, content, name || "resume.txt");
    const roleTitles = JSON.parse(profile.target_titles || "[]");
    const signals = upsertSimpleApplyProfile(
      db,
      { userId: req.user.id, profileId: profile.id },
      content,
      roleTitles,
    );
    res.json({ ok: true, profileId: profile.id, signals });
  });

  router.get("/:id/signals", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const roleTitles = JSON.parse(profile.target_titles || "[]");
    const signals = loadOrCreateSimpleApplyProfile(
      db,
      { userId: req.user.id, profileId: profile.id, roleTitles },
    );
    res.json({
      ...(signals || {
        titles: [],
        keywords: [],
        skills: [],
        searchTerms: [],
        yearsExperience: null,
        structuredFacts: {},
      }),
      suggestions: listProfileSignalSuggestions(db, { userId: req.user.id, profileId: profile.id }),
    });
  });

  router.post("/:id/signals/refresh", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const base = getBaseResumeRecord(db, { userId: req.user.id, profileId: profile.id });
    if (!base?.content) return res.status(400).json({ error: "No base resume uploaded" });
    const roleTitles = JSON.parse(profile.target_titles || "[]");
    const signals = upsertSimpleApplyProfile(
      db,
      { userId: req.user.id, profileId: profile.id },
      base.content,
      roleTitles,
    );
    res.json(signals);
  });

  router.put("/:id/signals", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const current = loadOrCreateSimpleApplyProfile(
      db,
      { userId: req.user.id, profileId: profile.id, roleTitles: JSON.parse(profile.target_titles || "[]") },
    ) || {};
    const next = {
      titles: cleanStringArray(req.body?.titles ?? current.titles, 12).map(v => v.toLowerCase()),
      keywords: cleanStringArray(req.body?.keywords ?? current.keywords, 32).map(v => v.toLowerCase()),
      skills: cleanStringArray(req.body?.skills ?? current.skills, 24).map(v => v.toLowerCase()),
      searchTerms: cleanStringArray(req.body?.searchTerms ?? current.searchTerms, 12).map(v => v.toLowerCase()),
      structuredFacts: normaliseStructuredFacts(req.body?.structuredFacts ?? current.structuredFacts),
      yearsExperience: req.body?.yearsExperience === null || req.body?.yearsExperience === ""
        ? null
        : Number.isFinite(Number(req.body?.yearsExperience))
          ? Number(req.body.yearsExperience)
          : (current.yearsExperience ?? null),
      sourceHash: current.sourceHash || null,
    };
    db.prepare(`
      INSERT INTO profile_simple_apply_profiles
        (profile_id, user_id, titles_json, keywords_json, skills_json, search_terms_json,
         source_hash, years_experience, citizenship_status, work_authorization,
         requires_sponsorship, has_clearance, clearance_level, degree_level, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(profile_id) DO UPDATE SET
        user_id=excluded.user_id,
        titles_json=excluded.titles_json,
        keywords_json=excluded.keywords_json,
        skills_json=excluded.skills_json,
        search_terms_json=excluded.search_terms_json,
        source_hash=excluded.source_hash,
        years_experience=excluded.years_experience,
        citizenship_status=excluded.citizenship_status,
        work_authorization=excluded.work_authorization,
        requires_sponsorship=excluded.requires_sponsorship,
        has_clearance=excluded.has_clearance,
        clearance_level=excluded.clearance_level,
        degree_level=excluded.degree_level,
        updated_at=excluded.updated_at
    `).run(
      profile.id,
      req.user.id,
      JSON.stringify(next.titles),
      JSON.stringify(next.keywords),
      JSON.stringify(next.skills),
      JSON.stringify(next.searchTerms),
      next.sourceHash,
      next.yearsExperience,
      next.structuredFacts.citizenshipStatus || null,
      next.structuredFacts.workAuthorization || null,
      next.structuredFacts.requiresSponsorship ? 1 : 0,
      next.structuredFacts.hasClearance ? 1 : 0,
      next.structuredFacts.clearanceLevel || null,
      next.structuredFacts.degreeLevel || null,
    );
    res.json(next);
  });

  router.get("/:id/suggestions", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json(listProfileSignalSuggestions(db, { userId: req.user.id, profileId: profile.id }));
  });

  router.put("/:id/suggestions", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const before = computeEnhancementStatus(db, { userId: req.user.id, profileId: profile.id });
    const suggestions = syncSelectedSkillSuggestions(db, {
      userId: req.user.id,
      profileId: profile.id,
      selectedKeys: req.body?.selectedSkillKeys || [],
    });
    const enhancement = computeEnhancementStatus(db, { userId: req.user.id, profileId: profile.id });
    if (!before.eligible && enhancement.eligible) {
      try {
        const row = db.prepare(`
          INSERT INTO notifications (user_id, type, message, payload)
          VALUES (?, ?, ?, ?)
        `).run(
          req.user.id,
          "enhance_ready",
          `Enhance Base Resume is ready for ${profile.profile_name}.`,
          JSON.stringify({ profileId: profile.id, source: "manual_selection" }),
        );
        emitToUser(req.user.id, {
          type: "notification",
          id: row.lastInsertRowid,
          notif_type: "enhance_ready",
          message: `Enhance Base Resume is ready for ${profile.profile_name}.`,
        });
      } catch {}
    }
    res.json({
      ...suggestions,
      enhancement,
    });
  });

  router.post("/:id/suggestions", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    const kind = req.body?.kind === "action_verb" ? "action_verb" : "skill";
    const labels = req.body?.labels || req.body?.label || [];
    const suggestions = addProfileSignalSuggestions(db, {
      userId: req.user.id,
      profileId: profile.id,
      kind,
      labels,
    });
    res.json({
      ...suggestions,
      enhancement: computeEnhancementStatus(db, { userId: req.user.id, profileId: profile.id }),
    });
  });

  router.get("/:id/enhancement-history", (req, res) => {
    const profile = db.prepare("SELECT * FROM domain_profiles WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json({
      history: listProfileEnhancementHistory(db, { userId: req.user.id, profileId: profile.id }),
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
