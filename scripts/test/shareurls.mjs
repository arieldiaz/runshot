#!/usr/bin/env node
// shareurls.mjs — Layer-2 real-share-link preview test.
//
// Spins up a throwaway fixture site whose slugs each exhibit one unfurl outcome
// (good, relative og:image, missing og:image+title, 404 image, cross-host image),
// runs the real capture (scripts/social.mjs) against it, and asserts the manifest
// + the gallery's rendered Social HTML. No browser, no user repos.
//
//   node test/shareurls.mjs
//
// Exits non-zero on the first failure so it can gate CI.
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { captureSocial } from "../social.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };

// ---------- build a genuinely valid solid-color PNG of given dimensions ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x88)]); // filter 0 + gray pixels
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const PNG = makePng(1200, 630);

// ---------- fixture server: one slug per unfurl outcome ----------
// PORT is filled in after listen so absolute og:image URLs point back at us.
let PORT = 0;
const html = (head) => `<!doctype html><html><head>${head}</head><body>ok</body></html>`;
const page = (slug) => {
  const abs = `http://127.0.0.1:${PORT}/img/og.png`;
  switch (slug) {
    case "good": return html(
      `<title>Fallback</title>` +
      `<meta property="og:title" content="A Life Story — Margaret &amp; Sarah">` +
      `<meta property="og:description" content="Seventy-eight years, in her own words.">` +
      `<meta property="og:image" content="${abs}">` +
      `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` +
      `<meta property="og:url" content="http://127.0.0.1:${PORT}/good">` +
      `<meta name="twitter:card" content="summary_large_image">`);
    case "relative": return html( // resolves 200 but og:image is a naked path → blanks in the wild
      `<meta property="og:title" content="Relative image slug">` +
      `<meta property="og:description" content="Image URL is not absolute.">` +
      `<meta property="og:image" content="/img/og.png">`);
    case "blank": return html(`<meta name="description" content="No title, no image.">`); // no og:title/<title>, no og:image
    case "badimg": return html(
      `<title>Broken image</title>` +
      `<meta property="og:image" content="http://127.0.0.1:${PORT}/img/missing.png">`);
    default: return null;
  }
};

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/img/og.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
  if (path === "/img/missing.png") { res.writeHead(404); return res.end("no"); }
  const slug = path.replace(/^\/+/, "");
  const body = page(slug);
  if (body == null) { res.writeHead(404); return res.end("no such slug"); }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(body);
});

const tmp = await mkdtemp(join(tmpdir(), "runshot-share-"));
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  const base = `http://127.0.0.1:${PORT}`;

  const cfg = { social: { shareUrls: [
    { label: "Good gift link", url: "/good" },
    { label: "Relative image", url: "/relative" },
    { label: "Blank (no og)", url: "/blank" },
    { label: "Broken image", url: "/badimg" },
    { label: "Absolute URL form", url: `${base}/good` },
  ] } };

  // Capture with a reporter so we can also assert the failure routing.
  const failMsgs = [];
  const report = { fail: (m) => failMsgs.push(m), ok: () => {} };
  const counts = await captureSocial(cfg, base, tmp, report);

  ok(counts.shareUrls === 5, `captured all 5 share URLs (got ${counts.shareUrls})`);

  const manifest = JSON.parse(await readFile(join(tmp, "social", "manifest.json"), "utf8"));
  const by = Object.fromEntries((manifest.shareUrls || []).map((s) => [s.label, s]));

  // Good absolute image → ok, image saved, dims read, no problems.
  ok(by["Good gift link"]?.ok === true, "good slug: ok=true");
  ok(by["Good gift link"]?.imageFile?.startsWith("shareurls/"), "good slug: og.png captured into shareurls/");
  ok(by["Good gift link"]?.imageDims === "1200×630", `good slug: dims parsed (got ${by["Good gift link"]?.imageDims})`);
  ok(by["Good gift link"]?.problems.length === 0, "good slug: zero problems");

  // Relative og:image → flagged not-absolute, but still fetched + rendered.
  ok(by["Relative image"]?.ok === false, "relative slug: ok=false");
  ok(by["Relative image"]?.problems.some((p) => /not absolute/i.test(p)), "relative slug: flags non-absolute og:image");
  ok(!!by["Relative image"]?.imageFile, "relative slug: image still resolved+captured (art shown under the loud flag)");

  // Blank → missing title AND missing image (two hard problems).
  ok(by["Blank (no og)"]?.problems.some((p) => /og:title/i.test(p)), "blank slug: flags missing title");
  ok(by["Blank (no og)"]?.problems.some((p) => /no og:image/i.test(p)), "blank slug: flags missing og:image");
  ok(by["Blank (no og)"]?.imageFile === null, "blank slug: no image file");

  // 404 image → flagged.
  ok(by["Broken image"]?.problems.some((p) => /HTTP 404/i.test(p)), "badimg slug: flags 404 og:image");

  // Absolute-form url works the same as relative form.
  ok(by["Absolute URL form"]?.ok === true, "absolute-url share form: ok=true");

  // Failure routing: every problem reached the reporter (→ assert-mode gate).
  const totalProblems = (manifest.shareUrls || []).reduce((n, s) => n + s.problems.length, 0);
  ok(failMsgs.length === totalProblems && totalProblems >= 4, `all ${totalProblems} problems routed to fail() for assert-mode gating`);

  // ---------- gallery render: Social HTML shows previews + loud problems ----------
  // Build the project gallery from a fixture layout, then read the run's HTML.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const galleryBase = await mkdtemp(join(tmpdir(), "runshot-share-gal-"));
  const runDir = join(galleryBase, "demo", "runshot", "artifacts", "2026-07-14T00-00-00-000Z");
  await mkdir(join(runDir, "social"), { recursive: true });
  await mkdir(join(runDir, "social", "shareurls"), { recursive: true });
  // reuse the captured social/ dir
  const { cp } = await import("node:fs/promises");
  await cp(join(tmp, "social"), join(runDir, "social"), { recursive: true });
  await writeFile(join(runDir, "summary.json"), JSON.stringify({ ok: false, ranAt: "2026-07-14T00:00:00.000Z", runNumber: 1, stepsRun: 0 }));
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({ screens: [], devices: [] }));

  const { spawn } = await import("node:child_process");
  const gallery = join(here, "..", "gallery.mjs");
  await new Promise((res, rej) => {
    const c = spawn(process.execPath, [gallery, "--base", galleryBase], { stdio: "inherit" });
    c.on("exit", (code) => code === 0 ? res() : rej(new Error(`gallery build exited ${code}`)));
    c.on("error", rej);
  });
  const runHtml = await readFile(join(runDir, "index.html"), "utf8");

  ok(/Real share-link previews/.test(runHtml), "gallery: renders the Real share-link previews section");
  ok(/class="probs"/.test(runHtml), "gallery: renders the loud red problems banner");
  ok(runHtml.includes("shareurls/good-gift-link.png"), "gallery: good slug's captured image is wired into the preview");
  ok(/not absolute/i.test(runHtml), "gallery: surfaces the non-absolute og:image problem text");
  ok(/✓ unfurls/.test(runHtml) && /✗ \d+ problem/.test(runHtml), "gallery: per-URL ok / problem badges both render");

  await rm(galleryBase, { recursive: true, force: true });
} finally {
  server.close();
  await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll share-URL checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
