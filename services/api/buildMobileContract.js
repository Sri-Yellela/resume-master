/**
 * THE GENERATOR — turns the source of truth into the published artefacts.
 * ================================================================================================
 *
 * Produces two things from the modules beside it:
 *   - an OpenAPI 3.1 document  (contract/mobile-api.v1.json)
 *   - TypeScript declarations  (contract/mobile-api.v1.d.ts)
 *
 * DETERMINISM IS A REQUIREMENT, NOT A NICETY, and it is what makes the drift test possible.
 *
 * The contract test regenerates in memory and compares against the committed file. That comparison
 * is only meaningful if two runs over unchanged source produce byte-identical output — so there is
 * NO generation timestamp, NO git sha, NO hostname, and NO Object.keys ordering that depends on
 * anything but the source. A "generated at" line would be honest-looking and would make every
 * regeneration a diff, which is exactly how a drift check gets disabled for being noisy.
 *
 * Every map is emitted through `sortedEntries`, so a key added anywhere lands in a stable place.
 */
"use strict";

import {
  CONTRACT_VERSION, JOB_FIELDS, JOB_REQUIRED_FIELDS, JOB_FIELD_TYPES, JOB_FIELD_DEFAULTS,
  ENUMS, MOBILE_TIER_GATING,
} from "./mobileContract.js";
import { MOBILE_ENDPOINTS, RETIRED_ENDPOINTS, ERROR_SHAPES, MOBILE_GAPS } from "./mobileEndpoints.js";
import { RESPONSE_SCHEMAS } from "./mobileSchemas.js";

const sortedEntries = (obj) => Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const sortedMap = (obj, fn) => Object.fromEntries(sortedEntries(obj).map(([k, v]) => [k, fn(v, k)]));

// ------------------------------------------------------------------------------------------------
// THE TYPE MINI-LANGUAGE
// ------------------------------------------------------------------------------------------------
// "string" | "number" | "boolean" | "object" | "$Ref" | "enum:name", with optional "[]" and
// "|null" suffixes. Small enough to read without a grammar, and small enough that both back ends
// below are obviously total over it — an unrecognised token THROWS rather than silently emitting
// `any`, because `any` in a published contract is a lie that type-checks.
function parseType(spec) {
  let s = String(spec);
  let nullable = false;
  if (s.endsWith("|null")) { nullable = true; s = s.slice(0, -5); }
  let array = false;
  if (s.endsWith("[]")) { array = true; s = s.slice(0, -2); }
  if (s.endsWith("|null")) { nullable = true; s = s.slice(0, -5); }
  return { base: s, array, nullable };
}

/** JSON Schema (OpenAPI 3.1 flavour: nullability is a type union, not an x-nullable flag). */
function toJsonSchema(spec) {
  const { base, array, nullable } = parseType(spec);
  let node;
  if (base.startsWith("$")) {
    node = { $ref: `#/components/schemas/${base.slice(1)}` };
    // A $ref cannot carry siblings in strict JSON Schema, so nullability wraps it.
    if (nullable) node = { oneOf: [node, { type: "null" }] };
    return array ? { type: "array", items: node } : node;
  } else if (base.startsWith("enum:")) {
    const name = base.slice(5);
    const vals = ENUMS[name];
    if (!vals) throw new Error(`unknown enum "${name}" in type "${spec}"`);
    node = { type: nullable ? ["string", "null"] : "string", enum: nullable ? [...vals, null] : [...vals] };
  } else if (["string", "number", "boolean", "object"].includes(base)) {
    node = { type: nullable ? [base, "null"] : base };
  } else {
    throw new Error(`unrecognised type token "${base}" in "${spec}"`);
  }
  return array ? { type: "array", items: node } : node;
}

/** TypeScript. `?:` is reserved for genuinely ABSENT keys; `| null` is a present null. */
function toTsType(spec) {
  const { base, array, nullable } = parseType(spec);
  let t;
  if (base.startsWith("$")) t = base.slice(1);
  else if (base.startsWith("enum:")) {
    const vals = ENUMS[base.slice(5)];
    if (!vals) throw new Error(`unknown enum in "${spec}"`);
    t = vals.map(v => JSON.stringify(v)).join(" | ");
    if (vals.length > 1) t = `(${t})`;
  } else if (base === "object") t = "Record<string, unknown>";
  else if (["string", "number", "boolean"].includes(base)) t = base;
  else throw new Error(`unrecognised type token "${base}" in "${spec}"`);
  if (array) t = `${t}[]`;
  return nullable ? `${t} | null` : t;
}

// ------------------------------------------------------------------------------------------------
// THE JOB SCHEMA — the derived one
// ------------------------------------------------------------------------------------------------
function jobSchema() {
  const properties = {};
  for (const field of [...JOB_FIELDS].sort()) {
    const decl = JOB_FIELD_TYPES[field];
    // Cannot happen once the contract test passes; thrown rather than skipped so that if it ever
    // did, generation would stop instead of quietly publishing a job shape with a hole in it.
    if (!decl) throw new Error(`mapJobRow field "${field}" has no declared type in JOB_FIELD_TYPES`);
    const spec = decl.enum
      ? `enum:${decl.enum}${decl.nullable ? "|null" : ""}`
      : `${decl.type}${decl.nullable ? "|null" : ""}`;
    const node = toJsonSchema(spec);
    if (decl.description) node.description = decl.description;
    if (decl.format) node.format = decl.format;
    if (Object.prototype.hasOwnProperty.call(JOB_FIELD_DEFAULTS, field)) {
      node["x-empty-row-value"] = JOB_FIELD_DEFAULTS[field];
    }
    properties[field] = node;
  }
  return {
    type: "object",
    description:
      "DERIVED FROM services/jobs/mapJobRow.js BY EXECUTING IT. Do not hand-edit: regenerate with " +
      "`node scripts/generateMobileContract.mjs`. mapJobRow is a field whitelist and the only shape " +
      "GET /api/jobs, GET /api/jobs/by-id and POST /api/import/job emit, which is what makes it the " +
      "binding constraint on everything reaching a client.",
    properties,
    required: [...JOB_REQUIRED_FIELDS].sort(),
    additionalProperties: false,
    "x-absent-when-null":
      "Fields NOT in `required` are plain pass-throughs in mapJobRow with no null coalescing. When " +
      "their source column is NULL they are `undefined`, and JSON.stringify DELETES the key — so " +
      "they arrive ABSENT, not null. A non-optional field in a Swift or Kotlin decoder throws on " +
      "a missing key even though it tolerates an explicit null. Decode them as optional.",
    "x-empty-row-note":
      "x-empty-row-value on each property is what mapJobRow returns for a row with nothing in it. " +
      "null and false are NOT interchangeable: isH1bSponsor null means 'no signal yet', and " +
      "rendering it as 'does not sponsor' is a false negative about somebody's visa status.",
  };
}

// ------------------------------------------------------------------------------------------------
// DECLARED SCHEMAS
// ------------------------------------------------------------------------------------------------
function declaredSchemas() {
  const out = {};
  for (const [name, def] of sortedEntries(RESPONSE_SCHEMAS)) {
    if (def.binary) {
      out[name] = { type: "string", format: "binary", description: def.description || "" };
      continue;
    }
    // A response that IS an array, with no envelope. Modelled rather than papered over: the
    // difference between `[...]` and `{ profiles: [...] }` is a client rendering an empty list
    // for a user who has four profiles, and it is silent.
    if (def.rootArray) {
      out[name] = {
        type: "array",
        items: toJsonSchema(def.rootArray),
        ...(def.description ? { description: def.description } : {}),
      };
      continue;
    }
    const source = def.sameAs ? RESPONSE_SCHEMAS[def.sameAs] : def;
    if (!source?.fields) throw new Error(`schema "${name}" has neither fields nor a resolvable sameAs`);
    const properties = {};
    for (const [field, spec] of sortedEntries(source.fields)) {
      const node = toJsonSchema(spec);
      const note = source.fieldNotes?.[field] ?? def.fieldNotes?.[field];
      if (note) node.description = note;
      properties[field] = node;
    }
    let schema = { type: "object", properties };
    if (def.description) schema.description = def.description;
    if (def.sameAs) schema["x-same-fields-as"] = def.sameAs;
    // `extends` composes rather than copies. HistoryRunJob is a RunJob plus two fields, and
    // restating RunJob's twenty would be a second copy of the shape the run endpoints already
    // publish — the exact drift this contract exists to prevent. allOf says "and also", which is
    // what a client's decoder needs and what openapi-generator turns into inheritance.
    if (def.extends) {
      if (!RESPONSE_SCHEMAS[def.extends]) throw new Error(`schema "${name}" extends unknown "${def.extends}"`);
      schema = {
        allOf: [{ $ref: `#/components/schemas/${def.extends}` }, schema],
        ...(def.description ? { description: def.description } : {}),
      };
    }
    out[name] = schema;
  }
  return out;
}

function errorSchemas() {
  const out = {};
  for (const [name, def] of sortedEntries(ERROR_SHAPES)) {
    out[`Error${name}`] = {
      type: "object",
      description: def.description || "",
      "x-http-status": def.status,
      properties: sortedMap(def.shape, (v) => (
        // Error shapes use the same tokens, except `Job[]` which only appears in the feed's
        // 400 body — routed through the same parser so it cannot diverge from the real one.
        v === "Job[]" ? { type: "array", items: { $ref: "#/components/schemas/Job" } } : toJsonSchema(v)
      )),
      ...(def.example ? { example: def.example } : {}),
    };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// PATHS
// ------------------------------------------------------------------------------------------------
function buildPaths() {
  const paths = {};
  for (const ep of MOBILE_ENDPOINTS) {
    const item = (paths[ep.path] ||= {});
    const op = {
      operationId: operationIdFor(ep),
      tags: [ep.group],
      summary: ep.summary,
      security: ep.auth === "bearer" ? [{ bearerAuth: [] }, { authContextHeader: [] }] : [],
    };
    if (ep.mobileNotes) op["x-mobile-notes"] = ep.mobileNotes;

    const parameters = [];
    for (const [name, spec] of sortedEntries(ep.params || {})) {
      parameters.push({ name, in: "path", required: true, schema: toJsonSchema(spec) });
    }
    for (const [name, spec] of sortedEntries(ep.query || {})) {
      parameters.push({ name, in: "query", required: false, schema: toJsonSchema(spec) });
    }
    for (const [name, spec] of sortedEntries(ep.headers || {})) {
      parameters.push({
        name, in: "header", required: false, schema: toJsonSchema(spec),
        description: name === "Idempotency-Key"
          ? "Strongly recommended on mobile. A retry over a dropped connection otherwise repeats the write."
          : undefined,
      });
    }
    if (parameters.length) op.parameters = parameters;

    if (ep.body) {
      op.requestBody = {
        required: true,
        content: { "application/json": {
          schema: typeof ep.body === "string"
            ? { $ref: `#/components/schemas/${ep.body}` }
            : { type: "object", properties: sortedMap(ep.body, toJsonSchema) },
        } },
      };
    }

    const responses = {};
    const okStatus = ep.method === "POST" && ep.path === "/api/apply/runs" ? "202" : "200";
    const schema = RESPONSE_SCHEMAS[ep.response];
    responses[okStatus] = schema?.binary
      ? { description: schema.description || "Binary body.",
          content: { [schema.binary]: { schema: { type: "string", format: "binary" } } } }
      : { description: "Success.",
          content: { "application/json": { schema: { $ref: `#/components/schemas/${ep.response}` } } } };
    for (const errName of ep.errors || []) {
      const err = ERROR_SHAPES[errName];
      if (!err) throw new Error(`endpoint ${ep.method} ${ep.path} names unknown error "${errName}"`);
      responses[String(err.status)] = {
        description: err.description || errName,
        content: { "application/json": { schema: { $ref: `#/components/schemas/Error${errName}` } } },
      };
    }
    op.responses = Object.fromEntries(sortedEntries(responses));
    item[ep.method.toLowerCase()] = op;
  }
  return Object.fromEntries(sortedEntries(paths));
}

function operationIdFor(ep) {
  const tail = ep.path
    .replace(/^\/api\//, "")
    .replace(/\{(\w+)\}/g, (_m, g) => g[0].toUpperCase() + g.slice(1))
    .split(/[/-]/)
    .filter(Boolean)
    .map((seg, i) => (i === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join("");
  return ep.method.toLowerCase() + tail[0].toUpperCase() + tail.slice(1);
}

// ------------------------------------------------------------------------------------------------
// THE DOCUMENT
// ------------------------------------------------------------------------------------------------
export function buildOpenApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Resume Master — Mobile API",
      version: CONTRACT_VERSION,
      description:
        "The contract between this repository and the two mobile repositories (iOS, Android), " +
        "which are native clients over this JSON API and live outside this tree.\n\n" +
        "GENERATED — DO NOT HAND-EDIT. Regenerate with `node scripts/generateMobileContract.mjs`. " +
        "The Job schema is produced by EXECUTING services/jobs/mapJobRow.js, so it cannot disagree " +
        "with what the server actually emits. test/mobileApiContract.test.js fails the build if " +
        "this file and the source ever disagree.\n\n" +
        "Only the endpoints a swipe feed and a review flow need are published. Anything absent is " +
        "absent on purpose and is not a promise — see x-retired for what a greenfield client must " +
        "not call, and x-mobile-gaps for what mobile needs that this API does not yet expose.",
    },
    servers: [{ url: "https://resumemaster.one", description: "Production" }],
    tags: [
      { name: "auth",    description: "Sign-in and the durable mobile credential." },
      { name: "feed",    description: "The profile-scoped job board a swipe feed pages through." },
      { name: "swipe",   description: "Absolute-valued save/dislike. Idempotent by design." },
      { name: "apply",   description: "Queue, preview, approve. Nothing is sent unpreviewed." },
      { name: "answers", description: "The questions blocking held applications." },
      { name: "profile", description: "Autofill identity, and the domain profile scoping the board." },
    ],
    security: [{ bearerAuth: [] }],
    paths: buildPaths(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http", scheme: "bearer",
          description:
            "The mobile credential, from GET /api/auth/mobile-token. Accepted on every " +
            "authenticated route: bindAuthContext validates it before requireAuth, which admits " +
            "either a Passport cookie session OR a valid token. A mobile client needs no cookie jar.",
        },
        authContextHeader: {
          type: "apiKey", in: "header", name: "X-RM-Auth-Context",
          description: "The same token by a different transport. Equivalent; use whichever is easier.",
        },
      },
      schemas: Object.fromEntries(sortedEntries({
        Job: jobSchema(),
        ...declaredSchemas(),
        ...errorSchemas(),
      })),
    },
    "x-auth-model": {
      summary: "Cookie OR token, never cookie PLUS token. A mobile client uses the token alone.",
      flow: [
        "POST /api/auth/login  ->  authContext (session-bound; do NOT persist this one)",
        "GET  /api/auth/mobile-token  ->  token (sessionLess, durable; THIS is the credential)",
        "every request thereafter: Authorization: Bearer <token>",
      ],
      idleSeconds: 7 * 24 * 60 * 60,
      absoluteSeconds: 90 * 24 * 60 * 60,
      renewal:
        "The idle window SLIDES on every authenticated request, clamped to the absolute window " +
        "measured from issue. An app in regular use is never signed out on a timer; an abandoned " +
        "token still dies in seven days; a leaked one cannot be kept alive past the absolute cap.",
      sessionBinding:
        "A login-issued token stores session_sid = req.sessionID, which is meaningless for a " +
        "cookie-less client and is swept by revokeBrowserAuthContexts. The mobile mint stores NULL, " +
        "which that sweep deliberately never touches.",
      crossUser:
        "requireAuth admits a token exactly as it admits a session, and every user-scoped handler " +
        "derives its owner from req.user — which bindAuthContext sets from the token. So AH1's " +
        "cross-user guarantees hold identically on the bearer path. VERIFIED, not assumed, by " +
        "scripts/aj1MobileBearer.mjs against a real server.",
    },
    "x-mobile-tier-gating": {
      summary:
        "automationTier is on every job for this reason: a gated job CANNOT be completed from a " +
        "phone. The gated handoff's security property is the desktop browser holding the portal " +
        "session, borrowed for one gesture under the extension's activeTab. A phone has no " +
        "extension, so a held_gate row queued from mobile is unresolvable. Show it as desktop-only, " +
        "or exclude it — there is no third option that keeps the security property.",
      tiers: Object.fromEntries(sortedEntries(MOBILE_TIER_GATING)),
      filtering:
        "Filter server-side with tiers_include / tiers_exclude on GET /api/jobs. Do NOT filter " +
        "client-side: the server pages before the client filters, so hiding rows after the fact " +
        "yields short pages and a count that disagrees with the list.",
      nullTier:
        "automationTier null means the row predates migration 078 and has not been recomputed. " +
        "Read it exactly as 'unknown' — a promise in neither direction — never as 'direct'.",
    },
    "x-retired": {
      summary:
        "RETIRED. Each answers 410 with a body naming its replacement. A greenfield client written " +
        "from older documentation is precisely the client that will call these.",
      endpoints: RETIRED_ENDPOINTS,
    },
    "x-mobile-gaps": Object.fromEntries(sortedEntries(MOBILE_GAPS)),
    "x-enums": Object.fromEntries(sortedEntries(ENUMS).map(([k, v]) => [k, [...v]])),
  };
}

// ------------------------------------------------------------------------------------------------
// TYPESCRIPT
// ------------------------------------------------------------------------------------------------
export function buildTypeScript() {
  const L = [];
  L.push("/**");
  L.push(" * Resume Master — Mobile API types.");
  L.push(` * Contract version ${CONTRACT_VERSION}.`);
  L.push(" *");
  L.push(" * GENERATED — DO NOT EDIT. Regenerate with `node scripts/generateMobileContract.mjs`.");
  L.push(" *");
  L.push(" * The `Job` interface is derived by EXECUTING services/jobs/mapJobRow.js in the server");
  L.push(" * repository, so it cannot disagree with what the API actually returns. Optional (`?:`)");
  L.push(" * members are ABSENT from the JSON when their column is NULL — not null, absent — because");
  L.push(" * mapJobRow passes them through without coalescing and JSON.stringify drops undefined.");
  L.push(" */");
  L.push("");

  for (const [name, vals] of sortedEntries(ENUMS)) {
    const tn = name[0].toUpperCase() + name.slice(1);
    L.push(`export type ${tn} = ${vals.map(v => JSON.stringify(v)).join(" | ")};`);
  }
  L.push("");

  // Job — required vs optional is the whole point of generating this.
  L.push("/** The job shape. Derived from mapJobRow's field whitelist. */");
  L.push("export interface Job {");
  const required = new Set(JOB_REQUIRED_FIELDS);
  for (const field of [...JOB_FIELDS].sort()) {
    const decl = JOB_FIELD_TYPES[field];
    const spec = decl.enum
      ? `enum:${decl.enum}${decl.nullable ? "|null" : ""}`
      : `${decl.type}${decl.nullable ? "|null" : ""}`;
    if (decl.description) L.push(`  /** ${decl.description} */`);
    L.push(`  ${field}${required.has(field) ? "" : "?"}: ${toTsType(spec)};`);
  }
  L.push("}");
  L.push("");

  for (const [name, def] of sortedEntries(RESPONSE_SCHEMAS)) {
    if (def.binary) {
      L.push(`/** ${def.description || ""} Binary body (${def.binary}); not JSON. */`);
      L.push(`export type ${name} = Blob;`);
      L.push("");
      continue;
    }
    if (def.rootArray) {
      if (def.description) L.push(`/** ${def.description} */`);
      L.push(`export type ${name} = ${toTsType(def.rootArray)}[];`);
      L.push("");
      continue;
    }
    const source = def.sameAs ? RESPONSE_SCHEMAS[def.sameAs] : def;
    if (def.description) L.push(`/** ${def.description} */`);
    L.push(`export interface ${name}${def.extends ? ` extends ${def.extends}` : ""} {`);
    for (const [field, spec] of sortedEntries(source.fields)) {
      const note = source.fieldNotes?.[field] ?? def.fieldNotes?.[field];
      if (note) L.push(`  /** ${note} */`);
      L.push(`  ${/^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field)}: ${toTsType(spec)};`);
    }
    L.push("}");
    L.push("");
  }

  L.push("/** Which automation tiers can be completed on a phone, and why not when they cannot. */");
  L.push("export const MOBILE_TIER_GATING: Record<AutomationTier, { completableOnMobile: boolean; reason: string }> = {");
  for (const [tier, def] of sortedEntries(MOBILE_TIER_GATING)) {
    L.push(`  ${tier}: { completableOnMobile: ${def.completableOnMobile}, reason: ${JSON.stringify(def.reason)} },`);
  }
  L.push("};");
  L.push("");
  L.push("/** Endpoints that answer 410. A client must not call these. */");
  L.push(`export const RETIRED_ENDPOINTS = ${JSON.stringify(
    RETIRED_ENDPOINTS.map(r => `${r.method} ${r.path}`), null, 2)} as const;`);
  L.push("");
  return L.join("\n");
}

/**
 * Newline-normalised before hashing, and that is deliberate rather than incidental.
 *
 * This repository has core.autocrlf=true and no .gitattributes, so a committed .json or .d.ts is
 * checked out with CRLF on Windows and LF elsewhere. Hashing raw bytes would make the drift test
 * fail on a fresh clone for a reason that has nothing to do with the contract — and a test that
 * fails for the wrong reason gets deleted. Hashing normalised content asks the question actually
 * worth asking: has the CONTENT changed?
 */
export function normaliseForHash(text) {
  return String(text).replace(/\r\n/g, "\n");
}

export function renderJson(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}
