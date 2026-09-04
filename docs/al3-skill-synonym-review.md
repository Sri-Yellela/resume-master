# AL3 (G1) — skill synonym review sheet

Generated 2026-09-04T21:46:32.511Z from `skill_synonyms`.

**196 pairs await a decision. 12 are already confirmed and live.**

⛔ **Nothing here is affecting any score.** The scorer reads only `status='confirmed'` rows. A
false equivalence is a confidently wrong match — it does not merely inflate a number, it tells a
candidate they have a skill they do not have, and it shifts every posting mentioning either term in
the same direction at once. That is why corroboration cannot promote a row here, unlike
`company_org_units`: more postings using both words is not evidence that the words mean the same
thing.

## How to read a row

**`alias`** claims the two are the same thing under different names — interchangeable in any
sentence. These are usually obvious and usually right.

**`related`** claims they are different but close enough to credit. **This is where the rho comes
from and where the false matches come from.** Judge it by asking: *if a résumé says only the
right-hand term, is it honest to tell the candidate they match a posting asking for the left-hand
one?* If that is arguable, reject — a missed pair costs far less than a false one.

Confirm or reject with:

```
node scripts/al3SkillSynonyms.mjs --confirm "term|equivalent"
node scripts/al3SkillSynonyms.mjs --reject  "term|equivalent"
```

A rejection is **sticky**: later extraction passes will not resurrect it.

## Proposed

| term | equivalent | relation | postings | confidence | ✅/❌ | note |
|---|---|---|---|---|---|---|
| `backend engineering` | `backend service` | alias | 25 | 1.00 | | |
| `empathy` | `user empathy` | alias | 25 | 1.00 | | |
| `partnership` | `partnership and collaboration` | alias | 25 | 1.00 | | |
| `payment` | `payment system` | alias | 25 | 1.00 | | |
| `product judgment` | `product thinking` | alias | 25 | 1.00 | | |
| `model deployment` | `production deployment` | alias | 20 | 1.00 | | |
| `agentic ai solution` | `agentic system` | alias | 18 | 1.00 | | |
| `creative problem solving` | `creative thinking` | alias | 14 | 1.00 | | |
| `partnership building` | `stakeholder partnership` | alias | 14 | 1.00 | | |
| `product sense` | `product sensibility` | alias | 14 | 1.00 | | |
| `product mindset` | `product sense` | alias | 13 | 1.00 | | |
| `product mindset` | `product sensibility` | alias | 13 | 1.00 | | |
| `ambiguity navigation` | `decision making under ambiguity` | alias | 10 | 1.00 | | |
| `independent operation` | `self starting mindset` | alias | 8 | 1.00 | | |
| `ability to thrive in ambiguity` | `managing ambiguity` | alias | 6 | 1.00 | | |
| `ability to work in ambiguou environment` | `dealing with ambiguity` | alias | 6 | 1.00 | | |
| `analytical` | `analytical abilitie` | alias | 6 | 1.00 | | |
| `autonomou work` | `autonomy and ownership` | alias | 6 | 1.00 | | |
| `distributed backend system` | `distributed system design` | alias | 6 | 1.00 | | |
| `financial product` | `financial product knowledge` | alias | 6 | 1.00 | | |
| `front end development` | `frontend engineering` | alias | 6 | 1.00 | | |
| `generalist mindset` | `generalist problem solving` | alias | 6 | 1.00 | | |
| `iam` | `identity system` | alias | 6 | 1.00 | | |
| `mcp` | `mcps` | alias | 6 | 1.00 | | |
| `product roadmap` | `product roadmapping` | alias | 6 | 1.00 | | |
| `saas` | `saas product` | alias | 6 | 1.00 | | |
| `strategic decision making` | `strategy definition` | alias | 6 | 1.00 | | |
| `supplier selection` | `vendor evaluation` | alias | 6 | 1.00 | | |
| `technical requirement analysi` | `technical requirement understanding` | alias | 6 | 1.00 | | |
| `technical advisory` | `technical consulting` | alias | 1 | 0.20 | | |
| `account strategy` | `deal qualification` | related | 25 | 1.00 | | |
| `api` | `api design` | related | 25 | 1.00 | | |
| `api integration` | `integration` | related | 25 | 1.00 | | |
| `autonomy` | `self starter` | related | 25 | 1.00 | | |
| `autonomy` | `end to end ownership` | related | 25 | 1.00 | | |
| `billing system` | `payment` | related | 25 | 1.00 | | |
| `cloud infrastructure` | `terraform` | related | 25 | 1.00 | | |
| `collaboration` | `cros team collaboration` | related | 25 | 1.00 | | |
| `communication` | `executive communication` | related | 25 | 1.00 | | |
| `consultative selling` | `deal qualification` | related | 25 | 1.00 | | |
| `customer partnership` | `relationship management` | related | 25 | 1.00 | | |
| `data driven decision making` | `decision making` | related | 25 | 1.00 | | |
| `discovery` | `prospecting` | related | 25 | 1.00 | | |
| `executive presence` | `influence` | related | 25 | 1.00 | | |
| `infrastructure` | `infrastructure as code` | related | 25 | 1.00 | | |
| `leadership` | `team leadership` | related | 25 | 1.00 | | |
| `partnership` | `strategic partnership` | related | 25 | 1.00 | | |
| `partnership and collaboration` | `strategic partnership` | related | 25 | 1.00 | | |
| `product judgment` | `technical judgment` | related | 25 | 1.00 | | |
| `product strategy` | `technical strategy` | related | 25 | 1.00 | | |
| `storytelling` | `technical communication` | related | 25 | 1.00 | | |
| `strategic planning` | `strategic thinking` | related | 25 | 1.00 | | |
| `stakeholder engagement` | `stakeholder influence` | related | 24 | 1.00 | | |
| `customer empathy` | `customer engagement` | related | 23 | 1.00 | | |
| `detection engineering` | `troubleshooting` | related | 23 | 1.00 | | |
| `deal structuring` | `sale cycle management` | related | 22 | 1.00 | | |
| `sale enablement` | `value selling` | related | 22 | 1.00 | | |
| `stakeholder collaboration` | `stakeholder influence` | related | 22 | 1.00 | | |
| `technical decision making` | `technical guidance` | related | 20 | 1.00 | | |
| `evaluation system` | `model evaluation` | related | 19 | 1.00 | | |
| `generative ai` | `large language model` | related | 19 | 1.00 | | |
| `llm fine tuning` | `model training` | related | 19 | 1.00 | | |
| `agent` | `agentic system` | related | 18 | 1.00 | | |
| `ambiguity management` | `ambiguou problem solving` | related | 18 | 1.00 | | |
| `large language model` | `llm fine tuning` | related | 18 | 1.00 | | |
| `stripe api` | `stripe connect` | related | 17 | 1.00 | | |
| `customer communication` | `strategic communication` | related | 16 | 1.00 | | |
| `discovery and value selling` | `qualification` | related | 16 | 1.00 | | |
| `endpoint security` | `vulnerability management` | related | 16 | 1.00 | | |
| `failure analysi` | `risk mitigation` | related | 16 | 1.00 | | |
| `log analysi` | `monitoring` | related | 15 | 1.00 | | |
| `software architecture` | `solution architecture` | related | 15 | 1.00 | | |
| `ai architecture design` | `technical architecture` | related | 14 | 1.00 | | |
| `ai system design` | `ml system` | related | 14 | 1.00 | | |
| `evaluation` | `evaluation framework` | related | 14 | 1.00 | | |
| `strategic vision` | `strategy development` | related | 14 | 1.00 | | |
| `architectural decision making` | `scalable system design` | related | 12 | 1.00 | | |
| `communication skill` | `technical conversation` | related | 12 | 1.00 | | |
| `infrastructure engineering` | `reliability engineering` | related | 12 | 1.00 | | |
| `infrastructure security` | `security architecture` | related | 12 | 1.00 | | |
| `javascript` | `typescript` | related | 12 | 1.00 | | |
| `ui design` | `user experience design` | related | 12 | 1.00 | | |
| `automated testing` | `unit testing` | related | 11 | 1.00 | | |
| `payment infrastructure` | `stripe payment` | related | 11 | 1.00 | | |
| `technical product knowledge` | `technical troubleshooting` | related | 11 | 1.00 | | |
| `ai agent` | `llm system` | related | 10 | 1.00 | | |
| `ai workflow` | `llm system` | related | 10 | 1.00 | | |
| `anomaly detection` | `fraud prevention` | related | 10 | 1.00 | | |
| `clear communication` | `empathetic communication` | related | 10 | 1.00 | | |
| `customer facing communication` | `empathetic communication` | related | 10 | 1.00 | | |
| `data architecture` | `infrastructure design` | related | 10 | 1.00 | | |
| `end to end problem ownership` | `high ownership` | related | 10 | 1.00 | | |
| `engineering judgment` | `operational judgment` | related | 10 | 1.00 | | |
| `high agency` | `learning agility` | related | 10 | 1.00 | | |
| `infrastructure design` | `platform engineering` | related | 10 | 1.00 | | |
| `messaging and positioning` | `product positioning` | related | 10 | 1.00 | | |
| `performance engineering` | `performance profiling` | related | 10 | 1.00 | | |
| `presentation skill` | `verbal communication` | related | 10 | 1.00 | | |
| `technical design` | `technical direction setting` | related | 10 | 1.00 | | |
| `collaboration` | `cros functional partnership` | related | 9 | 1.00 | | |
| `ci cd security` | `saas security` | related | 8 | 1.00 | | |
| `code level debugging` | `code writing` | related | 8 | 1.00 | | |
| `complex sale cycle` | `enterprise sale cycle` | related | 8 | 1.00 | | |
| `creative direction` | `creativity` | related | 8 | 1.00 | | |
| `cros disciplinary collaboration` | `cros functional influence` | related | 8 | 1.00 | | |
| `customer discovery` | `discovery and scoping` | related | 8 | 1.00 | | |
| `dashboard creation` | `kpi tracking` | related | 8 | 1.00 | | |
| `deal management` | `deal negotiation` | related | 8 | 1.00 | | |
| `developer empathy` | `developer experience focu` | related | 8 | 1.00 | | |
| `monitoring system` | `system reliability` | related | 8 | 1.00 | | |
| `technical direction` | `technical expertise` | related | 8 | 1.00 | | |
| `threat hunting` | `vulnerability triage` | related | 8 | 1.00 | | |
| `code quality standard` | `secure code review` | related | 7 | 1.00 | | |
| `agent development` | `multi agent workflow` | related | 6 | 1.00 | | |
| `agent development` | `ai workflow design` | related | 6 | 1.00 | | |
| `ai llm` | `applied ai` | related | 6 | 1.00 | | |
| `ai ml` | `machine learning infrastructure` | related | 6 | 1.00 | | |
| `analytical` | `analytical rigor` | related | 6 | 1.00 | | |
| `analytical abilitie` | `analytical rigor` | related | 6 | 1.00 | | |
| `analytical judgment` | `diagnostic thinking` | related | 6 | 1.00 | | |
| `authentication error resolution` | `identity management` | related | 6 | 1.00 | | |
| `autonomy and ownership` | `self motivation` | related | 6 | 1.00 | | |
| `cash management` | `order to cash processe` | related | 6 | 1.00 | | |
| `complexity simplification` | `problem shaping` | related | 6 | 1.00 | | |
| `consultative approach` | `questioning assumption` | related | 6 | 1.00 | | |
| `consultative sale` | `listening skill` | related | 6 | 1.00 | | |
| `data center infrastructure` | `data center operation` | related | 6 | 1.00 | | |
| `data orchestration` | `streaming feature pipeline` | related | 6 | 1.00 | | |
| `data orchestration` | `pipeline development` | related | 6 | 1.00 | | |
| `data pipeline design` | `streaming technologie` | related | 6 | 1.00 | | |
| `datadog` | `pinot` | related | 6 | 1.00 | | |
| `design judgment` | `judgment and decision making` | related | 6 | 1.00 | | |
| `email outreach` | `linkedin outreach` | related | 6 | 1.00 | | |
| `engineering management` | `people leadership` | related | 6 | 1.00 | | |
| `financial product` | `fintech product` | related | 6 | 1.00 | | |
| `full stack software engineering` | `web development` | related | 6 | 1.00 | | |
| `generalist mindset` | `technical curiosity` | related | 6 | 1.00 | | |
| `hardware bring up` | `hardware validation` | related | 6 | 1.00 | | |
| `infrastructure automation` | `infrastructure deployment` | related | 6 | 1.00 | | |
| `infrastructure deployment` | `provisioning` | related | 6 | 1.00 | | |
| `intellectual property law` | `technology law` | related | 6 | 1.00 | | |
| `judgment and decision making` | `judgment under pressure` | related | 6 | 1.00 | | |
| `llm optimization` | `model integration` | related | 6 | 1.00 | | |
| `machine learning model development` | `production ml system` | related | 6 | 1.00 | | |
| `osint` | `spi` | related | 6 | 1.00 | | |
| `people leadership` | `program leadership` | related | 6 | 1.00 | | |
| `pragmatic problem solving` | `problem distillation` | related | 6 | 1.00 | | |
| `problem distillation` | `problem identification` | related | 6 | 1.00 | | |
| `product development` | `react native` | related | 6 | 1.00 | | |
| `proof of concept design` | `prototype validation` | related | 6 | 1.00 | | |
| `security assessment` | `threat detection` | related | 6 | 1.00 | | |
| `system debugging` | `system level investigation` | related | 6 | 1.00 | | |
| `coaching` | `mentoring` | related | 5 | 1.00 | | |
| `go to market strategy` | `product marketing` | related | 5 | 1.00 | | |
| `incident response` | `observability` | related | 5 | 1.00 | | |
| `program management` | `project management` | related | 5 | 1.00 | | |
| `consultative selling` | `sale` | related | 4 | 0.80 | | |
| `discovery` | `prospect discovery` | related | 4 | 0.80 | | |
| `i2c` | `uart` | related | 4 | 0.80 | | |
| `airtable` | `asana` | related | 3 | 0.60 | | |
| `coaching` | `mentorship` | related | 3 | 0.60 | | |
| `commercial credit underwriting` | `financial risk modeling` | related | 3 | 0.60 | | |
| `datacenter security` | `kubernetes security` | related | 3 | 0.60 | | |
| `detection pipeline engineering` | `threat detection` | related | 3 | 0.60 | | |
| `dfa` | `dfm` | related | 3 | 0.60 | | |
| `dfm` | `dft` | related | 3 | 0.60 | | |
| `end to end testing` | `service testing` | related | 3 | 0.60 | | |
| `jenkin` | `spinnaker` | related | 3 | 0.60 | | |
| `scim` | `sso` | related | 3 | 0.60 | | |
| `after effect` | `animation` | related | 2 | 0.40 | | |
| `cold calling` | `email outreach` | related | 2 | 0.40 | | |
| `communication` | `written communication` | related | 2 | 0.40 | | |
| `marketing automation` | `marketo` | related | 2 | 0.40 | | |
| `post training` | `rlhf` | related | 2 | 0.40 | | |
| `system design` | `system thinking` | related | 2 | 0.40 | | |
| `account management` | `account planning` | related | 1 | 0.20 | | |
| `analytical thinking` | `data driven decision making` | related | 1 | 0.20 | | |
| `billing system` | `payment system` | related | 1 | 0.20 | | |
| `causal inference` | `root cause analysi` | related | 1 | 0.20 | | |
| `ci cd pipeline` | `test automation` | related | 1 | 0.20 | | |
| `collaboration` | `cros functional collaboration` | related | 1 | 0.20 | | |
| `communication` | `verbal communication` | related | 1 | 0.20 | | |
| `critical thinking` | `navigating ambiguity` | related | 1 | 0.20 | | |
| `cros border payment` | `local payment method` | related | 1 | 0.20 | | |
| `cros functional coordination` | `stakeholder communication` | related | 1 | 0.20 | | |
| `data integration` | `system integration` | related | 1 | 0.20 | | |
| `data science` | `modeling` | related | 1 | 0.20 | | |
| `executive engagement` | `stakeholder alignment` | related | 1 | 0.20 | | |
| `infiniband` | `rdma` | related | 1 | 0.20 | | |
| `kyc kyb` | `third party risk management` | related | 1 | 0.20 | | |
| `leadership` | `technical leadership` | related | 1 | 0.20 | | |
| `ml infrastructure` | `model serving` | related | 1 | 0.20 | | |
| `model inference` | `model optimization` | related | 1 | 0.20 | | |
| `saas sale` | `technical product sale` | related | 1 | 0.20 | | |
| `security mindset` | `security operation` | related | 1 | 0.20 | | |
| `threat hunting` | `threat intelligence` | related | 1 | 0.20 | | |

## Already confirmed — live in the scorer

| term | equivalent | relation | reviewed by |
|---|---|---|---|
| `ambiguity tolerance` | `comfort with ambiguity` | alias | owner |
| `analytic` | `analytical skill` | alias | owner |
| `backend development` | `backend engineering` | alias | owner |
| `bias for action` | `bias toward action` | alias | owner |
| `client relationship management` | `crm` | alias | owner |
| `influencing` | `persuasion` | alias | owner |
| `mentoring` | `mentorship` | alias | owner |
| `people management` | `team management` | alias | owner |
| `prospect discovery` | `prospecting` | alias | owner |
| `roadmap development` | `roadmap planning` | alias | owner |
| `stakeholder collaboration` | `stakeholder engagement` | alias | owner |
| `technical concept translation` | `technical translation` | alias | owner |
