// A68 (owner, 10-03): the old site's night sky, STATIC. The old one was a looping video hotlinked
// from a third-party host; this is a star field generated here, deterministically (a seeded PRNG,
// so the file only changes when this script does), and served from public/ like everything else.
//
//   node scripts/site/sky.mjs           write public/sky.svg
//   (buildSite.mjs --check verifies it is current)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "sky.svg");

export function renderSky({ seed = 20260303, width = 1600, height = 1000, stars = 260 } = {}) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dots = [];
  for (let i = 0; i < stars; i++) {
    const x = (rnd() * width).toFixed(1);
    // Denser toward the top of the sky, thinning toward the horizon.
    const y = (Math.pow(rnd(), 1.35) * height).toFixed(1);
    const big = rnd() < 0.06;
    const r = big ? (1.1 + rnd() * 0.9).toFixed(2) : (0.35 + rnd() * 0.65).toFixed(2);
    const o = (big ? 0.75 + rnd() * 0.25 : 0.25 + rnd() * 0.55).toFixed(2);
    const warm = rnd() < 0.18;
    dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${warm ? "#fff3d6" : "#ffffff"}" fill-opacity="${o}"${big ? ' filter="url(#g)"' : ""}/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice">` +
    `<defs><filter id="g" x="-3" y="-3" width="7" height="7"><feGaussianBlur stdDeviation="1.4"/>` +
    `<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
    dots.join("") + `</svg>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, renderSky());
  console.log("wrote public/sky.svg");
}
