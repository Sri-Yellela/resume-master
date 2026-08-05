import test from "node:test";
import assert from "node:assert/strict";
import {
  detectKnownAtsMatch, isLoginWalled, isPrivateOrLoopbackIp, findMatchingPosting,
} from "../services/jobs/importJob.js";

test("detectKnownAtsMatch parses Greenhouse, Lever, Ashby, SmartRecruiters URLs", () => {
  assert.deepEqual(
    detectKnownAtsMatch("https://boards.greenhouse.io/stripe/jobs/12345"),
    { type: "greenhouse", slug: "stripe", externalId: "12345" }
  );
  assert.deepEqual(
    detectKnownAtsMatch("https://jobs.lever.co/acme/abcdef12-3456-7890-abcd-ef1234567890"),
    { type: "lever", slug: "acme", externalId: "abcdef12-3456-7890-abcd-ef1234567890" }
  );
  assert.deepEqual(
    detectKnownAtsMatch("https://jobs.ashbyhq.com/notion/abcdef12-3456-7890-abcd-ef1234567890"),
    { type: "ashby", slug: "notion", externalId: "abcdef12-3456-7890-abcd-ef1234567890" }
  );
  assert.deepEqual(
    detectKnownAtsMatch("https://jobs.smartrecruiters.com/Acme/12345-senior-engineer"),
    { type: "smartrecruiters", slug: "Acme", externalId: "12345" }
  );
});

test("detectKnownAtsMatch handles both Workable URL forms — only one carries the slug", () => {
  assert.deepEqual(
    detectKnownAtsMatch("https://apply.workable.com/acme/j/ABC123DEF/"),
    { type: "workable", slug: "acme", externalId: "ABC123DEF" }
  );
  // jobs.workable.com/view/{shortcode} has no account slug anywhere in the URL — must fall
  // through to the generic path rather than guessing one.
  assert.equal(
    detectKnownAtsMatch("https://jobs.workable.com/view/ABC123DEF/senior-engineer"),
    null
  );
});

test("detectKnownAtsMatch parses Recruitee (subdomain slug) and Workday (tenant/wd# only)", () => {
  assert.deepEqual(
    detectKnownAtsMatch("https://acme.recruitee.com/o/senior-engineer"),
    { type: "recruitee", slug: "acme", externalId: null }
  );
  // Workday deliberately never returns a usable `site` — that's resolved later against
  // company_ats_list, not guessed from the URL.
  assert.deepEqual(
    detectKnownAtsMatch("https://acme.wd5.myworkdayjobs.com/external/job/Remote/Senior-Engineer_R12345"),
    { type: "workday", tenant: "acme", wdNumber: "5", externalId: null }
  );
});

test("detectKnownAtsMatch returns null for unknown hosts and invalid URLs", () => {
  assert.equal(detectKnownAtsMatch("https://careers.somecompany.com/job/123"), null);
  assert.equal(detectKnownAtsMatch("not a url"), null);
});

test("isLoginWalled flags linkedin.com hosts only", () => {
  assert.equal(isLoginWalled("https://www.linkedin.com/jobs/view/1234567"), true);
  assert.equal(isLoginWalled("https://linkedin.com/jobs/view/1234567"), true);
  assert.equal(isLoginWalled("https://boards.greenhouse.io/stripe/jobs/12345"), false);
  assert.equal(isLoginWalled("not a url"), false);
});

test("isPrivateOrLoopbackIp rejects loopback/private/link-local ranges, accepts public IPs", () => {
  assert.equal(isPrivateOrLoopbackIp("127.0.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("10.0.0.5"), true);
  assert.equal(isPrivateOrLoopbackIp("172.16.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("192.168.1.1"), true);
  assert.equal(isPrivateOrLoopbackIp("169.254.1.1"), true);
  assert.equal(isPrivateOrLoopbackIp("::1"), true);
  assert.equal(isPrivateOrLoopbackIp("fe80::1"), true);
  assert.equal(isPrivateOrLoopbackIp("8.8.8.8"), false);
  assert.equal(isPrivateOrLoopbackIp("1.1.1.1"), false);
});

test("findMatchingPosting matches by normalized URL equality first", () => {
  const jobs = [
    { url: "https://boards.greenhouse.io/stripe/jobs/111", req_id: "111" },
    { url: "https://boards.greenhouse.io/stripe/jobs/222", req_id: "222" },
  ];
  const match = findMatchingPosting(jobs, { url: "https://boards.greenhouse.io/stripe/jobs/222/", externalId: null });
  assert.equal(match.req_id, "222");
});

test("findMatchingPosting falls back to req_id when URL doesn't match", () => {
  const jobs = [
    { url: "https://boards.greenhouse.io/stripe/jobs/111", req_id: "111" },
    { url: "https://boards.greenhouse.io/stripe/jobs/222", req_id: "222" },
  ];
  const match = findMatchingPosting(jobs, { url: "https://some-redirector.example.com/x", externalId: "222" });
  assert.equal(match.req_id, "222");
});

test("findMatchingPosting returns null when nothing matches", () => {
  const jobs = [{ url: "https://boards.greenhouse.io/stripe/jobs/111", req_id: "111" }];
  const match = findMatchingPosting(jobs, { url: "https://boards.greenhouse.io/stripe/jobs/999", externalId: "999" });
  assert.equal(match, null);
});
