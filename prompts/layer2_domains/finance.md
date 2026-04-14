<!--
  What this file does:
    Domain module for finance roles (investment banking, FP&A, asset management,
    PE, commercial banking, accounting/audit, fintech finance).
    Applied when roleFamily="finance".

  What to change here if intent changes:
    - To add new financial institutions or fintech companies: edit section B.
    - To add modelling methodologies or regulatory frameworks: edit section C.
    - To adjust action verbs for a finance sub-discipline: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="finance")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: FINANCE

### A. DOMAIN CONTEXT

Finance professionals model, analyse, forecast, and communicate financial performance to support business decisions, investor relations, or risk management. Success is measured by forecast accuracy, cost reduction, revenue growth attribution, and deal or transaction outcomes. The vocabulary is precise: EBITDA, DCF, LBO, IRR, variance analysis, FP&A, capital allocation, working capital, covenant compliance, credit risk, regulatory capital, and SOX compliance.

### B. CANONICAL TOOL REGISTRY

- **Investment banking (Goldman Sachs, JPMorgan, Morgan Stanley, Lazard):** Excel (advanced), Bloomberg, FactSet, Capital IQ, Pitchbook, PowerPoint, Dealogic, SecDB (Goldman-specific)
- **Asset management (BlackRock, Vanguard, Citadel):** Bloomberg, Python, R, SQL, Aladdin (BlackRock), FactSet, Tableau, portfolio attribution models
- **Corporate FP&A (Fortune 500):** Anaplan, Hyperion, Oracle EPM, Adaptive Insights, SAP BW, Excel, Tableau, Power BI, SQL, Workday Financials
- **Private equity (KKR, Apollo, Warburg Pincus):** Excel, Capital IQ, FactSet, PowerPoint, deal pipeline management, LBO modelling
- **Commercial banking (Wells Fargo, Bank of America, Citi):** Moody's, S&P, SQL, SAS, Python, AML/BSA compliance systems, credit origination platforms
- **Accounting/audit (Deloitte, PwC, EY, KPMG):** CCH ProSystem, Thomson Reuters Checkpoint, TeamMate, Caseware, Excel, SAP, Oracle
- **Fintech (Stripe, PayPal, Square):** Python, SQL, dbt, Looker, Airflow, Snowflake, Databricks, risk modelling

### C. TIER 1 KEYWORD CLASSES

- Financial modelling tools and methodologies (DCF, LBO, merger model, three-statement model)
- Reporting and BI platforms
- ERP and financial planning systems
- Regulatory and compliance frameworks (SOX, Basel III, Dodd-Frank, IFRS, GAAP)
- Transaction and deal vocabulary (M&A, leveraged finance, capital markets)
- Risk management frameworks (credit risk, market risk, operational risk)
- Accounting standards and concepts
- Data and analytics tools specific to finance

### D. ACTION VERB POOL

Modelled, Forecasted, Analysed, Structured, Valued, Negotiated, Executed, Closed, Underwritten, Syndicated, Hedged, Optimised, Reported, Reconciled, Audited, Assessed, Stress-tested, Presented, Advised, Delivered, Quantified, Benchmarked, Monitored, Governed, Consolidated, Reviewed, Approved

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and finance function (investment banking/FP&A/credit/asset management/accounting). Name the primary modelling or analytical tools from the JD. Close with deal type, reporting function, or business outcome language matching the JD.
