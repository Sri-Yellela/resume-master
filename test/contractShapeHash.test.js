// The shape hash ignores PROSE and never a FIELD NAME (contract 1.5.0).
//
// Until 1.5.0 shapeHash stripped every key called `description` / `summary` / `info` / `servers` at
// every depth, so Job.description — the posting itself, a real field — was invisible to the hash:
// deleting it, renaming it or changing its type was not a "shape change", and the generator would
// have shipped a different shape under a version a consumer already held. These tests are red on
// that code.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenApi, shapeHash } from "../src/contract/build.js";

const fresh = async () => structuredClone(await buildOpenApi());

test("⛔ removing a PROPERTY named `description` changes the shape hash", async () => {
  const doc = await fresh();
  const before = shapeHash(doc);
  assert.ok(doc.components.schemas.Job.properties.description, "fixture: Job declares a description field");
  delete doc.components.schemas.Job.properties.description;
  assert.notEqual(shapeHash(doc), before, "Job.description fell out of the hash with the prose");
});

test("⛔ renaming or retyping a property named `description` changes the shape hash", async () => {
  const doc = await fresh();
  const before = shapeHash(doc);
  const job = doc.components.schemas.Job;
  job.properties.posting = job.properties.description;
  delete job.properties.description;
  assert.notEqual(shapeHash(doc), before, "a rename must be a shape change");

  const retyped = await fresh();
  retyped.components.schemas.Job.properties.description = { type: "number" };
  assert.notEqual(shapeHash(retyped), before, "a retype must be a shape change");
});

test("properties named `summary`, `info` or `servers` are shape too, at any depth", async () => {
  for (const name of ["summary", "info", "servers"]) {
    const doc = await fresh();
    const before = shapeHash(doc);
    doc.components.schemas.Job.properties[name] = { type: "string" };
    assert.notEqual(shapeHash(doc), before, `a field named ${name} must enter the hash`);
  }
});

test("editing a description ANNOTATION — schema, operation, response or MCP tool prose — does not", async () => {
  const doc = await fresh();
  const before = shapeHash(doc);
  doc.components.schemas.Error.description = "reworded";
  doc.components.schemas.Job.properties.title.description = "a new annotation on a field";
  const op = doc.paths["/v1/resumes/generate"].post;
  op.summary = "reworded summary";
  op.responses["200"].description = "reworded";
  doc["x-mcp"].description = "reworded";
  doc["x-mcp"].tools[0].description = "reworded";
  doc.info.description = "reworded";
  doc.info.title = "renamed";
  doc.servers = [{ url: "https://example.test" }];
  assert.equal(shapeHash(doc), before, "rewording prose is not a version");
});
