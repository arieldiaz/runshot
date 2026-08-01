// social.mjs — the OG/social layer of a runshot run, factored out of the
// Playwright flow so it's testable without a browser.
//
// Two passes, both device-independent, both writing into <run>/social/:
//
//   Layer 1  cfg.social.assets    — capture pre-supplied OG image URLs (e.g.
//                                    /api/og?v=brand) at their native size, plus
//                                    scrape the homepage <head> for a preview.
//   Layer 2  cfg.social.shareUrls — verify REAL share links unfurl end-to-end:
//                                    fetch the live page, parse ITS head, resolve
//                                    + fetch ITS og:image, and record the true
//                                    per-platform unfurl. Loud on the class of bug
//                                    where a naked-slug link resolves 200 but
//                                    previews blank (missing/relative/404 image,
//                                    missing title).
//
// captureSocial() takes an optional `report` = { fail, ok } so the walkthrough
// can route hard share-link problems into its own failure list (gating `assert`
// mode); it defaults to no-ops when called standalone (e.g. from tests).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------- pure parsing helpers ----------
// Decode the handful of HTML entities that appear in meta `content` attributes.
export const decodeEntities = (v) => String(v ?? "")
  .replace(/&amp;/g, "&").replace(/&#0?39;|&#x27;/gi, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// Parse every <meta property|name="…" content="…"> pair into a flat map.
export function parseMetaTags(html) {
  const all = {};
  for (const t of html.match(/<meta\b[^>]*>/gi) || []) {
    const k = (t.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const v = (t.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (k && v != null) all[k] = decodeEntities(v);
  }
  return all;
}

// The document <title>, decoded (a crawler's fallback when og:title is absent).
export function parseTitleTag(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) || null : null;
}

// Normalize scraped tags into the shape the gallery renders per platform.
export function ogMetaFrom(all, titleTag, pageUrl) {
  return {
    title: all["og:title"] || titleTag || null, description: all["og:description"] || all["description"] || null,
    image: all["og:image"] || null, url: all["og:url"] || pageUrl || null,
    siteName: all["og:site_name"] || null, type: all["og:type"] || null,
    twitterCard: all["twitter:card"] || null, twitterImage: all["twitter:image"] || null,
    twitterTitle: all["twitter:title"] || null, twitterDescription: all["twitter:description"] || null,
    imageWidth: all["og:image:width"] || null, imageHeight: all["og:image:height"] || null,
  };
}

// Intrinsic PNG dimensions from the IHDR chunk; null for non-PNG bytes.
export function pngDims(buf) {
  return (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47)
    ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
}

// Pick a file extension from the image bytes (so the gallery serves the right
// MIME) — og:image isn't always PNG. Falls back to the content-type, then png.
export function imgExt(buf, contentType) {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 11 && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (/svg/i.test(contentType || "")) return "svg";
  if (/jpe?g/i.test(contentType || "")) return "jpg";
  if (/webp/i.test(contentType || "")) return "webp";
  return "png";
}

// ---------- capture passes ----------
// Capture the app's social/brand assets for THIS run (config-declared in
// cfg.social.assets), fetched from baseUrl so OG/icons reflect the run's commit,
// plus the Layer-2 real-share-link pass. Writes <run>/social/manifest.json.
export async function captureSocial(cfg, baseUrl, outDir, report = {}) {
  const list = cfg.social?.assets || [];
  const shareList = cfg.social?.shareUrls || [];
  if (!list.length && !shareList.length) return { assets: 0, shareUrls: 0 };
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
      const d = pngDims(buf);
      out.push({ key: a.key, group: a.group, file: a.file, spec: (d ? `${d.w}×${d.h}` : null) || a.spec, usage: a.usage, bytes: buf.length });
    } catch { /* skip unreachable */ }
  }
  const { meta, warnings } = await scrapeSocialMeta(base, out);
  const shareUrls = await captureShareUrls(cfg, base, dir, report);
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ generatedFrom: base, assets: out, colors: cfg.social?.colors || [], meta, warnings, shareUrls }, null, 2), "utf8");
  return { assets: out.length, shareUrls: shareUrls.length };
}

// Scrape OG/Twitter meta from the landing page so the gallery can render a
// per-platform link preview, plus surface common sharing gotchas as warnings.
export async function scrapeSocialMeta(base, assets) {
  const warnings = [];
  let meta = null;
  try {
    const html = await (await fetch(`${base}/`)).text();
    const all = parseMetaTags(html);
    meta = ogMetaFrom(all, parseTitleTag(html), base);
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

// Layer 2 — prove that REAL share links unfurl, not just that pre-supplied OG
// art renders. For each { label, url } in cfg.social.shareUrls: fetch the live
// page, parse ITS <head> for OG/Twitter tags, resolve + fetch ITS og:image, and
// record the true unfurl from the ACTUAL parsed tags. Loud on the blank-preview
// class of bug (a naked-slug link that resolves 200 but previews empty): missing
// og:image, a non-absolute image URL, a 404 image, or a missing title. Each hard
// problem is routed through report.fail() so `assert` mode gates CI on it.
export async function captureShareUrls(cfg, base, dir, report = {}) {
  const fail = report.fail || (() => {});
  const ok = report.ok || (() => {});
  const list = cfg.social?.shareUrls || [];
  if (!list.length) return [];
  const shareDir = join(dir, "shareurls");
  await mkdir(shareDir, { recursive: true });
  const results = [];
  const usedSlugs = new Set();
  for (const s of list) {
    const label = s.label || s.url;
    // Absolute (https://heirlooming.com/<slug>) or baseUrl-relative (/<slug>,
    // the localhost equivalent) — both supported so one config works everywhere.
    const pageUrl = /^https?:\/\//i.test(s.url) ? s.url : `${base}${s.url.startsWith("/") ? "" : "/"}${s.url}`;
    let slug = (s.label || s.url).toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "share";
    while (usedSlugs.has(slug)) slug += "-x";
    usedSlugs.add(slug);

    const entry = { label, url: pageUrl, ok: false, status: null, meta: null, imageFile: null, imageStatus: null, imageDims: null, imageBytes: null, problems: [], warnings: [] };
    const problem = (m) => { entry.problems.push(m); fail(`share "${label}": ${m}`); };
    const warn = (m) => entry.warnings.push(m);

    try {
      const res = await fetch(pageUrl, { redirect: "follow" });
      entry.status = res.status;
      const finalUrl = res.url || pageUrl;
      if (!res.ok) { problem(`page returned HTTP ${res.status}`); results.push(entry); continue; }
      const html = await res.text();
      const all = parseMetaTags(html);
      const meta = ogMetaFrom(all, parseTitleTag(html), finalUrl);
      entry.meta = meta;

      if (!meta.title) problem("no og:title / <title> — the preview shows a bare URL");
      if (!all["og:description"]) warn("no og:description");
      if (!all["twitter:card"]) warn("no twitter:card — X uses a small summary card");
      if (!meta.imageWidth || !meta.imageHeight) warn("no og:image:width/height — some platforms render more reliably with them");

      const rawImg = meta.image;
      if (!rawImg) {
        problem("no og:image — the link previews blank on every platform");
      } else {
        if (!/^https?:\/\//i.test(rawImg)) {
          problem(`og:image is not absolute ("${rawImg}") — crawlers require an absolute URL; the preview blanks in the wild`);
        }
        let imgUrl = null;
        try { imgUrl = new URL(rawImg, finalUrl).href; } catch { problem(`og:image is not a resolvable URL ("${rawImg}")`); }
        if (imgUrl) {
          entry.meta.imageResolved = imgUrl;
          try {
            const ir = await fetch(imgUrl, { redirect: "follow" });
            entry.imageStatus = ir.status;
            if (!ir.ok) {
              problem(`og:image returned HTTP ${ir.status} (${imgUrl}) — preview blanks`);
            } else {
              const buf = Buffer.from(await ir.arrayBuffer());
              entry.imageBytes = buf.length;
              const file = `${slug}.${imgExt(buf, ir.headers.get("content-type"))}`;
              await writeFile(join(shareDir, file), buf);
              entry.imageFile = `shareurls/${file}`;
              const d = pngDims(buf);
              if (d) {
                entry.imageDims = `${d.w}×${d.h}`;
                const r = d.w / d.h;
                if (r < 1.7 || r > 2.1) warn(`og:image ${r.toFixed(2)}:1 — not ~1.91:1, expect cropping`);
              }
              if (buf.length > 300 * 1024) warn(`og:image ${Math.round(buf.length / 1024)} KB — WhatsApp may skip previews over ~300 KB`);
            }
          } catch (e) {
            problem(`og:image fetch failed (${imgUrl}): ${e.message}`);
          }
        }
      }
    } catch (e) {
      problem(`page fetch failed: ${e.message}`);
    }
    entry.ok = entry.problems.length === 0;
    if (entry.ok) ok(`share preview: ${label} ("${entry.meta?.title || ""}")`);
    results.push(entry);
  }
  return results;
}
