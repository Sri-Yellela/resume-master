<!--
  What this file does:
    Fallback domain module for roles that do not map to a specific domain.
    Applied when roleFamily="general" or when no specific domain module matches.
    Intentionally domain-agnostic — works for social work, logistics coordination,
    teaching, chemistry, or any professional role not covered by a specific module.

  What to change here if intent changes:
    - This module should remain domain-agnostic. Do not add domain-specific tools here.
    - To handle a new domain specifically: create a new prompts/layer2_domains/{key}.md
      and add the key to services/classifier.js getDomainModuleKey().
    - To adjust the general action verb pool: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="general" as fallback)
    - services/promptAssembler.js (loads this file when no specific domain matches)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: GENERAL (DOMAIN-AGNOSTIC FALLBACK)

### A. DOMAIN CONTEXT

This domain module applies when the role does not clearly map to a specific domain. It is intentionally domain-agnostic and works equally well for a social worker, logistics coordinator, teacher, chemist, or any other professional role. Language and vocabulary are drawn entirely from the JD — this module provides structure and rules without domain-specific assumptions.

### B. CANONICAL TOOL REGISTRY

No domain-specific tools are assumed. For company-authentic placement, use only information available in the JD or job posting to infer what tools the hiring organisation actually uses. When tool information is unavailable, omit tool placement entirely and write process- and outcome-focused bullets. Do not fabricate tool names.

### C. TIER 1 KEYWORD CLASSES

Extract and classify entirely from the JD:
- Required credentials, certifications, or licences
- Named software, platforms, or tools appearing in the JD
- Domain vocabulary and sector-specific concepts
- Methodologies, frameworks, or standards named in the JD
- Specific responsibilities stated as requirements

### D. ACTION VERB POOL

Managed, Developed, Delivered, Coordinated, Facilitated, Improved, Implemented, Analysed, Communicated, Reported, Trained, Designed, Evaluated, Resolved, Maintained, Supported, Organised, Monitored, Presented, Negotiated, Collaborated, Guided, Assessed, Reduced, Increased, Standardised, Documented, Initiated, Reviewed, Supervised

### E. SUMMARY FRAMING GUIDANCE

Open with the role title from the JD and total years of relevant experience. Identify two or three capabilities that directly match the JD requirements — use the JD's own vocabulary. Close with one sentence signalling fit for the specific business context of the hiring organisation, using language taken directly from the JD. Avoid industry jargon not present in the JD.
