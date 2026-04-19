<!--
  What this file does:
    Domain module for software/systems engineering roles.
    Provides tool registry, keyword classes, action verbs, and summary framing
    specific to engineering roles. Appended as the second cached block after
    layer1_global_rules.md for any call classified as roleFamily="engineering".

  What to change here if intent changes:
    - To add new companies to the tool registry: add entries under section B.
    - To add new keyword classes: add to section C.
    - To adjust the action verb pool: edit section D.
    - To change summary framing guidance: edit section E.
    - Do NOT add global rules here — those belong in layer1_global_rules.md.

  Depends on:
    - services/classifier.js (sets domainModuleKey="engineering")
    - services/promptAssembler.js (loads this file by key)
    - layer1_global_rules.md (must be consistent with its company authenticity rule)
-->

## DOMAIN MODULE: ENGINEERING

### A. DOMAIN CONTEXT

Software engineers design, build, validate, debug, and operate systems that process data, serve users, coordinate workflows, or control hardware. Success is measured by system reliability, latency, throughput, correctness, observability, and the velocity at which the team ships quality code. The vocabulary is technical and precise: engineers name specific languages, frameworks, cloud services, operating systems, hardware interfaces, debug tools, and operational practices. Seniority signals in resumes include system scale (users served, data volume, request rate), low-level ownership (drivers, kernels, firmware, bring-up, validation), cross-team influence, and ownership of critical infrastructure or product decisions.

### B. CANONICAL TOOL REGISTRY

Use this registry to verify company-authentic tool placement. Only assign a tool to a company if it appears in that company's entry below.

- **Stripe:** GCP-native (Pub/Sub, BigQuery, GKE, Dataflow), Python, Go, TypeScript, payments infrastructure, financial data pipelines, risk and fraud, event-driven architecture
- **Amazon:** AWS-native (Lambda, SQS, S3, DynamoDB, EKS), Java/Kotlin, Spring Boot, PostgreSQL, e-commerce backend, supply chain, distributed systems
- **Google:** GCP (Vertex AI, BigQuery ML, Pub/Sub, GKE), TensorFlow/JAX, Python, Go, ML platform, large-scale model training, Search/Ads/Maps/YouTube, feature stores, recommendation systems, LLM fine-tuning
- **Meta:** PyTorch, Presto, Hive, Spark, FBLearner ML platform, Python/C++, Kubernetes, social graph, ads ranking, real-time event processing
- **Microsoft:** Azure-native (AKS, Event Hubs, Cosmos DB, Azure ML), C#/.NET, TypeScript, Python, enterprise SaaS, M365, GitHub platform engineering
- **Uber:** Kafka, Flink, Presto, Cadence, Kubernetes, Go/Java/Python, Michaelangelo ML platform, PostgreSQL, Redis, marketplace dispatch, geospatial platform, pricing and demand forecasting
- **Lyft:** Kafka, Flink, AWS, Snowflake, Amundsen, Python/Java/Go, Kubernetes, ride-share marketplace, pricing and ETA prediction
- **DoorDash:** Kafka, Flink, Snowflake, AWS, Kotlin/Python/Go, Kubernetes, last-mile delivery logistics, real-time order routing, ML for ETD and fraud
- **Airbnb:** Airflow, Spark, Presto, Druid, AWS, Python/Java/Ruby, Kubernetes, Minerva metrics platform, marketplace search and ranking, pricing optimisation, trust and safety
- **Snowflake:** Java/C++/Python, multi-cloud, query optimisation, data sharing and governance, storage-compute separation
- **Databricks:** Apache Spark, Delta Lake, MLflow, LLM fine-tuning and serving, Python/Scala/Java, multi-cloud, data lakehouse
- **Palantir:** Foundry, Gotham, Java/TypeScript, ontology-driven data modelling, government and enterprise analytics
- **Salesforce:** Apex/Java/Python, Heroku, MuleSoft, Tableau, Lightning Web Components, CRM, Sales/Service/Marketing Cloud
- **PayPal:** Java/Node.js/Python, AWS and GCP, Kafka, PostgreSQL, payments platform, fraud detection, checkout and wallet APIs
- **Capital One:** AWS-native, Python/Java, Spark, Kafka, Kubernetes, consumer banking, credit risk, fraud analytics
- **JPMorgan:** Java/.NET/Python, AWS and private cloud, Kafka, Oracle, investment banking, risk and compliance, regulatory reporting
- **Goldman Sachs:** Java/Python, SecDB, Marquee, low-latency systems, trading platform, market data, risk analytics
- **UnitedHealth:** Java/Python/.NET, AWS, Kafka, FHIR interoperability, healthcare data platform, claims processing, HIPAA-compliant pipelines
- **CVS Health:** Java/Python, AWS, Spark, SQL, pharmacy and benefits management, healthcare analytics
- **Instacart:** Python/Go, Kafka, Spark, Snowflake, AWS, ML for demand forecasting, grocery delivery marketplace
- **Shopify:** Ruby/Go/React, MySQL, Kafka, Kubernetes, GCP, GraphQL, e-commerce platform, merchant and checkout systems
- **Datadog:** Python/Go, Kubernetes, AWS/GCP/Azure, distributed tracing, APM, log management, metrics pipelines
- **Twilio:** Python/Ruby/Java/Node, Kafka, AWS, REST APIs, telephony and messaging infrastructure
- **HashiCorp:** Go, Terraform, Vault, Consul, Nomad, infrastructure-as-code
- **MongoDB:** JavaScript/Python/Java, Atlas, Realm, document database, aggregation pipelines
- **Cloudflare:** Rust/Go/TypeScript, edge computing, Workers, DDoS mitigation, CDN
- **Okta:** Java/Node, OAuth 2.0, SAML, OIDC, identity platform
- **NVIDIA:** C/C++, CUDA, Linux, driver and kernel work, graphics, compute runtimes, performance profiling, silicon validation, simulation/emulation debug
- **Qualcomm:** C/C++, embedded Linux, RTOS, wireless protocols, modem/connectivity software, device drivers, firmware, post-silicon validation, JTAG and trace tooling
- **Intel:** C/C++, Linux kernel, compiler/toolchain work, firmware, platform software, CPU architecture, performance engineering, hardware/software debug
- **AMD:** C/C++, Linux, GPU drivers, firmware, graphics and compute stacks, performance profiling, silicon bring-up, validation workflows
- **Tesla:** C/C++, Python, embedded Linux, RTOS, robotics/autonomy systems, hardware/software co-debug, diagnostics, test automation, board bring-up

### C. TIER 1 KEYWORD CLASSES

- Languages and runtimes
- Frameworks and libraries
- Cloud providers and specific services (by provider)
- Data stores (SQL, NoSQL, time-series, cache)
- Message brokers and streaming
- Container and orchestration platforms
- CI/CD and DevOps tooling
- Monitoring, observability, and alerting
- Security and compliance frameworks
- ML/AI frameworks (only if in JD)
- System design concepts (distributed systems, consensus, CAP theorem, etc.)
- Firmware and embedded systems (embedded C/C++, RTOS, bootloaders, BSP, device drivers)
- Hardware/software debug (JTAG, OpenOCD, TRACE32, gdb, probes, trace, registers, memory, peripherals)
- Silicon and board workflows (SoC bring-up, board bring-up, validation, post-silicon, simulation, emulation)
- Low-level systems (operating systems, kernels, compilers, runtimes, concurrency, synchronization, memory management)
- Engineering specialties (graphics, imaging, audio/video, wireless, payments, information retrieval, cryptography, test automation, UI implementation)

### D. ACTION VERB POOL

Built, Designed, Reduced, Migrated, Refactored, Automated, Optimised, Deployed, Implemented, Instrumented, Architected, Containerised, Provisioned, Debugged, Profiled, Benchmarked, Scaled, Integrated, Modularised, Secured, Monitored, Orchestrated, Sharded, Replicated, Partitioned, Load-tested, Diagnosed, Shipped, Merged, Released, Validated, Verified, Traced, Ported, Stabilised

### E. SUMMARY FRAMING GUIDANCE

Open with the exact target role title and a specific year count. Name the primary language/stack and the system class (distributed systems, ML platform, data infrastructure, firmware, embedded software, drivers, platform software, validation, etc.). Use infrastructure, systems, hardware, or debug vocabulary native to the JD. Close with a sentence about the business domain or product area the candidate has most experience in, framed using the JD's functional language.
