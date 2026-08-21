#!/usr/bin/env node
/**
 * freePort.mjs — release the TCP ports this project binds, and nothing else.
 *
 * Replaces the previous `taskkill /F /IM node.exe /T` prebuild step, which killed
 * *every* node process on the machine: the developer's IDE language server, any
 * running agent, unrelated projects. This targets only the PID that is LISTENING
 * on a port we asked about, and refuses to kill itself or its own parent.
 *
 * Usage:  node scripts/freePort.mjs [port ...]      (default: 3001 and 5173)
 */
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

/**
 * Default targets are the two ports this project binds:
 *   3001 — `node server.js`, which serves client/dist and would otherwise keep serving a stale bundle.
 *   5173 — `vite --port 5173`, which holds client/node_modules open. `npm ci` deletes that tree, and
 *          Windows refuses to unlink a loaded native addon (lightningcss.win32-x64-msvc.node), so the
 *          install fails with EPERM while the dev server is up. This is what the old blanket
 *          `taskkill /IM node.exe` was really working around.
 */
const ports = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [process.env.PORT || '3001', process.env.CLIENT_PORT || '5173'];

/** PIDs we must never signal: ourselves, our parent (the npm/shell that ran us), and the system idle/system PIDs. */
const PROTECTED = new Set(['0', '4', String(process.pid), String(process.ppid)]);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return r.status === 0 && r.stdout ? r.stdout : '';
}

/** PIDs listening on `port`. Listeners only — never the far end of an established connection. */
function listenersOn(port) {
  const pids = new Set();

  if (isWin) {
    // Preferred: the State enum is not localised, unlike netstat's "LISTENING".
    const ps = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -ExpandProperty OwningProcess',
    ]);
    for (const line of ps.split(/\r?\n/)) {
      const pid = line.trim();
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
    if (pids.size) return pids;

    // Fallback for hosts without the NetTCPIP module.
    const out = run('netstat.exe', ['-ano', '-p', 'tcp']);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && m[2] === String(port)) pids.add(m[3]);
    }
    return pids;
  }

  const out = run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  for (const line of out.split(/\r?\n/)) {
    const pid = line.trim();
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  return pids;
}

function describe(pid) {
  if (!isWin) return `pid ${pid}`;
  const out = run('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
  const name = out.split(',')[0]?.replace(/"/g, '').trim();
  return name && name !== 'INFO:' ? `${name} (pid ${pid})` : `pid ${pid}`;
}

function kill(pid) {
  if (isWin) return spawnSync('taskkill.exe', ['/F', '/PID', pid, '/T'], { stdio: 'ignore' }).status === 0;
  try { process.kill(Number(pid), 'SIGKILL'); return true; } catch { return false; }
}

let freed = 0;
for (const port of ports) {
  for (const pid of listenersOn(port)) {
    if (PROTECTED.has(pid)) {
      console.log(`[freePort] :${port} is held by ${describe(pid)} — protected, leaving it alone`);
      continue;
    }
    const label = describe(pid);
    if (kill(pid)) {
      console.log(`[freePort] :${port} released — stopped ${label}`);
      freed++;
    } else {
      console.warn(`[freePort] :${port} held by ${label} — could not stop it (permissions?)`);
    }
  }
}

if (!freed) console.log(`[freePort] nothing listening on ${ports.map((p) => `:${p}`).join(' ')}`);
