<!--
  What this file does:
    Domain module for data roles (data engineering, data science, analytics,
    ML engineering, BI development).
    Applied when roleFamily="data".

  What to change here if intent changes:
    - To add new data platforms or ML frameworks: edit section B and C.
    - To adjust streaming/real-time processing tooling: edit section B.
    - To update action verbs for data sub-disciplines: edit section D.

  Depends on:
    - services/classifier.js (sets domainModuleKey="data")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md
-->

## DOMAIN MODULE: DATA

### A. DOMAIN CONTEXT

Data professionals build pipelines, models, and platforms that enable data-driven decisions. Roles include data engineering (pipelines, warehouses), data science (modelling, experimentation), data analytics (dashboards, reporting), and ML engineering (production model deployment). Success is measured by pipeline reliability, model accuracy, dashboard adoption, and decision impact. The vocabulary is platform-specific: dbt, Spark, Airflow, feature stores, A/B testing frameworks, and semantic layers.

### B. CANONICAL TOOL REGISTRY

- **Cloud analytics (Snowflake, Databricks, dbt Labs):** Snowflake, dbt, Databricks, Spark, Airflow, Fivetran, Great Expectations, Delta Lake, Python/SQL
- **Big tech data (Meta, Google, Netflix):** Presto, Hive, Spark, Flink, Airflow, Kafka, Python, internal platforms (FBLearner, Vertex AI, Meson/Metaflow)
- **E-commerce data (Amazon, Shopify, Instacart):** Redshift, dbt, Airflow, Spark, Python, Tableau, A/B testing frameworks
- **Fintech data (Stripe, PayPal, Square):** BigQuery, dbt, Airflow, Looker, Python, SQL, fraud feature engineering, risk modelling
- **Health data (Optum, CVS, Epic):** FHIR, SQL, Python, SAS, HIPAA-compliant pipelines, claims data modelling, HL7
- **Startup/mid-market:** dbt, Fivetran, Snowflake/BigQuery/Redshift, Looker/Metabase, Python, SQL, Airflow

### C. TIER 1 KEYWORD CLASSES

- ETL/ELT tools and pipeline frameworks
- Data warehouse and lakehouse platforms
- Orchestration and workflow tools
- ML platforms and experiment tracking
- Business intelligence and visualisation tools
- Statistical and ML modelling frameworks
- Data quality and testing frameworks
- Streaming and real-time processing
- Data governance and cataloguing

### D. ACTION VERB POOL

Built, Modelled, Forecasted, Identified, Surfaced, Quantified, Evaluated, Analysed, Synthesised, Mapped, Instrumented, Engineered, Optimised, Reduced (latency/cost), Improved (accuracy/coverage), Deployed, Designed, Automated, Monitored, Validated, Standardised, Migrated, Federated, Governed, Catalogued, Partitioned

### E. SUMMARY FRAMING GUIDANCE

Open with role title, years, and data function (data engineering/analytics/data science/ML engineering). Name the primary platform and language. Close with business or product outcome language from the JD.
