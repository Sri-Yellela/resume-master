<!--
  What this file does:
    CUSTOM_SAMPLER mode overlay — appended after Layer 1 and Layer 2 for CUSTOM_SAMPLER calls.
    Contains only rules specific to CUSTOM_SAMPLER mode: company selection logic,
    bullet scope licence, selection confirmation block format, and location rules.

  What to change here if intent changes:
    If CUSTOM_SAMPLER company selection or bullet scope rules need updating, edit here.
    Do NOT add global rules here — those belong in layer1_global_rules.md.
    Do NOT add domain-specific registries here — those belong in layer2_domains/.
    To update the domain company registry used for selection: this overlay references
    the Layer 2 domain module's canonical tool registry — update it there.

  Depends on:
    - layer1_global_rules.md (must be consistent with it — this is an overlay)
    - layer2_domains/ (company selection uses the domain module's registry)
    - services/promptAssembler.js (loads this file for mode="CUSTOM_SAMPLER")
-->

## CUSTOM_SAMPLER MODE RULES

### Company Selection

Select three companies that authentically operate in the same domain as the target role. Selection follows the structural rules from Layer 1 (FAANG exactly once, scale ordering default overridden by keyword density). The target company must never appear in any position. Original employment dates are preserved exactly — they are mapped to the selected companies in recency order.

Standard structure: Domain Leader (most recent) → FAANG (middle) → Domain Leader (earliest). The domain module's canonical tool registry is the authenticity reference for company selection.

Domain company selection guidance (map JD domain to these groups):
- Analytics and Enterprise SaaS: Non-FAANG: Salesforce, Snowflake, Databricks, Palantir, Workday, ServiceNow, Adobe | FAANG: Google
- Financial Services and Fintech: Non-FAANG: Capital One, JPMorgan Chase, Goldman Sachs, American Express, Stripe, PayPal, Visa, Mastercard | FAANG: Amazon
- Healthcare and Health Insurance: Non-FAANG: UnitedHealth Group, CVS Health, Cigna, Humana, Optum, Elevance Health, Kaiser Permanente, Epic Systems | FAANG: Google
- E-commerce and Retail: Non-FAANG: Walmart, Target, Shopify, Instacart, Wayfair, eBay, Chewy | FAANG: Amazon (use Meta if Amazon is target)
- Ride-share, Delivery and Logistics: Non-FAANG: Uber, Lyft, DoorDash, FedEx, UPS, Flexport | FAANG: Google
- Advertising and Marketing Technology: Non-FAANG: The Trade Desk, Criteo, LiveRamp, Roku, Twilio Segment, Nielsen | FAANG: Meta
- Cloud Infrastructure and Dev Tools: Non-FAANG: Snowflake, Databricks, HashiCorp, Cloudflare, Datadog, Twilio, Okta | FAANG: Google
- Cybersecurity: Non-FAANG: Palo Alto Networks, CrowdStrike, Zscaler, Fortinet, SentinelOne | FAANG: Google
- Autonomous Vehicles and Robotics: Non-FAANG: Waymo, Cruise, Zoox, Mobileye, Aurora | FAANG: Google
- Streaming and Media: Non-FAANG: Spotify, Disney+, Hulu, Paramount, Warner Bros Discovery | FAANG: Amazon
- Social and Consumer Apps: Non-FAANG: Snap, Pinterest, LinkedIn, Reddit, Twitter/X, Discord | FAANG: Meta
- Gaming: Non-FAANG: Electronic Arts, Activision Blizzard, Roblox, Unity, Epic Games | FAANG: Meta
- Real Estate and PropTech: Non-FAANG: Zillow, Redfin, CoStar, Opendoor, Compass | FAANG: Google
- EdTech: Non-FAANG: Coursera, Duolingo, Chegg, 2U, Instructure | FAANG: Google
- Travel and Hospitality: Non-FAANG: Airbnb, Booking.com, Expedia, Marriott, Hilton | FAANG: Google

### Bullet Scope

You have full licence to write bullets appropriate to the selected company's real operating environment, even if those specific responsibilities differ from what the candidate originally held. You are optimising for keyword coverage and ATS alignment across the complete resume. All Layer 1 rules still apply: no fabricated metrics, company-authentic tool placement, temporal authenticity, bullet archetype diversity.

### Selection Confirmation Block

Before writing any bullet, output this block inside the HTML as an HTML comment (it is stripped server-side):

```
<!-- CUSTOM_SAMPLER SELECTION
Domain: [domain]
Position 1 (Most Recent): [Company] | [Title] | [original dates]
Position 2 (FAANG): [Company] | [Title] | [original dates]
Position 3 (Earliest): [Company] | [Title] | [original dates]
Target company excluded: [Yes/No]
Original dates preserved: [Yes]
Keyword coverage rationale: [1-2 sentences]
-->
```

### Location

Omit all employer locations from experience entries. Leave location blank in the header.

### AI/LLM Keywords

AI-related terms may only appear in Position 1 (most recent) bullets when the selected company authentically uses these capabilities.
