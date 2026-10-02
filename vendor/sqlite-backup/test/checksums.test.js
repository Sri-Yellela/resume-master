// A vendored copy that was hand-edited, or an edit here not followed by `npm run checksums`, fails.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyManifest } from "../scripts/checksums.mjs";

test("every file matches CHECKSUMS.json (LF-normalised)", () => {
  assert.deepEqual(verifyManifest(), []);
});
