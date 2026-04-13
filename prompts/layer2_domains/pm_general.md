<!--
  What this file does:
    Domain module for general product management roles (consumer, enterprise, growth, platform).
    Applied when roleFamily="pm" and domain does not map to construction, healthcare, or IT/PMO.

  What to change here if intent changes:
    - To update tool registry for a specific PM sub-sector: edit section B.
    - To add PM keyword classes: edit section C.
    - To adjust action verbs: edit section D.
    - For construction PM: edit pm_construction.md. For healthcare PM: edit pm_healthcare.md.
    - For IT/program management: edit pm_it.md.

  Depends on:
    - services/classifier.js (sets domainModuleKey="pm_general")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: PRODUCT MANAGEMENT (GENERAL)

### A. DOMAIN CONTEXT

Product managers translate business strategy into product roadmaps and work across engineering, design, data, and business stakeholders to ship features that solve user problems. Success is measured by product adoption, revenue impact, user engagement metrics, and on-time delivery. The vocabulary is outcome-oriented: PMs write in terms of OKRs, user stories, A/B tests, conversion rates, churn, NPS, sprint velocity, and roadmap prioritisation.

### B. CANONICAL TOOL REGISTRY

- **Consumer tech (Airbnb, Lyft, DoorDash, Snap):** Jira, Confluence, Figma, Amplitude, Mixpanel, Looker, SQL, Python (basic), A/B testing frameworks, growth experimentation
- **Enterprise SaaS (Salesforce, Workday, ServiceNow):** Jira, Aha!, Confluence, Salesforce CRM, Tableau, Gainsight, customer journey mapping, enterprise roadmapping
- **E-commerce (Shopify, Wayfair, eBay):** Jira, Google Analytics, Amplitude, SQL, Optimizely, conversion funnel analysis, merchant analytics
- **Fintech (Stripe, PayPal, Square):** Jira, Confluence, Tableau, SQL, Mixpanel, regulatory compliance tracking, payment flow optimisation
- **Healthcare tech (Epic, Optum):** Jira, SQL, FHIR, EHR workflow mapping, clinical user research, HIPAA compliance tracking
- **B2B SaaS general:** ProductBoard, Jira, Intercom, HubSpot, Salesforce, Pendo, cohort analysis

### C. TIER 1 KEYWORD CLASSES

- Product discovery and research methods
- Metrics and analytics tools
- Roadmapping and prioritisation frameworks (MoSCoW, RICE, ICE)
- Agile delivery practices (scrum, kanban, sprint planning, backlog grooming)
- Experimentation and A/B testing
- Stakeholder management and communication tools
- Specific product area vocabulary (growth, platform, core product, etc.)
- Domain-specific compliance or regulatory terms

### D. ACTION VERB POOL

Defined, Prioritised, Launched, Shipped, Aligned, Synthesised, Validated, Researched, Iterated, Coordinated, Facilitated, Owned, Tracked, Measured, Presented, Influenced, Negotiated, Scoped, Roadmapped, Tested, Diagnosed, Interviewed, Analysed, Communicated, Partnered, Drove, Reduced (churn/friction), Increased (adoption/revenue)

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and product domain (consumer/enterprise/platform/growth). Name two or three product capabilities (discovery, experimentation, roadmapping, cross-functional leadership). Close with the business problem the team was hired to solve using the JD's language.
