// The build must not kill processes it does not own.
//
// `npm run build` used to begin with `taskkill /F /IM node.exe /T` — an IMAGE-wide kill, which on
// Windows means every node process on the machine: the developer's IDE language server (WebStorm's
// tailwind server is a node process), any agent, any unrelated project's dev server. Running the
// build cost you your editor's tooling, so the build stopped being run, so client/dist went stale
// and :3001 served a bundle three hours behind the source while Vite dev served current code. Every
// verification done against :3001 in that window was testing code that was not there.
//
// What the kill was actually working around is narrower than what it did: `npm --prefix client ci`
// deletes client/node_modules, and Windows refuses to unlink a loaded native addon, so the install
// fails with EPERM while the Vite dev server holds lightningcss.win32-x64-msvc.node open. That is
// one process, identified by the port it is listening on.
//
// These tests pin the distinction: a kill scoped to a port this project binds is fine, a kill
// scoped to an executable NAME is not.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const rootPkg = JSON.parse(read("package.json"));
const clientPkg = JSON.parse(read("client/package.json"));
const freePort = read("scripts/freePort.mjs");

const allScripts = [
  ...Object.entries(rootPkg.scripts || {}).map(([name, body]) => [`package.json:${name}`, body]),
  ...Object.entries(clientPkg.scripts || {}).map(([name, body]) => [`client/package.json:${name}`, body]),
];

// Each of these selects processes by WHAT THEY ARE rather than by what this project started.
const BLANKET_KILLS = [
  [/taskkill[^\n]*\/IM/i, "taskkill /IM — kills every process with that executable name"],
  [/\bkillall\b/, "killall — kills every process with that name"],
  [/\bpkill\b/, "pkill — pattern-kills across the whole machine"],
  [/wmic[^\n]*process[^\n]*delete/i, "wmic process delete"],
  [/Stop-Process[^\n]*-Name/i, "Stop-Process -Name — selects by image name, not by pid"],
];

test("no npm script kills processes by executable name", () => {
  for (const [where, body] of allScripts) {
    for (const [pattern, why] of BLANKET_KILLS) {
      assert.ok(
        !pattern.test(body),
        `${where} contains a blanket kill (${why}):\n  ${body}`,
      );
    }
  }
});

test("prebuild frees ports through the scoped helper, and the helper exists", () => {
  assert.match(rootPkg.scripts.prebuild, /node scripts\/freePort\.mjs/);
  assert.ok(fs.existsSync("scripts/freePort.mjs"));
});

test("freePort selects only LISTENING sockets, so it cannot kill the far end of a connection", () => {
  // A browser connected TO :3001 also has :3001 in its netstat row. Killing by port without the
  // listen-state filter would take the browser with it.
  assert.match(freePort, /-State Listen/);
  assert.match(freePort, /LISTENING/);          // the netstat fallback, for hosts without NetTCPIP
  assert.match(freePort, /-sTCP:LISTEN/);       // the POSIX path
});

test("freePort refuses to kill itself or the shell that invoked it", () => {
  assert.match(freePort, /PROTECTED/);
  assert.match(freePort, /String\(process\.pid\)/);
  assert.match(freePort, /String\(process\.ppid\)/);
  assert.match(freePort, /PROTECTED\.has\(pid\)/);
});

test("freePort defaults to the two ports this project binds, and nothing else", () => {
  // 3001 is the server that serves client/dist; 5173 is the Vite dev server that holds
  // client/node_modules open against `npm ci`. Both are started by this repo.
  const defaults = /process\.env\.PORT \|\| '3001', process\.env\.CLIENT_PORT \|\| '5173'/;
  assert.match(freePort, defaults);
});
