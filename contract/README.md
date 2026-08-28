# The Mobile API Contract

**Generated. Do not hand-edit any file in this directory.**

```bash
node scripts/generateMobileContract.mjs           # regenerate after changing the API
node scripts/generateMobileContract.mjs --check   # CI: fail if these files are stale
```

| File | What it is |
|---|---|
| `mobile-api.v1.json` | OpenAPI 3.1. The contract itself. Feed it to `openapi-generator` for Swift or Kotlin models. |
| `mobile-api.v1.d.ts` | TypeScript declarations, for a TS mobile client or a shared JS layer. |
| `CHECKSUMS.json` | SHA-256 of each file, over **LF-normalised** content. What the mobile repos pin against. |

---

## Why this exists

The API is now a contract across a **repository boundary**. Four consumers: `client/`,
`extension/`, and two mobile repositories that are not in this tree.

This repository's defect history is almost entirely contract mismatches that failed **silently** —
`mapJobRow` vs `normalizeApiJob`, the popup and the hotkey writing to different tables, three
hardcoded tab lists, half-migrated model IDs, `tool` vs `toolType`, mode `"manual"` coerced to
`"auto"`. Every one was two sides of a contract that did not meet, with nothing failing loudly.
Being in the same tree is what eventually made each of them findable.

A separate repository removes that. So the loud failure is built:
**`test/mobileApiContract.test.js` fails on `npm test` the moment this directory goes stale.**

## What is *derived* and what is *declared*

The `Job` schema is derived by **executing** `services/jobs/mapJobRow.js`, not by reading it.
`mapJobRow` is a field whitelist — the only shape `GET /api/jobs`, `GET /api/jobs/by-id` and
`POST /api/import/job` can emit — so its key set *is* the binding constraint on everything reaching
a client. Probing the function agrees with its **behaviour**; a regex would only agree with its
**text**.

Scalar types cannot be recovered by probing, so those are declared in
`services/api/mobileContract.js` and reconciled against the derived key set **in both directions**:
a field with no declared type fails, and a declared type with no field fails. Same pattern as
`test/privacyReconciliation.test.js`. Enum vocabularies are imported from
`shared/jobFilterOptions.js` and `shared/applyOutcomeGroups.js` — a copy here would be the exact bug
this contract exists to prevent.

---

## How the mobile repos consume this

### Recommendation: **copy the files in, and assert the checksum.**

Copy `mobile-api.v1.json`, `mobile-api.v1.d.ts` and `CHECKSUMS.json` into the mobile repo (e.g.
`Contract/`), and add one test that recomputes the hashes. That is it.

**Why this beats the alternatives here** — the reasoning is about *these* repos, not a general
preference:

- **A git submodule** would point at *this* repository, which is the whole server: large, private,
  and carrying deploy configuration a mobile CI job has no business cloning. Making it work means
  first splitting the contract into its own repository — real, ongoing infrastructure, in exchange
  for a version pin that a checksum already gives.
- **An npm package** only serves a JavaScript consumer. Per `docs/MOBILE_STATE.md` §8 the platform
  choice is unmade, and the cheapest option (Capacitor-wrapping the Vite build) is close to ruled
  out because the web client is a desktop-shaped tiled dock and is not responsive. So the likely
  outcome is **native Swift and Kotlin**, and neither consumes npm. Publishing a package that one
  of the two clients can use, and paying registry and release overhead for it, is worse than
  copying a file.
- **Copy plus checksum** is language-agnostic: a Swift or Kotlin test can SHA-256 a file in three
  lines, and `mobile-api.v1.json` drives `openapi-generator` for both platforms. No network at
  build time, no auth to a private registry, and the pin is explicit and reviewable in a diff.

Revisit this if a third consumer appears or if the mobile side turns out to be TypeScript. Until
then the friction of the other two options buys nothing.

### The checksum test to add on the mobile side

Normalise line endings before hashing. This repository has `core.autocrlf=true` and no
`.gitattributes`, so a checkout can legitimately carry CRLF — hashing raw bytes would fail on
content that is byte-for-byte correct, and a test that fails for the wrong reason gets deleted.

```swift
// Swift — XCTest
func testContractIsCurrent() throws {
    let sums = try JSONDecoder().decode(Checksums.self,
        from: Data(contentsOf: contractURL("CHECKSUMS.json")))
    for (name, expected) in sums.files {
        let raw = try String(contentsOf: contractURL(name), encoding: .utf8)
        let normalised = raw.replacingOccurrences(of: "\r\n", with: "\n")
        XCTAssertEqual(sha256Hex(Data(normalised.utf8)), expected,
            "\(name) does not match its recorded checksum — re-copy it from the server repo")
    }
}
```

```kotlin
// Kotlin — JUnit
@Test fun `contract is current`() {
    val sums = Json.decodeFromString<Checksums>(contractFile("CHECKSUMS.json").readText())
    sums.files.forEach { (name, expected) ->
        val normalised = contractFile(name).readText().replace("\r\n", "\n")
        val actual = MessageDigest.getInstance("SHA-256")
            .digest(normalised.toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(expected, actual, "$name is stale — re-copy it from the server repo")
    }
}
```

That test answers "is my copy current?" It does **not** answer "has the server changed since I
copied?" — nothing inside the mobile repo can. The server side owns that half, and it is
`test/mobileApiContract.test.js` here.

---

## Versioning

`CONTRACT_VERSION` lives in `services/api/mobileContract.js`.

| Change | Version | Why |
|---|---|---|
| A field added to `mapJobRow` | **minor** | Additive. An existing decoder ignores it. |
| A field's type or nullability changed | **major** | A decoder that assumed the old type throws. |
| A field removed from `mapJobRow` | **major** | The contract test fails first, deliberately — see below. |
| An endpoint added | **minor** | |
| An endpoint removed or its path changed | **major** | Retire it with a 410 and add it to `RETIRED_ENDPOINTS`. |
| An enum gaining a value | **major** for a closed decoder | Swift/Kotlin enums throw on an unknown case. Decode with an `unknown` fallback and this becomes minor. |

**Removing a field is deliberately awkward.** `npm test` fails naming the field, in this
repository, before the change is pushed — rather than in a store review of an app whose decoder no
longer matches. To remove one on purpose: delete it from `mapJobRow`, delete its entry from
`JOB_FIELD_TYPES`, bump the major version, regenerate, and tell both mobile repos.

## What is *not* in here, on purpose

Publishing an endpoint makes it a promise. Only the 32 endpoints a swipe feed and a review flow
need are published; the server has roughly 190. Absent and therefore **not** promised: every
`/api/admin/*` route, the gated-handoff endpoints (unresolvable without the extension), form-schema
capture, resume editing, the anonymous `standalone/*` surface, and the SSE stream at
`/api/sync/events` (it works, but a backgrounded app cannot hold the socket — see
`x-mobile-gaps.pushNotifications`).

Read `x-retired` before writing a single request: a greenfield client built from older
documentation is exactly the client that will call a retired endpoint.

**Page the feed with `?cursor=`, not `?page=`.** A swipe feed mutates the set it is paging through —
a dislike removes a row from the default board — so offset paging silently skips jobs: measured at
6 of 25 with three swipes per page. Omit `cursor` for the first page, then follow `nextCursor` until
it is null. A cursor is bound to the ordering it was issued under; change `sort` or switch domain
profile and it answers 400 `cursor_sort_mismatch` rather than returning an arbitrary slice.
`page`/`pageSize` still work unchanged for a paged list view. See `x-mobile-gaps` for what is still
open — pagination is marked `RESOLVED` there, and the four remaining entries are not.
