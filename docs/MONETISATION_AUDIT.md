# Monetisation Audit and Kill Switch

Run the audit FIRST and report before changing anything. The gating half depends on what it finds.

---

## PART 1 — Audit (read-only, report before touching anything)

```
Session-aware: read by SYMBOL, not line number. Reconstruct from the repo and production, not from
docs. This task CHANGES NOTHING — produce a report.

WHY THIS EXISTS
The owner has NOT registered an entity, has taken NO payments, and has set the Chrome Web Store
trader declaration to NON-TRADER on that basis. The stated bar for incorporating is ~1000
applications across users. Meanwhile the codebase carries plan tiers, entitlement gates, and
upgrade paths built over many months, and nobody has audited what they currently claim or expose.

A non-trader declaration is only accurate while the product is not acting commercially. If the
deployed app can take money, or tells a user it will, that declaration is wrong — and it is a legal
statement, not a settings field.

WHAT TO ESTABLISH

1 · CAN THE DEPLOYED APP TAKE MONEY TODAY?
   The decisive question. Report whether ANY path exists in production that could result in a
   charge: a payment processor integration, a checkout route, a Stripe/Paddle/Lemon key in the
   environment, a hosted pricing page with a live buy button, a webhook receiver.
   ⛔ Answer from the DEPLOYED build, not the repo. Something can exist in code and not be served.
   Assert a JSON key from any payment-related route rather than trusting a 200 — the SPA catch-all
   answers 200 for any unknown path and has already "confirmed" a deployment that never happened.

2 · WHAT DOES THE PRODUCT CLAIM ABOUT PRICE, ANYWHERE A USER CAN SEE IT?
   Inventory every user-visible mention of plans, tiers, pricing, upgrading, trials, limits framed
   as "upgrade to raise", or anything implying a paid relationship. Include: the marketing/landing
   pages, the app shell, ProfilePanel (which hardcodes "Admin • Pro"), upgrade prompts, the 403
   upgrade_required error shape, the extension's store listing copy, and the privacy policy.
   Report each with its exact current wording.
   A promise of a paid tier is a commercial claim even when no money can change hands.

3 · MAP THE ENTITLEMENT SURFACE
   - shared/entitlements.js: canUseAPlusResume, normalisePlanTier, and every other gate.
   - Every call site that branches on planTier. Known: routes/apply.js returns 403
     upgrade_required for A+ on a non-PRO plan; server.js has requireToolEntitlement (~:4067).
   - The users.plan_tier column: its values in production, the distribution across real users, and
     what sets it. Is there any path by which a user's tier CHANGES, and what is it?
   - Do the apply caps (APPLY_DAILY_CAP 25, APPLY_DAILY_QUEUE_CAP 40, APPLY_DAILY_APPROVAL_CAP 30)
     vary by tier, or are they flat? Report which.

4 · IS THE GATING COHERENT, OR VESTIGIAL?
   For each gate: does it currently DO anything for a real user? A gate on a tier nobody can buy
   and nobody has is theatre. Report per gate: enforced / inert / unreachable.
   Note the precedent — the A+ entitlement gate was added in §5.15 because repairing the tool/
   toolType plumbing would otherwise have opened a plan-tier bypass. It was correct then. Whether
   it is doing anything NOW is a different question.

5 · COST EXPOSURE, which is the real monetary risk right now
   No revenue exists, but spend does. Report:
   - Current actual spend from usage_events, by event type. Last measured: enrich_job 60.2%,
     $3.32 over 1302 calls.
   - Which paths an UNAUTHENTICATED user can reach that cost money. /api/standalone/generate runs
     Sonnet at 8192 max_tokens behind standaloneRateLimit("generate", 1, 2). That is the only
     anonymous spend surface found so far — confirm whether there are others.
   - Whether any per-user spend ceiling exists that is not a per-action cap. The caps bound
     actions; they do not bound cost.
   ⛔ This matters more than the tier gating: an unmetered public generation endpoint is a real
   bill with no revenue behind it.

6 · WHAT THE EXTENSION LISTING AND THE PRIVACY POLICY SAY
   The store listing declares the extension "Free of charge" and the account non-trader. Confirm
   nothing in the extension or its listing implies a purchase. Confirm the privacy policy does not
   describe payment data collection that does not happen.

OUTPUT
A table: surface · what it claims · what it enforces · reachable by a real user? · verdict.
Then a plain statement answering: CAN the deployed product take money, and DOES it claim it will?
Recommend what PART 2 should hide. Change nothing in this task.
```

---

## PART 2 — One lever, off by default

```
Only after Part 1 is accepted. Scope is set by what it found.

OBJECTIVE
Put every commercial surface behind ONE switch, defaulted OFF, so the product presents as free and
untiered during the testing phase — and can be switched on in one place when the owner incorporates
and starts charging. Do not delete the entitlement machinery; it was built deliberately and will be
needed.

1 · ONE LEVER, NOT SEVERAL.
   A single config/env flag — e.g. MONETISATION_ENABLED, default OFF. Every commercial surface
   reads it. ⛔ Do NOT add a second flag for a subset, and do NOT let any surface decide
   independently. Two switches that can disagree is this codebase's most-repeated defect shape:
   mapJobRow vs the client mapper, popup vs hotkey, three hardcoded tab lists, 'mid level' vs 'mid'.

2 · OFF MEANS ABSENT, NOT DISABLED.
   A greyed-out Upgrade button still claims a paid tier exists. With the lever off: no pricing
   copy, no upgrade prompts, no tier badges, no "PRO" labels, no upsell in an error message. The
   403 upgrade_required path must not be reachable — if a feature is gated on PRO and the lever is
   off, the feature is simply available, not refused with an upsell.

3 · ⛔ THE GATES MUST STILL EXIST IN CODE AND STILL BE TESTED.
   Removing them is not the goal. §5.15 added the A+ entitlement check because repairing the
   tool/toolType plumbing would otherwise have opened a plan-tier bypass; that reasoning survives.
   Keep every gate and its tests; the lever decides whether the gate is CONSULTED, not whether it
   exists. Assert both states: lever on, a BASIC user is refused; lever off, the same user is
   served.

4 · SPEND CEILINGS ARE NOT COMMERCIAL SURFACES — THEY STAY ON.
   ⛔ APPLY_DAILY_CAP, APPLY_DAILY_QUEUE_CAP, APPLY_DAILY_APPROVAL_CAP and any generation limit are
   COST CONTROLS, not upsells, and must be unaffected by the lever. They protect the owner's bill,
   which is the only real money in the system today. Only their MESSAGING changes: a cap that says
   "upgrade to raise this limit" becomes a plain statement of the limit.

5 · ProfilePanel hardcodes "Admin • Pro". That is a display lie independent of the lever — it says
   PRO regardless of the user's actual tier. Fix it to read the real value, then let the lever
   decide whether a tier is shown at all.

6 · ANONYMOUS SPEND. If Part 1 confirms /api/standalone/* can be reached unauthenticated and costs
   money, that is a cost decision, not a monetisation one. Report options — tighter rate limit,
   auth requirement, a daily ceiling — and let the owner choose. Do not gate it behind the lever;
   it needs bounding whether or not the product is commercial.

7 · TRADER DECLARATION. Record in the code, beside the lever, that turning it ON has a legal
   consequence: the Chrome Web Store trader declaration is currently NON-TRADER on the basis that
   no entity exists and no payment is possible. Switching this lever on makes that declaration
   inaccurate and it must be updated in the same change. A comment beside a flag is where the next
   person will actually read it.

VERIFY (real runs)
Lever OFF: a real user sees no pricing, no tier, no upgrade prompt anywhere in the inventory from
Part 1 item 2. Every gated feature is available. No 403 upgrade_required is reachable. Screenshot
each surface that previously showed a commercial claim.
Lever ON: every gate enforces exactly as it does today, and the existing entitlement tests pass
unchanged.
Caps behave identically in both states.
```

---

## Context for whoever runs this

The owner's position, stated 2026-09-09: **no LLC, no payments taken, ~1000 applications across
users is the bar for incorporating.** The Chrome Web Store trader declaration is set to
**non-trader** on that basis.

The product has completed **one** real job application end to end. Plan tiers, entitlement gates and
upgrade paths were built across many months of work that ran well ahead of the product being used.
This task is bringing the commercial surface back in line with where the product actually is — not
removing it.
