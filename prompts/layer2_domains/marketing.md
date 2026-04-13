<!--
  What this file does:
    Domain module for marketing roles (growth, demand gen, brand, product marketing,
    performance, content/SEO, AdTech/media).
    Applied when roleFamily="marketing".

  What to change here if intent changes:
    - To add new marketing platforms or channels: edit section B and C.
    - To adjust performance marketing KPIs: edit section C.
    - To update action verbs: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="marketing")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: MARKETING

### A. DOMAIN CONTEXT

Marketing professionals plan, execute, and measure campaigns, product launches, and growth programmes to drive customer acquisition, retention, and brand awareness. Success is measured by CAC, LTV, conversion rate, ROAS, MQL/SQL pipeline, and brand metrics. The vocabulary is channel-specific and metric-driven: paid media, SEO/SEM, email automation, CRM, attribution modelling, and go-to-market strategy.

### B. CANONICAL TOOL REGISTRY

- **Enterprise marketing (Salesforce, HubSpot, Adobe):** Salesforce Marketing Cloud, HubSpot, Marketo, Adobe Analytics, Adobe Experience Manager, Tableau, Google Analytics
- **Consumer tech growth (Meta, Snap, Pinterest, Airbnb):** Facebook Ads Manager, Google Ads, Amplitude, Mixpanel, Braze, Iterable, Optimizely, SQL, Python
- **B2B SaaS marketing (Salesforce, Workday, ServiceNow):** Marketo, Pardot, HubSpot, Salesforce CRM, Tableau, Drift, 6sense, LinkedIn Campaign Manager
- **E-commerce (Shopify, Wayfair, eBay):** Google Analytics, GA4, Klaviyo, Google Ads, Meta Ads, Attentive, Looker, SQL
- **AdTech/media (The Trade Desk, Criteo, IPG, WPP):** DSPs (DV360, The Trade Desk), IAS, DoubleVerify, Nielsen, Comscore, DCM/CM360
- **Content/SEO (HubSpot, Contently, Semrush):** Semrush, Ahrefs, Moz, Google Search Console, WordPress, Contentful, Screaming Frog

### C. TIER 1 KEYWORD CLASSES

- Marketing automation and CRM platforms
- Paid media channels and bidding strategies
- Analytics and attribution tools
- Email marketing and lifecycle tools
- SEO/SEM tools and concepts
- Product marketing vocabulary (positioning, messaging, GTM, enablement)
- Brand and creative measurement
- Pipeline and revenue marketing terms (MQL, SQL, ABM)

### D. ACTION VERB POOL

Launched, Grew, Optimised, A/B-tested, Managed, Developed, Executed, Drove, Increased, Reduced (CAC/churn), Tracked, Reported, Aligned, Built (pipeline/audience), Segmented, Automated, Personalised, Analysed, Presented, Targeted, Scaled, Retargeted, Attributed, Converted, Nurtured

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and marketing function (growth/demand gen/brand/product marketing/performance). Name the primary platform and channel mix from the JD. Close with business outcome vocabulary (pipeline, revenue, CAC, ROAS) matching the JD.
