import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getBaseResumeRecord,
  loadOrCreateSimpleApplyProfile,
  profileHasBaseResume,
  saveBaseResumeRecord,
} from "../services/simpleApplyProfile.js";

test("profile-scoped base resume storage writes and reads by profile_id", () => {
  const store = { profileResume: null };
  const db = {
    prepare(sql) {
      if (sql.includes("INSERT INTO profile_base_resumes")) {
        return {
          run(profileId, userId, content, name) {
            store.profileResume = { profile_id: profileId, user_id: userId, content, name, updated_at: 123 };
          },
        };
      }
      if (sql.includes("FROM profile_base_resumes")) {
        return { get: () => store.profileResume };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  saveBaseResumeRecord(db, { userId: 9, profileId: 42 }, "Profile-specific resume", "firmware.pdf");
  const row = getBaseResumeRecord(db, { userId: 9, profileId: 42, seedLegacy: false });

  assert.equal(row?.content, "Profile-specific resume");
  assert.equal(row?.name, "firmware.pdf");
  assert.equal(profileHasBaseResume(db, { userId: 9, profileId: 42, seedLegacy: false }), true);
});

test("profile A base resume upload does not affect profile B", () => {
  const store = new Map();
  const db = {
    prepare(sql) {
      if (sql.includes("INSERT INTO profile_base_resumes")) {
        return {
          run(profileId, userId, content, name) {
            store.set(`${userId}:${profileId}`, { profile_id: profileId, user_id: userId, content, name, updated_at: 123 });
          },
        };
      }
      if (sql.includes("FROM profile_base_resumes")) {
        return {
          get(profileId, userId) {
            return store.get(`${userId}:${profileId}`) || null;
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  saveBaseResumeRecord(db, { userId: 9, profileId: 42 }, "Firmware resume", "firmware.pdf");
  saveBaseResumeRecord(db, { userId: 9, profileId: 84 }, "Data resume", "data.pdf");

  const profileA = getBaseResumeRecord(db, { userId: 9, profileId: 42, seedLegacy: false });
  const profileB = getBaseResumeRecord(db, { userId: 9, profileId: 84, seedLegacy: false });

  assert.equal(profileA?.content, "Firmware resume");
  assert.equal(profileB?.content, "Data resume");
  assert.notEqual(profileA?.content, profileB?.content);
});

test("legacy resume seeds only the first active scoped profile and refreshes signals there", () => {
  const store = {
    scopedResume: null,
    scopedSignals: null,
    legacyResume: {
      name: "legacy.pdf",
      content: "Senior Data Engineer with 7 years of experience in Python, SQL, Spark, and AWS.",
      updated_at: 88,
    },
    legacySignals: {
      titles_json: JSON.stringify(["data engineer"]),
      keywords_json: JSON.stringify(["python", "spark"]),
      skills_json: JSON.stringify(["python", "sql", "spark"]),
      search_terms_json: JSON.stringify(["data engineer", "spark"]),
      source_hash: "stale",
      years_experience: 7,
      updated_at: 77,
    },
  };
  const db = {
    prepare(sql) {
      if (sql.includes("JOIN domain_profiles dp ON dp.id = pbr.profile_id")) {
        return { get: () => null };
      }
      if (sql.includes("SELECT is_active") && sql.includes("FROM domain_profiles")) {
        return { get: () => ({ is_active: 1 }) };
      }
      if (sql.includes("FROM base_resume")) {
        return { get: () => store.legacyResume };
      }
      if (sql.includes("FROM simple_apply_profiles")) {
        return { get: () => store.legacySignals };
      }
      if (sql.includes("INSERT INTO profile_base_resumes")) {
        return {
          run(profileId, userId, name, content) {
            store.scopedResume = { profile_id: profileId, user_id: userId, name, content, updated_at: 99 };
          },
        };
      }
      if (sql.includes("INSERT INTO profile_simple_apply_profiles")) {
        return {
          run(profileId, userId, titles, keywords, skills, searchTerms, sourceHash, yearsExperience) {
            store.scopedSignals = {
              profile_id: profileId,
              user_id: userId,
              titles_json: titles,
              keywords_json: keywords,
              skills_json: skills,
              search_terms_json: searchTerms,
              source_hash: sourceHash,
              years_experience: yearsExperience,
              updated_at: 111,
            };
          },
        };
      }
      if (sql.includes("FROM profile_base_resumes")) {
        return { get: () => store.scopedResume };
      }
      if (sql.includes("FROM profile_simple_apply_profiles")) {
        return { get: () => store.scopedSignals };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const signals = loadOrCreateSimpleApplyProfile(db, {
    userId: 7,
    profileId: 21,
    roleTitles: ["Data Engineer"],
  });

  assert.equal(store.scopedResume?.content, store.legacyResume.content);
  assert.ok(signals?.skills.includes("python"));
  assert.equal(signals?.yearsExperience, 7);
});

test("profile panel exposes editable profile-scoped resume and extracted signal controls", () => {
  const panel = fs.readFileSync("client/src/panels/ProfilePanel.jsx", "utf8");

  assert.match(panel, /Profile Resume and Signals/);
  assert.match(panel, /\/api\/domain-profiles\/\$\{activeProfileId\}\/base-resume/);
  assert.match(panel, /\/api\/domain-profiles\/\$\{activeProfileId\}\/signals/);
  assert.match(panel, /Upload \/ Replace PDF/);
  assert.match(panel, /Save Extracted Signals/);
});

test("job profile cards expose per-profile resume readiness and upload controls", () => {
  const panel = fs.readFileSync("client/src/panels/JobProfilesPanel.jsx", "utf8");

  assert.match(panel, /profile\.has_base_resume/);
  assert.match(panel, /Required before search, ATS, and enhancement/);
  assert.match(panel, /ATS scoring, new scrapes, and enhancement are blocked for this profile/);
  assert.match(panel, /Extracted metadata ready for this profile only/);
  assert.match(panel, /\/api\/domain-profiles\/\$\{profile\.id\}\/base-resume/);
});
