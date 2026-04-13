<!--
  What this file does:
    Domain module for healthcare project management roles (clinical, operational,
    or technology initiatives in regulated healthcare environments).
    Applied when roleFamily="pm" and domain="healthcare".

  What to change here if intent changes:
    - To add new EHR systems or regulatory frameworks: edit section B and C.
    - To add quality improvement methodologies: edit section C and D.
    - For IT project management in non-healthcare contexts: edit pm_it.md.
    - For general PM: edit pm_general.md.

  Depends on:
    - services/classifier.js (sets domainModuleKey="pm_healthcare")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: PROJECT MANAGEMENT — HEALTHCARE

### A. DOMAIN CONTEXT

Healthcare project managers deliver clinical, operational, or technology initiatives within regulated environments. Success requires on-time delivery, regulatory compliance, clinical stakeholder alignment, and patient safety preservation. The vocabulary is compliance-heavy: HIPAA, HITECH, CMS, Joint Commission standards, clinical workflow design, EHR implementation, interdisciplinary coordination, and quality improvement (QI/PI).

### B. CANONICAL TOOL REGISTRY

- **Health systems (Mayo Clinic, Cleveland Clinic, HCA):** Epic, Cerner, MS Project, ServiceNow, SharePoint, Lean/Six Sigma tools, Joint Commission readiness
- **Health insurance (UnitedHealth, Cigna, Humana):** Facets, QNXT, SharePoint, MS Project, JIRA, HIPAA compliance tracking, claims system implementations
- **Pharma/biotech (Pfizer, Merck, J&J):** Veeva, CTMS, MS Project, 21 CFR Part 11, IRB management, clinical trial project management
- **Healthcare IT vendors (Epic, Cerner, Meditech):** Epic implementation methodology, go-live readiness, training programme delivery, interface specifications
- **Public health (CDC, state health depts):** REDCap, SAS, SPSS, SharePoint, grant management, community health needs assessment

### C. TIER 1 KEYWORD CLASSES

- EHR/EMR systems and implementation phases
- Regulatory frameworks (HIPAA, HITECH, CMS, Joint Commission, 21 CFR)
- Quality improvement methodologies (Lean, Six Sigma, PDSA, FMEA)
- Clinical workflow and care pathway design
- Patient safety and risk management
- Interdisciplinary and clinical stakeholder management
- Health IT interoperability standards (HL7, FHIR)
- Public health programme management terms

### D. ACTION VERB POOL

Coordinated, Implemented, Standardised, Trained, Evaluated, Monitored, Reported, Facilitated, Aligned, Documented, Transitioned, Piloted, Assessed, Mitigated, Communicated, Designed, Deployed, Audited, Credentialed, Governed, Improved, Measured, Streamlined, Reduced (wait times/readmissions/cost)

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and setting (acute care, health plan, health IT, public health). Name the regulatory framework and/or EHR system most prominent in the JD. Close with patient outcome or operational improvement language from the JD.
