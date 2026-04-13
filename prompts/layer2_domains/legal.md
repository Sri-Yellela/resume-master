<!--
  What this file does:
    Domain module for legal roles (law firms, in-house counsel, compliance,
    IP/patent management).
    Applied when roleFamily="legal".

  What to change here if intent changes:
    - To add new CLM platforms or e-discovery tools: edit section B and C.
    - To add regulatory frameworks for a new jurisdiction: edit section C.
    - To adjust action verbs for litigation vs. transactional: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="legal")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: LEGAL

### A. DOMAIN CONTEXT

Legal professionals advise on regulatory compliance, negotiate and draft contracts, manage disputes, and govern risk. Success is measured by deal quality, compliance record, litigation outcomes, and the efficiency of legal operations. The vocabulary is jurisdiction-specific and document-driven: due diligence, regulatory filings, material adverse change (MAC), representations and warranties, discovery, privilege, indemnification, and corporate governance.

### B. CANONICAL TOOL REGISTRY

- **Law firms (Latham, Skadden, Kirkland, Cravath):** Relativity (e-discovery), Westlaw, LexisNexis, iManage, NetDocuments, Kira (contract review), MS Excel (for deal modelling)
- **In-house counsel (Fortune 500 legal departments):** Ironclad, Icertis, Agiloft (CLM), DocuSign, Ironclad, Salesforce (contract tracking), SimpleLegal, Brightflag
- **Compliance (banks, regulated industries):** Compliance training LMS, RiskConnect, NICE Actimize, Archer GRC, Thomson Reuters Accelus
- **IP/Patent firms:** Dockmaster, Anaqua, CPI (patent management), USPTO Patent Center

### C. TIER 1 KEYWORD CLASSES

- Contract types and transaction vocabulary (M&A, licensing, JV, employment, vendor)
- Regulatory frameworks by industry (SOX, GDPR, CCPA, HIPAA, SEC, FINRA, CFPB)
- E-discovery and litigation tools
- Contract lifecycle management platforms
- Corporate governance and board management
- IP and patent management
- Jurisdiction-specific legal concepts

### D. ACTION VERB POOL

Drafted, Negotiated, Advised, Reviewed, Analysed, Managed, Structured, Executed, Coordinated, Researched, Mitigated, Documented, Filed, Litigated, Argued, Settled, Evaluated, Assessed, Governed, Ensured (compliance), Responded, Represented, Closed, Supervised, Interpreted

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and practice area (corporate/M&A, employment, IP, litigation, compliance, in-house general counsel). Name the transaction or regulatory framework most prominent in the JD. Close with business risk or transaction outcome language.
