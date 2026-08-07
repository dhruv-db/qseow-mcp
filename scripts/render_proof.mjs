#!/usr/bin/env node
// RENDER PROOF — the last mile no engine-side check can cover.
//
// Engine validation proves a definition resolves and computes. It cannot
// prove the client DRAWS it: modern Sense charts are nebula.js supernovas
// rendered in the browser, and a perfectly healthy hypercube can still paint
// nothing. This script drives a real headless browser against a live site and
// reports, per object, whether it actually rendered.
//
// Requires playwright, installed separately so consumers of this package
// don't inherit a browser download:
//   npm i -D playwright && npx playwright install chromium
//
// THE VERDICTS BELOW ARE ADVISORY. Set SHOTS=<dir> and LOOK at the images —
// that is the authority. Qlik draws some error states as SVG text inside a
// shadow root that neither DOM scraping nor Playwright text locators could
// reliably match here; treemap rendered "This chart cannot be displayed."
// while every automated probe reported it as rendering. An automated pixel
// check narrows what a human (or a vision-capable agent) must look at; it
// does not replace looking.
//
// Usage: SHOTS=./shots node scripts/render_proof.mjs <inventory.json>
//   inventory.json: {"appId": "...", "objects": [{"id","viz","title"}, ...]}
//   env: QSEOW_HOST/QSEOW_PROXY_PORT/QSEOW_VP_PREFIX + JWT_PATH (a signed JWT
//        for the virtual proxy). See README "Render verification".
//
// Two lessons are baked into the detection below, both learned the hard way:
//   1. Objects are rendered at SHEET-TILE size, not full viewport. A treemap
//      that paints at 900x620 can refuse in a 640x150 tile. Test both.
//   2. Counting painted SVG nodes is NOT proof: a broken chart still paints
//      its legend. Qlik's error state must be detected explicitly, or the
//      proof reports false PASSes — which is exactly what happened here.
//   3. Error text lives in SVG nodes inside a SHADOW ROOT — neither innerText
//      nor textContent on document.body can see it. Playwright locators
//      pierce open shadow roots; DOM scraping does not. Two false PASSes on
//      treemap came from exactly this.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const inv = JSON.parse(readFileSync(process.argv[2], "utf8"));
const jwt = readFileSync(process.env.JWT_PATH, "utf8").trim();
const base = "https://localhost:18443/jwt";
const res = await fetch(`${base}/qps/csrftoken`, { headers: { Authorization: `Bearer ${jwt}` } });
const m = /(X-Qlik-Session[^=]*)=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
const SIZES = [
  { name: "8x4-tile", w: 640, h: 300 },
  { name: "small", w: 340, h: 180 },
];
const browser = await chromium.launch();
for (const size of SIZES) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: size.w, height: size.h } });
  await ctx.addCookies([{ name: m[1], value: m[2], domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "None" }]);
  console.log(`\n--- ${size.name} (${size.w}x${size.h}) ---`);
  for (const o of inv.objects) {
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/single/?appid=${encodeURIComponent(inv.appId)}&obj=${o.id}&opt=nointeraction`, { waitUntil: "networkidle", timeout: 40000 });
      await page.waitForTimeout(3000);
      const r = await page.evaluate(() => ({
        painted: document.querySelectorAll("svg rect, svg path, svg circle, canvas, td, .qv-st-value").length,
        // innerText SKIPS SVG text nodes — and Qlik draws "This chart cannot
        // be displayed." as SVG text. Reading only innerText is precisely how
        // this proof reported treemap as rendering while it showed an error.
        txt: ((document.body.innerText || "") + " " + (document.body.textContent || "")).replace(/\s+/g, " "),
        // Qlik paints its error state into a container whose class carries
        // "error" — the legend of a BROKEN chart still renders, so node
        // counting alone reports a false PASS. Check the error state first.
        errorEl: document.querySelectorAll('[class*="error" i]:not([class*="no-error" i])').length,
      }));
      // Playwright locators pierce open shadow roots; this is the only
      // reliable read of Qlik's error state.
      const ERRORS = /cannot be displayed|Invalid visualization|Incomplete visualization|not found on the server/i;
      // getByText takes a RegExp and pierces open shadow roots. A `text=`
      // selector built from regex SOURCE is matched literally and never hits.
      const errCount = await page.getByText(ERRORS).count().catch(() => 0);
      const broken = errCount > 0 ? "Qlik error state" : (r.errorEl > 0 ? "error element present" : null);
      const hasData = /\d/.test(r.txt.replace(/Loading completed|[^\w\s.%]/g, ""));
      const verdict = broken ? `BROKEN(${broken})` : (r.painted > 0 || hasData) ? "renders" : "no-paint(check visually)";
      console.log(`${o.viz.padEnd(13)} ${verdict.padEnd(28)} painted=${String(r.painted).padEnd(4)} ${r.txt.slice(0, 60)}`);
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${size.name}-${o.viz}.png` });
    } catch (e) { console.log(`${o.viz.padEnd(13)} LOAD-FAIL`); }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
