// The contract's type vocabulary, inference and validation — one module so the generator, the
// harness and the live verifier cannot disagree about what a schema means.
//
// A schema here is a JSON Schema subset, so it drops into OpenAPI 3.1 unchanged:
//   { type: "string" | ["number","null"] | …, properties, required, items, enum, anyOf, $ref }

// ── the declaring vocabulary ────────────────────────────────────────────────────────────────────
export const str = { type: "string" };
export const num = { type: "number" };
export const bool = { type: "boolean" };
export const arr = (items) => ({ type: "array", items });
export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
export const enumOf = (...values) => ({ type: "string", enum: values });
// An enum must carry null in its ENUM too, or JSON Schema rejects null despite the type saying yes
// (and the TypeScript silently drops `| null`) — caught on this contract's first generation.
export const nullable = (s) => s.$ref ? { anyOf: [s, { type: "null" }] }
  : { ...s, type: [...new Set([].concat(s.type, "null"))], ...(s.enum ? { enum: [...s.enum, null] } : {}) };
/** @param optional keys that are legitimately conditional — the harness never demands them */
export const obj = (properties, { optional = [], description } = {}) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties).filter(k => !optional.includes(k)),
});

// ── inference, for the DERIVED shapes ───────────────────────────────────────────────────────────
//
// Samples are JSON round-tripped first, so a field that is `undefined` in the source — and would
// therefore be DELETED by JSON.stringify and arrive absent, not null — shows up here as absent and
// is declared optional. That is the defect the mobile contract's generator caught eight of.
const jsonType = (v) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

export function infer(samples) {
  const values = samples.map(v => JSON.parse(JSON.stringify(v))).filter(v => v !== undefined);
  const types = [...new Set(values.map(jsonType))].sort();
  const out = { type: types.length === 1 ? types[0] : types };
  if (types.includes("object")) {
    const objs = values.filter(v => jsonType(v) === "object");
    const keys = [...new Set(objs.flatMap(o => Object.keys(o)))];
    out.properties = Object.fromEntries(keys.map(k => [k, infer(objs.filter(o => k in o).map(o => o[k]))]));
    out.required = keys.filter(k => objs.every(o => k in o));
  }
  if (types.includes("array")) {
    const items = values.filter(Array.isArray).flat();
    // An array never observed non-empty has an unknown item type: say so, rather than guess.
    out.items = items.length ? infer(items) : {};
  }
  return out;
}

// ── validation: REAL -> DECLARED, one direction on purpose ──────────────────────────────────────
//
// Every key a real response carries must be declared, and its value must match the declared type.
// The reverse — every declared key must be present — is NOT asserted: several fields are
// legitimately conditional, and a check that fails on correct bodies gets deleted. An UNDECLARED
// key is the direction that can be asserted without false positives, and it is the direction all
// eleven defects in the mobile contract's first draft were in.
export function conforms(value, schema, components, path = "$") {
  if (!schema || Object.keys(schema).length === 0) return [];              // declared "anything"
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    if (!components[name]) return [`${path}: $ref to undeclared schema ${name}`];
    return conforms(value, components[name], components, path);
  }
  if (schema.anyOf) {
    const results = schema.anyOf.map(s => conforms(value, s, components, path));
    return results.some(r => r.length === 0) ? [] : [`${path}: matches no branch — ${results.map(r => r[0]).join(" / ")}`];
  }
  const t = jsonType(value);
  const allowed = [].concat(schema.type ?? []);
  const ok = allowed.includes(t) || (t === "number" && allowed.includes("integer"));
  if (allowed.length && !ok) return [`${path}: is ${t}, declared ${allowed.join("|")}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: "${value}" is not one of ${schema.enum.join(", ")}`];
  const problems = [];
  if (t === "object" && schema.properties) {
    for (const [k, v] of Object.entries(value)) {
      if (!(k in schema.properties)) problems.push(`${path}.${k}: UNDECLARED key`);
      else problems.push(...conforms(v, schema.properties[k], components, `${path}.${k}`));
    }
  }
  if (t === "array" && schema.items) value.forEach((v, i) => problems.push(...conforms(v, schema.items, components, `${path}[${i}]`)));
  return problems;
}
