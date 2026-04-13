<!--
  What this file does:
    Domain module for operations roles (supply chain, manufacturing, logistics,
    quality, procurement, healthcare operations, consulting operations).
    Applied when roleFamily="operations".

  What to change here if intent changes:
    - To add new ERP systems or supply chain platforms: edit section B and C.
    - To add process improvement certifications: edit section C.
    - To adjust action verbs for logistics vs. manufacturing: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="operations")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: OPERATIONS

### A. DOMAIN CONTEXT

Operations professionals design and manage processes, supply chains, logistics networks, and quality systems that enable an organisation to deliver at scale reliably and efficiently. Success is measured by throughput, cost per unit, defect rate, on-time delivery, and inventory turns. The vocabulary is process-driven: Six Sigma, Lean, OEE, COGS, SLA, 3PL, SKU rationalisation, demand sensing, and network optimisation.

### B. CANONICAL TOOL REGISTRY

- **Retail and e-commerce ops (Amazon, Walmart, Target):** SAP SCM, Oracle SCM, JDA/Blue Yonder, Manhattan Associates, Kinaxis, Tableau, SQL, Excel
- **Manufacturing (GE, 3M, Honeywell, Caterpillar):** SAP ERP, Oracle, MES systems, Lean tools (VSM, 5S, kaizen), Six Sigma (Minitab), quality management systems (QMS)
- **Logistics and 3PL (FedEx, UPS, XPO, Flexport):** TMS (MercuryGate, Oracle TM), WMS (Manhattan, JDA), Salesforce (customer ops), Tableau, SQL
- **Healthcare operations (hospital systems):** Epic, Lean/Six Sigma, capacity planning tools, HCAHPS, Press Ganey, OR scheduling systems
- **Consulting (McKinsey, BCG, Deloitte ops):** Excel (advanced), Tableau, Alteryx, process mapping tools (Visio, Miro), Lean/Six Sigma methodology

### C. TIER 1 KEYWORD CLASSES

- ERP and supply chain management systems
- Process improvement methodologies (Lean, Six Sigma, DMAIC, Kaizen)
- Inventory and demand planning tools
- Transportation and warehouse management
- Quality management systems and certifications (ISO 9001, AS9100)
- KPIs and operational metrics (OEE, COGS, fill rate, OTIF)
- Network design and optimisation concepts
- Procurement and vendor management

### D. ACTION VERB POOL

Managed, Optimised, Reduced (cost/waste/defects/cycle time), Improved (throughput/OEE/OTIF), Designed, Implemented, Standardised, Trained, Coordinated, Sourced, Negotiated, Forecasted, Procured, Commissioned, Automated, Streamlined, Audited, Reported, Drove (cost savings/efficiency), Scaled, Troubleshot, Mitigated, Led (kaizen/process improvement)

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and operations function (supply chain/manufacturing/logistics/quality/procurement). Name the ERP or planning system and the improvement methodology most prominent in the JD. Close with cost or throughput outcome language.
