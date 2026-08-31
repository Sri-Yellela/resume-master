import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { at } from "../test-support/sourceAnchors.js";

test("public routes render public pages without eager jobs-board restore", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");

  for (const route of ["/features", "/pricing", "/about", "/contact", "/faq", "/privacy", "/terms"]) {
    assert.match(app, new RegExp(`<Route path="${route}"\\s+element=\\{<`));
  }

  const publicRoutesBlock = app.slice(at(app, "{/* Standalone tool pages"), at(app, "{/* Admin login"));
  assert.doesNotMatch(publicRoutesBlock, /Navigate to="\/app"|Navigate to=\{consolePath\}|navigate\(consolePath/);
});

test("admin route guards never fall through to the regular user app", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const adminBlock = app.slice(at(app, '<Route path="/admin/login"'), at(app, "{/* User login"));

  // The admin routes no longer inline an authUser?.isAdmin check — guarding moved into the
  // <AdminRouteGate> component. Assert the routes are wrapped AND that the gate itself enforces
  // isAdmin, which is a stronger guarantee than string-matching the check inside the route block:
  // wrapping without enforcement, or enforcement without wrapping, both now fail.
  assert.match(adminBlock, /<AdminRouteGate authStatus=\{authStatus\} authUser=\{authUser\}>/);
  assert.match(app, /function AdminRouteGate[\s\S]{0,400}?!authUser\.isAdmin/);
  // These redirects also moved out of the route block and into the gate components, for the same
  // refactor. Assert them where they now live, so the guarantee is still pinned:
  //   AdminRouteGate    — unauthenticated or non-admin  -> /admin/login
  //   PublicLoginRoute  — an already-signed-in admin    -> /admin (never falls through to /app)
  assert.match(app, /function AdminRouteGate[\s\S]{0,400}?<Navigate to="\/admin\/login" replace\/>/);
  assert.match(app, /function PublicLoginRoute[\s\S]{0,400}?authUser\.isAdmin \? <Navigate to="\/admin" replace\/>/);
  assert.doesNotMatch(adminBlock, /Navigate to="\/app"/);
});

test("user app guard remains role-aware and sends admins to admin, not jobs", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  // The end anchor read "{/* Root and catch-all". That comment has since been split in two — the
  // root route now says "{/* Root: landing page for logged-out..." and the 404 has its own comment
  // below it — so indexOf returned -1 and this block ran to the end of App.jsx: 1066 characters
  // instead of 223, covering the root route and the catch-all it was written to exclude.
  const userAppBlock = app.slice(at(app, '<Route path="/app/*"'),
                                 at(app, "{/* Root: landing page for logged-out"));

  assert.match(app, /const \[authStatus,\s+setAuthStatus\]\s+=\s+useState\("unknown"\)/);
  assert.match(app, /if \(authStatus === "unknown"\) return \(/);
  assert.match(userAppBlock, /<UserRouteGate authStatus=\{authStatus\} authUser=\{authUser\}>/);
  assert.match(app, /function UserRouteGate\(\{ authStatus, authUser, children \}\)/);
  assert.match(app, /if \(authStatus === "unknown"\) return null/);
  assert.match(app, /if \(authStatus !== "authenticated" \|\| !authUser\) return <Navigate to="\/login" replace\/>/);
  assert.match(userAppBlock, /<AppDashboard authUser=\{authUser\}/);
});

test("login and admin routes wait for auth bootstrap instead of redirecting from stale user state", () => {
  const app = fs.readFileSync("client/src/App.jsx", "utf8");
  const adminBlock = app.slice(at(app, '<Route path="/admin/login"'), at(app, "{/* Admin dashboard"));
  const loginBlock = app.slice(at(app, '<Route path="/login"'), at(app, "{/* User app"));

  assert.match(app, /function PublicLoginRoute\(\{ authStatus, authUser, children, admin = false \}\)/);
  assert.match(app, /if \(authStatus === "unknown"\) return null/);
  assert.match(adminBlock, /<PublicLoginRoute authStatus=\{authStatus\} authUser=\{authUser\} admin>/);
  assert.match(loginBlock, /<PublicLoginRoute authStatus=\{authStatus\} authUser=\{authUser\}>/);
});
