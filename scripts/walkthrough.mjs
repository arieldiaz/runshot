#!/usr/bin/env node
// walkthrough.mjs — config-driven mobile onboarding recorder.
//
// One flow definition, two outputs:
//   --mode record  (default) → produce video + screenshots + emails, never throw
//   --mode assert            → same run, but exit(1) on any failure (CI gate)
//
// Usage:
//   node walkthrough.mjs --config ./runshot/skills.config.json --mode record
//
// Deps:  npm install playwright   &&   npx playwright install chromium

import { chromium, devices } from "playwright";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { VERSION } from "./version.mjs";

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]?.startsWith("--") ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const configPath = resolve(args.config || "./runshot/skills.config.json");
const mode = args.mode === "assert" ? "assert" : "record";

// ---------- helpers ----------
const failures = [];
const fail = (msg) => { failures.push(msg); console.error("  ✗ " + msg); };
const ok = (msg) => console.log("  ✓ " + msg);
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const pad = (n) => String(n).padStart(2, "0");

// Best-effort context about what was under test, recorded into summary.json so
// the gallery can show it. All optional — silently skipped outside a git repo /
// without a package.json.
function gitVal(cmd) {
  try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { return null; }
}
async function runContext() {
  let appVersion = null;
  try { appVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version || null; } catch { /* none */ }
  return {
    ranAt: startedAt.toISOString(),
    qaVersion: VERSION, // runshot version that captured this run
    appVersion,
    gitCommit: gitVal("git rev-parse --short HEAD"),
    gitBranch: gitVal("git rev-parse --abbrev-ref HEAD"),
  };
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (e) {
    console.error(`Could not read config at ${configPath}: ${e.message}`);
    process.exit(2);
  }
}

// Substitute {{run}} and {{timestamp}} tokens so each run gets a fresh identity.
function interpolate(value, vars) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ---------- email capture (Inbucket + Mailpit) ----------
// Auto-detect the mail catcher: Mailpit (current Supabase CLI) exposes
// /api/v1/messages; classic Inbucket only has /api/v1/mailbox/{name}. The
// `mailbox` config value is the local part (e.g. "you+run-..."); we match it as
// a substring of the recipient address so it works regardless of domain.
async function detectFlavor(base) {
  try {
    const r = await fetch(`${base}/api/v1/messages?limit=1`);
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j && Array.isArray(j.messages)) return "mailpit";
    }
  } catch { /* fall through */ }
  return "inbucket";
}

async function captureEmails(cfg, vars, outDir, browser, deviceName, viewport) {
  if (!cfg.expectedEmails?.length) return { expected: 0, found: 0 };
  const base = (cfg.inbucketUrl || "http://127.0.0.1:54324").replace(/\/$/, "");
  const flavor = await detectFlavor(base);
  let found = 0;
  const emailsDir = deviceName ? join(outDir, "emails", deviceName) : join(outDir, "emails");
  await mkdir(emailsDir, { recursive: true });
  // Render the email at the device's own WIDTH but a tiny height, so the fullPage
  // screenshot crops to the email's actual content instead of the whole viewport
  // (a short email otherwise sits at the top of a tall white page).
  const page = await browser.newPage(viewport ? { viewport: { width: viewport.width, height: 80 } } : undefined);

  for (const want of cfg.expectedEmails) {
    const mailbox = interpolate(want.mailbox, vars);
    const deadline = Date.now() + (want.timeoutMs || 20000);
    let hit = null; // { html, text, subject }
    while (Date.now() < deadline && !hit) {
      try {
        if (flavor === "mailpit") {
          const list = await fetch(`${base}/api/v1/messages?limit=200`).then((r) => r.json());
          const needle = mailbox.toLowerCase(); // email addrs are case-insensitive; Mailpit lowercases them
          const m = (list.messages || []).find(
            (m) =>
              (m.To || []).some((t) => (t.Address || "").toLowerCase().includes(needle)) &&
              (!want.subjectMatch || (m.Subject || "").includes(want.subjectMatch))
          );
          if (m) {
            const full = await fetch(`${base}/api/v1/message/${m.ID}`).then((r) => r.json());
            hit = { html: full.HTML, text: full.Text, subject: m.Subject };
          }
        } else {
          const list = await fetch(`${base}/api/v1/mailbox/${encodeURIComponent(mailbox)}`).then((r) => r.json());
          const m = (list || []).find((m) => !want.subjectMatch || (m.subject || "").includes(want.subjectMatch));
          if (m) {
            const full = await fetch(`${base}/api/v1/mailbox/${encodeURIComponent(mailbox)}/${m.id}`).then((r) => r.json());
            hit = { html: full.body?.html, text: full.body?.text, subject: m.subject };
          }
        }
      } catch { /* mail catcher not up yet */ }
      if (!hit) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!hit) { fail(`expected email not found: ${mailbox} / "${want.subjectMatch || "(any)"}"`); continue; }

    // render the message body for a screenshot
    const html = hit.html || `<pre>${(hit.text || "").replace(/</g, "&lt;")}</pre>`;
    const slug = `${mailbox.replace(/[^\w.-]+/g, "_")}-${found}`;
    await writeFile(join(emailsDir, `${slug}.html`), html, "utf8");
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(emailsDir, `${slug}.png`), fullPage: true });
    ok(`captured email: ${want.subjectMatch || mailbox} ("${hit.subject || ""}")`);
    found++;
  }
  await page.close();
  return { expected: cfg.expectedEmails.length, found };
}

// Capture the app's social/brand assets for THIS run (config-declared in
// cfg.social.assets), fetched from baseUrl so OG/icons reflect the run's commit.
// Device-independent, so captured once per run into <run>/social/.
async function captureSocial(cfg, baseUrl, outDir) {
  const list = cfg.social?.assets || [];
  if (!list.length) return 0;
  const base = (baseUrl || "").replace(/\/$/, "");
  const dir = join(outDir, "social");
  await mkdir(dir, { recursive: true });
  const out = [];
  for (const a of list) {
    try {
      const res = await fetch(`${base}${a.url}`);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(join(dir, a.file), buf);
      const dims = (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) ? `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}` : null;
      out.push({ key: a.key, group: a.group, file: a.file, spec: dims || a.spec, usage: a.usage, bytes: buf.length });
    } catch { /* skip unreachable */ }
  }
  const { meta, warnings } = await scrapeSocialMeta(base, out);
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ generatedFrom: base, assets: out, colors: cfg.social?.colors || [], meta, warnings }, null, 2), "utf8");
  return out.length;
}

// Scrape OG/Twitter meta from the landing page so the gallery can render real
// per-platform link previews, plus surface common sharing gotchas as warnings.
async function scrapeSocialMeta(base, assets) {
  const warnings = [];
  let meta = null;
  try {
    const html = await (await fetch(`${base}/`)).text();
    const all = {};
    for (const t of html.match(/<meta\b[^>]*>/gi) || []) {
      const k = (t.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const v = (t.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (k && v != null) all[k] = v.replace(/&amp;/g, "&").replace(/&#0?39;|&#x27;/gi, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    }
    meta = {
      title: all["og:title"] || null, description: all["og:description"] || null, image: all["og:image"] || null,
      url: all["og:url"] || null, siteName: all["og:site_name"] || null, type: all["og:type"] || null,
      twitterCard: all["twitter:card"] || null, twitterImage: all["twitter:image"] || null,
      twitterTitle: all["twitter:title"] || null, twitterDescription: all["twitter:description"] || null,
      imageWidth: all["og:image:width"] || null, imageHeight: all["og:image:height"] || null,
    };
    const og = assets.find((a) => a.file === "og.png");
    if (!meta.image) warnings.push("No og:image — most platforms show no image (icon fallback only)");
    if (og && og.bytes > 300 * 1024) warnings.push(`OG image ${Math.round(og.bytes / 1024)} KB — WhatsApp may skip previews over ~300 KB`);
    if (!all["twitter:image"]) warnings.push("No twitter:image — X falls back to og:image");
    if (!all["twitter:card"]) warnings.push("No twitter:card — X defaults to a small summary card");
    if (!all["og:image:width"] || !all["og:image:height"]) warnings.push("No og:image:width/height — WhatsApp/others render more reliably with them");
    const m = og && og.spec.match(/(\d+)×(\d+)/);
    if (m) { const r = +m[1] / +m[2]; if (r < 1.7 || r > 2.1) warnings.push(`OG image ${r.toFixed(2)}:1 — not ~1.91:1, expect cropping`); }
  } catch { /* meta scrape failed — leave null */ }
  return { meta, warnings };
}

// Pull the first link matching `linkMatch` from the newest email to `mailbox`.
// Used by the magicLink action to actually complete a passwordless login.
async function findEmailLink(base0, mailbox, linkMatch, timeoutMs) {
  const base = (base0 || "http://127.0.0.1:54324").replace(/\/$/, "");
  const flavor = await detectFlavor(base);
  const needle = mailbox.toLowerCase();
  const re = new RegExp(linkMatch || "/auth/(v1/verify|confirm|callback)");
  const deadline = Date.now() + (timeoutMs || 25000);
  while (Date.now() < deadline) {
    try {
      let body = null;
      if (flavor === "mailpit") {
        const list = await fetch(`${base}/api/v1/messages?limit=200`).then((r) => r.json());
        const m = (list.messages || []).find((m) => (m.To || []).some((t) => (t.Address || "").toLowerCase().includes(needle)));
        if (m) { const full = await fetch(`${base}/api/v1/message/${m.ID}`).then((r) => r.json()); body = `${full.HTML || ""}\n${full.Text || ""}`; }
      } else {
        const list = await fetch(`${base}/api/v1/mailbox/${encodeURIComponent(mailbox)}`).then((r) => r.json());
        const m = (list || [])[(list || []).length - 1];
        if (m) { const full = await fetch(`${base}/api/v1/mailbox/${encodeURIComponent(mailbox)}/${m.id}`).then((r) => r.json()); body = `${full.body?.html || ""}\n${full.body?.text || ""}`; }
      }
      if (body) {
        for (const u of body.match(/https?:\/\/[^\s"'<>]+/g) || []) {
          const dec = u.replace(/&amp;/g, "&");
          if (re.test(dec)) return dec;
        }
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// ---------- step interpreter ----------
// Returns a manifest entry when a screenshot is taken, or null (step.shot===false,
// e.g. intermediate form fills) so the gallery shows one screen per *visible* state.
async function runStep(page, step, idx, outDir, vars, cfg, deviceName) {
  const label = `${pad(idx)}-${(step.route || step.name || step.action).replace(/[^\w.-]+/g, "_")}-${step.state || "default"}`;
  switch (step.action) {
    case "goto":
      await page.goto(interpolate(step.url, vars), { waitUntil: step.waitUntil || "networkidle" });
      break;
    case "fill":
      await page.fill(step.selector, interpolate(step.value, vars));
      break;
    case "click":
      await page.click(step.selector);
      break;
    case "waitFor":
      await page.waitForSelector(step.selector, { timeout: step.timeoutMs || 15000 });
      break;
    case "magicLink": {
      const url = await findEmailLink(cfg?.inbucketUrl, interpolate(step.mailbox, vars), step.linkMatch, step.timeoutMs);
      if (!url) { fail(`magicLink: no link matching ${step.linkMatch || "(default)"} for ${interpolate(step.mailbox, vars)}`); break; }
      await page.goto(url, { waitUntil: step.waitUntil || "networkidle" });
      break;
    }
    case "expectText": {
      const visible = await page.getByText(step.text, { exact: false }).first().isVisible().catch(() => false);
      if (!visible) fail(`expectText failed at step ${idx}: "${step.text}" not visible`);
      break;
    }
    case "screenshot":
      break; // screenshot taken below
    default:
      fail(`unknown action "${step.action}" at step ${idx}`);
  }
  if (step.settleMs) await page.waitForTimeout(step.settleMs);
  if (step.shot === false) return null; // no visible state to capture (fills, intermediate clicks)
  // Next.js mounts its development badge inside an open shadow root. Hide only
  // that badge before capture; leave the rest of the dev overlay intact so real
  // runtime/build errors still appear in evidence.
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((portal) => {
      const indicator =
        portal.shadowRoot?.getElementById("devtools-indicator") ||
        portal.shadowRoot?.getElementById("data-devtools-indicator");
      if (indicator) indicator.style.display = "none";
    });
  });
  await page.screenshot({ path: join(outDir, "screens", deviceName, `${label}.png`), fullPage: !!step.fullPage });
  return { idx, label, route: step.route || null, state: step.state || "default", note: step.note || "", flow: step.flow || null, variant: step.variant || null };
}

// ---------- main ----------
const raw = await loadConfig();
// One config file per app: merge shared top-level keys with the `walkthrough`
// section. Falls back to a flat file if `walkthrough` is absent.
const cfg = {
  appName: raw.appName,
  baseUrl: raw.baseUrl,
  device: raw.device,
  ...(raw.walkthrough || raw),
};
const baseVars = { run: `run-${stamp}`, timestamp: stamp };
// Artifacts base (parent of the per-run dir) — where the run-number counter lives.
const artifactsBase = resolve(dirname(interpolate(cfg.outputDir || `runshot/artifacts/${stamp}`, baseVars)));
await mkdir(artifactsBase, { recursive: true });

// Monotonic run number, never reused even if older runs are deleted (a .seq
// counter file). Stored in summary.json so the gallery shows a stable #N.
const seqFile = join(artifactsBase, ".seq");
let runNumber;
try { runNumber = (parseInt(await readFile(seqFile, "utf8"), 10) || 0) + 1; } catch { runNumber = 1; }
try { await writeFile(seqFile, String(runNumber), "utf8"); } catch { /* best effort */ }

// Simple, sortable run id for the folder/URL: dd-mm-yyyy-<number>.
const _dd = String(startedAt.getDate()).padStart(2, "0");
const _mm = String(startedAt.getMonth() + 1).padStart(2, "0");
const runId = `${_dd}-${_mm}-${startedAt.getFullYear()}-${runNumber}`;
const outDir = join(artifactsBase, runId);
await mkdir(outDir, { recursive: true });

// Device matrix: each runs the FULL flow with its own viewport, video, screens,
// and a unique signup identity (apps often enforce one account per email/phone).
// A device is { name, label, use?: <playwright device name>, viewport?: {width,height} }.
const DEVICES = cfg.devices && cfg.devices.length
  ? cfg.devices
  : [{ name: "default", label: cfg.device || "iPhone 14 Pro", use: cfg.device || "iPhone 14 Pro" }];

console.log(`\n▶ walkthrough [${mode}]  app="${cfg.appName}"  base="${cfg.baseUrl}"  devices=${DEVICES.map((d) => d.name).join(", ")}\n`);

// Fake mic + auto-granted permission so getUserMedia() (voice flows) doesn't hang
// on a permission dialog in headless. (A real conversation still needs LiveKit.)
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

let manifestScreens = null; // step metadata is identical across devices — record once
const deviceResults = [];
let emailsFound = 0, emailsExpected = 0;

for (let di = 0; di < DEVICES.length; di++) {
  const dev = DEVICES[di];
  // Per-device identity so each device's signup doesn't collide with the others'.
  // devIndex is a stable NUMBER for fields that get digit-normalized (e.g. phone),
  // since the device name is non-numeric and would be stripped to a shared value.
  const dvars = { ...baseVars, run: `${baseVars.run}-${dev.name}`, device: dev.name, devIndex: String(di) };
  for (const [k, v] of Object.entries(cfg.freshIdentity || {})) dvars[k] = interpolate(v, dvars);

  const descriptor = dev.use ? devices[dev.use] : null;
  const viewport = dev.viewport || descriptor?.viewport || { width: 1280, height: 800 };
  await mkdir(join(outDir, "screens", dev.name), { recursive: true });
  await mkdir(join(outDir, "video", dev.name), { recursive: true });
  console.log(`  ▸ ${dev.name} (${viewport.width}×${viewport.height})`);

  const context = await browser.newContext({
    ...(descriptor || {}),
    ...(dev.viewport ? { viewport: dev.viewport, isMobile: false, hasTouch: false } : {}),
    baseURL: cfg.baseUrl,
    permissions: ["microphone"],
    recordVideo: { dir: join(outDir, "video", dev.name), size: viewport },
  });
  const page = await context.newPage();

  const screens = [];
  for (let i = 0; i < (cfg.steps || []).length; i++) {
    try {
      const entry = await runStep(page, cfg.steps[i], i, outDir, dvars, cfg, dev.name);
      if (entry) screens.push(entry);
    } catch (e) {
      fail(`[${dev.name}] step ${i} (${cfg.steps[i].action}) threw: ${e.message}`);
      await page.screenshot({ path: join(outDir, "screens", dev.name, `${pad(i)}-ERROR.png`) }).catch(() => {});
    }
  }
  await page.close();
  await context.close(); // flushes the video file to disk
  // Transcode the VP8 .webm recording to .mp4 (H.264) so it plays in Safari too.
  // Best-effort: if ffmpeg isn't installed, the .webm stays and the gallery uses it.
  try {
    const vdir = join(outDir, "video", dev.name);
    for (const f of (await readdir(vdir)).filter((f) => f.endsWith(".webm"))) {
      const inp = join(vdir, f), out = inp.replace(/\.webm$/, ".mp4");
      execSync(`ffmpeg -y -i "${inp}" -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart "${out}"`, { stdio: "ignore" });
    }
  } catch { /* no ffmpeg — keep webm */ }
  const emails = await captureEmails(cfg, dvars, outDir, browser, dev.name, viewport);
  emailsFound += emails.found; emailsExpected += emails.expected;
  if (!manifestScreens) manifestScreens = screens;
  deviceResults.push({ name: dev.name, label: dev.label || dev.name, viewport, screens: screens.length, emailsFound: emails.found, emailsExpected: emails.expected });
}
await browser.close();

// Social/brand assets — once per run (device-independent), from the live app.
const socialCount = await captureSocial(cfg, cfg.baseUrl, outDir);

// ---------- write manifest + summary ----------
// Screens are device-independent metadata (label/route/state/note/flow); each
// device's actual PNG lives at screens/<device>/<label>.png.
await writeFile(join(outDir, "manifest.json"), JSON.stringify({
  appName: cfg.appName, env: cfg.baseUrl, run: baseVars.run, devices: deviceResults, screens: manifestScreens || [],
}, null, 2));

const summary = {
  ok: failures.length === 0,
  mode,
  runNumber,
  ...(await runContext()),
  devices: deviceResults.map((d) => d.name),
  stepsRun: (manifestScreens || []).length,
  emailsExpected,
  emailsFound,
  socialAssets: socialCount,
  failures,
  outDir,
};
await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`\n${summary.ok ? "✅ ok" : "❌ failures: " + failures.length}`);
console.log(`   devices: ${deviceResults.length}   screens/device: ${summary.stepsRun}   emails: ${emailsFound}/${emailsExpected}`);
console.log(`   artifacts: ${outDir}\n`);

if (mode === "assert" && !summary.ok) process.exit(1);
