<!--
  What this file does:
    Domain module for HR roles (HRBP, talent acquisition, compensation, L&D, people ops).
    Applied when roleFamily="hr".

  What to change here if intent changes:
    - To add new HRIS or ATS platforms: edit section B and C.
    - To add HR compliance frameworks: edit section C.
    - To adjust action verbs for HR sub-functions: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="hr")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: HUMAN RESOURCES

### A. DOMAIN CONTEXT

HR professionals design and operate people systems: talent acquisition, performance management, compensation, learning and development, employee relations, and organisational design. Success is measured by time-to-fill, offer acceptance rate, retention rate, employee engagement scores, and compliance record. The vocabulary is process-oriented: headcount planning, HRBP, job architecture, total rewards, DEI metrics, HRIS, and workforce analytics.

### B. CANONICAL TOOL REGISTRY

- **Enterprise HR (Fortune 500):** Workday HCM, SAP SuccessFactors, Oracle HCM, ServiceNow HR Service Delivery, Tableau, Power BI, LinkedIn Recruiter
- **Staffing and recruiting (Korn Ferry, Spencer Stuart, Robert Half):** Bullhorn, Greenhouse, Workday Recruiting, LinkedIn Recruiter, Beamery, HireVue
- **Tech company HR (Google, Meta, Amazon):** Workday, Greenhouse, Lever, Culture Amp, Lattice, Tableau, SQL (basic), Qualtrics
- **Consulting (Mercer, Aon, Willis Towers Watson):** Mercer Total Rewards, compensation benchmarking tools, Korn Ferry Hay methodology, MS Excel (advanced)
- **Mid-market (Gusto, Rippling, BambooHR users):** Gusto, Rippling, BambooHR, Greenhouse, Indeed, LinkedIn Recruiter, Lever

### C. TIER 1 KEYWORD CLASSES

- HRIS and ATS platforms
- Talent acquisition tools and sourcing platforms
- Compensation and total rewards tools
- Performance management and engagement tools
- Employment law and compliance terms (FLSA, FMLA, EEO, ADA)
- L&D platforms and instructional design
- Workforce analytics and people data
- Organisational development and change management frameworks

### D. ACTION VERB POOL

Recruited, Onboarded, Designed, Implemented, Partnered, Advised, Facilitated, Trained, Developed, Managed (programmes), Reduced (time-to-fill/attrition), Improved (engagement/retention), Streamlined, Standardised, Communicated, Coached, Evaluated, Audited, Reported, Resolved, Aligned, Restructured, Negotiated, Administered, Sourced

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and HR function (HRBP/TA/compensation/L&D/people ops). Name the primary HRIS or ATS from the JD. Close with people or organisational outcome language matching the JD.
