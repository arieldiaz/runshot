#!/usr/bin/env node
// gallery.mjs — browsable HTML for runshot artifacts, multi-project.
//
// One hub server for the whole machine: it scans <base>/*/runshot/artifacts (base
// defaults to ~/github) and serves each project under its own path, named after
// the repo folder — so several projects coexist on one port:
//
//   http://<host>:8080/                 → index of all projects
//   http://<host>:8080/twolife/         → that project's runs
//   http://<host>:8080/twolife/<run>/   → one run (video + phone-framed screens)
//
//   node gallery.mjs                 # build galleries for every project under base
//   node gallery.mjs --serve         # build, then serve the hub (0.0.0.0:8080)
//   node gallery.mjs --serve --base /path --port 9000
//
// Project pages are rebuilt on each request, so new runs appear without a restart.
import { readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { VERSION } from "./version.mjs";
import { withBasePath, appUrl, getBasePath, stripBasePath } from "./urls.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, [])
);
const BASE = resolve(args.base || join(homedir(), "github"));
const serve = !!args.serve;

// Network bind host: $HOST, else 0.0.0.0 (reachable on the LAN). Distinct from
// BASE_PATH (the URL prefix) and BASE (the filesystem scan root). The canonical
// external URL, if any, comes from $PUBLIC_BASE_URL.
const HOST = process.env.HOST && process.env.HOST.trim() !== "" ? process.env.HOST.trim() : "0.0.0.0";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// Server port: an explicit --port wins, else $PORT, else 8080. Strictly
// validated so a typo (or a stray --port with no value) can never silently
// fall back to a random/unexpected port — we exit instead.
const PORT = (() => {
  let raw, src;
  if ("port" in args) { raw = args.port; src = "--port"; }
  else if (process.env.PORT != null && process.env.PORT !== "") { raw = process.env.PORT; src = "$PORT"; }
  else { raw = 8080; src = "default"; }
  if (raw === true) { console.error("runshot: --port requires a value, e.g. --port 8080"); process.exit(1); }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`runshot: invalid port ${JSON.stringify(raw)} (from ${src}) — must be an integer 1–65535.`);
    process.exit(1);
  }
  return n;
})();

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// HTML-safe internal link: base-path-prefixed, then HTML-escaped for an attribute.
const link = (p) => esc(withBasePath(p));
const readJSON = async (p) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const artRootOf = (project) => join(BASE, project, "runshot", "artifacts");
const emailRootOf = (project) => join(BASE, project, "runshot", "email-templates");

const crumbBar = (crumbs, extra) => {
  if ((!crumbs || (Array.isArray(crumbs) && !crumbs.length)) && !extra) return "";
  const inner = typeof crumbs === "string" ? crumbs
    : (crumbs || []).map((c) => c.html ? c.html : c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : `<span class="cur">${esc(c.label)}</span>`).join('<span class="sep">›</span>');
  return `<header class="topbar"><nav class="crumbs">${inner}</nav>${extra || ""}</header>`;
};
const PAGE = (title, body, crumbs, extra) => `<!doctype html><meta charset="utf8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --os-bg:#f6f7f8; --os-panel:#fff; --os-panel-2:#eef1f4; --os-line:#d9dee5;
    --os-ink:#171a1f; --os-muted:#69717d; --os-faint:#9098a4; --os-accent:#2869d8;
    --os-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
    --os-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
    --rs-accent:#0c7d66; --rs-ok:#278a50; --rs-warn:#bd7618; --rs-bad:#d9485f;
  }
  @media (prefers-color-scheme:dark) {
    :root {
      --os-bg:#0b0d10; --os-panel:#14171c; --os-panel-2:#1b1f26; --os-line:#2a3038;
      --os-ink:#e8ecf1; --os-muted:#929ba7; --os-faint:#646e7c; --os-accent:#79a8ff;
      --rs-accent:#52dac0; --rs-ok:#55c987; --rs-warn:#e0a35f; --rs-bad:#ef7185;
    }
  }
  * { box-sizing:border-box; }
  html { background:var(--os-bg); overflow-x:hidden; }
  body { font:15px/1.5 var(--os-font); margin:0; padding:72px 24px 48px; background:var(--os-bg); color:var(--os-ink); }
  body.screens-mode { padding-bottom:0; overflow:hidden; }
  h1 { font:650 clamp(32px,5vw,64px)/1 var(--os-font); letter-spacing:-.045em; margin:0; }
  h2 { font-size:16px; margin:28px 0 10px; }
  /* page title + sub-heading on one line: title left, sub right (saves vertical space) */
  .pagehead { display:flex; align-items:center; justify-content:space-between; gap:24px; flex-wrap:wrap; margin:10px 0 28px; }
  .pagehead h1 { margin: 0; } .pagehead .sub { margin: 0; text-align: right; }
  .appfoot { display:flex; justify-content:space-between; gap:18px; flex-wrap:wrap; width:100%; margin-top:42px; padding:16px 0 0; border-top:1px solid var(--os-line); color:var(--os-faint); font:11px/1.6 var(--os-mono); }
  .appfoot span:last-child { text-align:right; }
  a { color:var(--rs-accent); } .muted { color:var(--os-muted); opacity:1; font-size:13px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 13px; }
  .ok { background:color-mix(in srgb,var(--rs-ok) 12%,transparent); color:var(--rs-ok); }
  .fail { background:color-mix(in srgb,var(--rs-bad) 12%,transparent); color:var(--rs-bad); }
  video { width: 100%; max-width: 420px; border-radius: 12px; border: 1px solid #8884; }
  .runs li { margin: 6px 0; } code { background: #8881; padding: 1px 5px; border-radius: 4px; }
  table { border-collapse:collapse; width:100%; font-size:14px; margin-top:8px; overflow:hidden; border:1px solid var(--os-line); border-radius:12px; background:var(--os-panel); }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--os-line); }
  th { user-select: none; white-space: nowrap; cursor: pointer; }
  th[data-dir]::after { content: " " attr(data-dir); opacity: .6; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:hover { background:var(--os-panel-2); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(220px,1fr)); gap: 16px; }
  .card { border:1px solid var(--os-line); border-radius:12px; overflow:hidden; background:var(--os-panel); }
  .card img { width: 100%; display: block; background: #8881; }
  .cap { padding: 8px 10px; font-size: 12px; } .cap b { font-size: 12.5px; } .cap .note { opacity: .65; }
  .screens { display: grid; grid-template-columns: repeat(auto-fill,minmax(240px,1fr)); gap: 18px; }
  .framewrap { position: relative; }
  .frame { aspect-ratio: 393 / 852; overflow-y: auto; overflow-x: hidden; background: #8881; }
  .frame img { width: 100%; display: block; cursor: default; }
  .fade { position: absolute; left: 0; right: 0; bottom: 0; height: 10px; pointer-events: none; opacity: 0;
          background: #e23b3b; transition: opacity .15s; }
  .card.scrollable .frame { outline: 2px solid #e23b3b; outline-offset: -2px; }
  .card.scrollable .fade { opacity: 1; }
  .tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; font-weight: 600; }
  .card.scrollable .tag { background: #e8973a22; color: #c9781f; } .card.scrollable .tag::before { content: "⇅ scroll"; }
  .card:not(.scrollable) .tag { background: #1f9d5512; color: #1f9d55; } .card:not(.scrollable) .tag::before { content: "✓ fits"; }
  .open { font-size: 11px; opacity: .65; }
  /* email template catalog */
  .mails { display: grid; grid-template-columns: repeat(auto-fill,minmax(340px,1fr)); gap: 20px; }
  .mail { margin: 0; border: 1px solid #8884; border-radius: 12px; overflow: hidden; }
  .mailcap { padding: 10px 12px; border-bottom: 1px solid #8884; }
  .mailcap b { font-size: 14px; }
  .trig { font-size: 12px; margin-top: 5px; line-height: 1.5; }
  .pill { display: inline-block; background: #8881; border-radius: 6px; padding: 1px 7px; font-family: ui-monospace,SFMono-Regular,monospace; font-size: 11px; }
  .mail iframe { width: 100%; height: 640px; border: 0; background: #fff; display: block; }
  /* social / brand asset catalog */
  .assets { display: grid; grid-template-columns: repeat(auto-fill,minmax(240px,1fr)); gap: 18px; }
  .asset { border: 1px solid #8884; border-radius: 12px; overflow: hidden; }
  .assetimg { padding: 14px; display: flex; align-items: center; justify-content: center; min-height: 150px;
    background: repeating-conic-gradient(#8882 0% 25%, transparent 0% 50%) 0 / 22px 22px; }
  .assetimg img { max-width: 100%; max-height: 300px; height: auto; display: block; }
  .acap { padding: 10px 12px; border-top: 1px solid #8884; font-size: 12px; } .acap b { font-size: 13px; }
  .swatches { display: flex; gap: 16px; flex-wrap: wrap; margin: 10px 0 20px; }
  .swatch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
  .swatch i { width: 18px; height: 18px; border-radius: 5px; border: 1px solid #8884; display: inline-block; }
  /* per-platform link-preview mockups */
  .previews { display: grid; grid-template-columns: repeat(auto-fill,minmax(300px,1fr)); gap: 18px; align-items: start; }
  .pv { position: relative; margin: 0; border: 1px solid #8884; border-radius: 12px; overflow: hidden; background: #fff; color: #111; }
  .pv .pvtag { position: absolute; top: 8px; right: 8px; background: #0009; color: #fff; font-size: 10px; padding: 1px 8px; border-radius: 999px; }
  .pv .pvimg img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .pv .pvimg.wide { aspect-ratio: 1.91 / 1; } .pv .pvimg.sq { aspect-ratio: 1 / 1; }
  .pv figcaption { padding: 10px 12px; }
  .pv b { display: block; font-size: 14px; line-height: 1.3; color: #111; }
  .pv .dom { color: #65676b; font-size: 12px; } .pv p { margin: 4px 0 0; color: #65676b; font-size: 12.5px; line-height: 1.4; }
  .pv-imsg figcaption { background: #f2f2f7; }
  .pv-wa { background: #dcf8c6; } .pv-wa .pvrow { display: flex; align-items: stretch; } .pv-wa .pvtext { padding: 10px 12px; flex: 1; min-width: 0; } .pv-wa .pvimg.sq { width: 92px; flex: none; }
  .pv-fb .fbmeta { background: #f0f2f5; } .dom.up { text-transform: uppercase; font-size: 11px; letter-spacing: .02em; }
  .pv-slack { display: flex; } .pv-slack .pvbar { width: 4px; background: #1264a3; flex: none; } .pv-slack .pvslackbody { padding: 10px 12px; min-width: 0; } .pv-slack .site { font-size: 12px; color: #616061; display: block; margin-bottom: 2px; } .pv-slack b { color: #1264a3; } .pv-slack .pvimg.sm { width: 140px; margin-top: 8px; border-radius: 8px; overflow: hidden; }
  .warns { background: #e8973a22; color: #9a6212; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; margin: 6px 0 16px; line-height: 1.6; }
  /* run page: toolbar, tabs, directional canvas */
  .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0 6px; }
  select { font: inherit; padding: 5px 9px; border-radius: 8px; border: 1px solid #8884; background: transparent; color: inherit; }
  .tabs { display: flex; gap: 6px; }
  .tabs button { font: inherit; padding: 6px 14px; border: 1px solid #8884; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
  .tabs button.active { background: #29704114; border-color: #297041; color: #297041; font-weight: 600; }
  .canvaswrap { overflow: auto; width: 100%; height: calc(100vh - 72px); border-top: 1px solid #8884; }
  .groupsection { margin: 0 0 38px; }
  .groupsection h2 { margin: 20px 20px 4px; font-size: 18px; }
  .canvas { position: relative; }
  .arrows { position: absolute; left: 0; top: 0; pointer-events: none; }
  .arrows path { stroke: #297041; stroke-width: 2; fill: none; opacity: .75; }
  .ncard { position: absolute; margin: 0; }
  .ncard .nwrap { position: relative; }
  .ncard .nframe { overflow-y: auto; overflow-x: hidden; background: #fff; border: 1px solid #8884; border-radius: 8px; }
  .ncard .nframe img { width: 100%; display: block; }
  .ncard .nfade { position: absolute; left: 0; right: 0; bottom: 0; height: 10px; background: #e23b3b; opacity: 0; pointer-events: none; border-radius: 0 0 8px 8px; }
  .ncard.scrollable .nframe { box-shadow: 0 0 0 2px #e23b3b; }
  .ncard.scrollable .nfade { opacity: 1; }
  .ncap { font-size: 12px; margin-top: 5px; }
  .ncap summary { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; list-style-position: inside; }
  .ncap .stepno { display: inline-block; min-width: 2.4em; color: #e23b3b; font-variant-numeric: tabular-nums; }
  .ncap .dim { opacity: .55; }
  .ncap .more { font-size: 11.5px; opacity: .8; margin-top: 5px; line-height: 1.5; white-space: normal; }
  video { width: 100%; max-width: 520px; }
  .topbar { position:fixed; inset:0 0 auto; z-index:30; height:52px; padding:0 24px; background:color-mix(in srgb,var(--os-bg) 88%,transparent); border-bottom:1px solid var(--os-line); backdrop-filter:blur(16px); display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .crumbs { font-size: 13px; display: flex; align-items: center; flex-wrap: wrap; }
  .crumbs a { color:var(--os-muted); text-decoration:none; } .crumbs a:hover { color:var(--os-ink); }
  .crumbs .sep { opacity: .4; margin: 0 8px; } .crumbs .cur { font-weight: 600; }
  .htoolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dsel { font-size: 12.5px; }
  .views { display: inline-flex; gap: 3px; vertical-align: middle; }
  .vt { font: inherit; font-size: 13px; border: 1px solid #8884; background: transparent; color: inherit; border-radius: 7px; padding: 3px 10px; cursor: pointer; }
  .vt.active { background: #29704114; border-color: #297041; color: #297041; font-weight: 600; }
  .homelinks { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 16px; }
  .homecard { display:flex; flex-direction:column; gap:4px; align-items:flex-start; text-align:left; font:inherit; border:1px solid var(--os-line); border-radius:12px; padding:16px 18px; min-width:200px; background:var(--os-panel); color:inherit; cursor:pointer; }
  .homecard:hover { border-color:var(--rs-accent); background:var(--os-panel-2); }
  .homecard b { font-size: 15px; }
  .delcol { text-align: center; }
  button.del { font: inherit; border: 1px solid #8884; background: transparent; color: inherit; border-radius: 6px; padding: 2px 8px; cursor: pointer; opacity: .6; }
  button.del:hover { opacity: 1; border-color: #d6336c; color: #d6336c; }
  .runs { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
  .runs li { margin:0; padding:14px 16px; border:1px solid var(--os-line); border-radius:10px; background:var(--os-panel); }
  @media(max-width:640px) {
    body { padding:66px 14px 36px; }
    .topbar { padding:0 14px; }
    .pagehead { align-items:flex-start; gap:12px; }
    .pagehead .sub { text-align:left; }
    .appfoot { display:block; }
    .appfoot span { display:block; text-align:left !important; margin-top:4px; }
  }
</style>
${crumbBar(crumbs, extra)}
${body}
<footer id="appfooter" class="appfoot"><span>runshot v${VERSION} · Node gallery · <span id="route"></span><br>source github.com/arieldiaz/runshot</span><span>rendered <span id="rendered"></span><br>system light/dark · static HTML/CSS/JS</span></footer>
<script>
document.getElementById("route").textContent=location.protocol+"//"+location.host+location.pathname;
document.getElementById("rendered").textContent=new Intl.DateTimeFormat(undefined,{year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit",timeZoneName:"short"}).format(new Date());
</script>`;

// Run page: device dropdown swaps every screen/video/email; a variant toggle
// switches which capture pass shows on the canvas; tabs toggle sections.
const RUN_JS = (data) => `<script>
const D = ${data};
var curDev, curVariant = (D.variants && D.variants[0]) || 'Zero state', curRole='All', curStage='All';
function checkFrame(fr){ var c=fr.closest('.ncard'); if(c) c.classList.toggle('scrollable', fr.scrollHeight > fr.clientHeight + 2); }
function applyLayout(dev, variant){
  var LV = D.layouts[dev]; if(!LV) return;
  var VG = LV[variant] || LV[Object.keys(LV)[0]]; if(!VG) return;
  document.querySelectorAll('.groupsection').forEach(function(sec){
    var L=VG[sec.dataset.group]; if(!L) return;
    var canvas=sec.querySelector('.canvas'), svg=sec.querySelector('svg.arrows'), ap=sec.querySelector('.arrowpaths');
    canvas.style.width=L.cw+'px'; canvas.style.height=L.ch+'px';
    svg.setAttribute('width',L.cw); svg.setAttribute('height',L.ch); ap.innerHTML=L.arrows;
    sec.querySelectorAll('.nframe').forEach(function(fr){ fr.style.height=L.frameH+'px'; });
  });
  document.querySelectorAll('.ncard').forEach(function(c){
    if(c.dataset.variant === variant){
      var L=VG[c.dataset.group], vi=+c.dataset.gindex, p=L && L.pos[vi];
      if(p){ c.style.left=p[0]+'px'; c.style.top=p[1]+'px'; c.style.width=L.cardW+'px'; }
    }
  });
  applyFilters(false);
}
function setVariant(v){
  curVariant=v;
  var a=D.available[v] || {roles:[],stages:[]};
  if(curRole!=='All' && a.roles.indexOf(curRole)<0){ curRole='All'; if(document.getElementById('role')) document.getElementById('role').value='All'; }
  if(curStage!=='All' && a.stages.indexOf(curStage)<0){ curStage='All'; if(document.getElementById('stage')) document.getElementById('stage').value='All'; }
  applyLayout(curDev, v);
  var vw=document.getElementById('varwrap');
  if(vw) vw.querySelectorAll('.vt').forEach(function(b){ b.classList.toggle('active', b.dataset.variant===v); });
  setTimeout(function(){ document.querySelectorAll('.nframe').forEach(checkFrame); }, 60);
}
function applyFilters(push){
  document.querySelectorAll('.groupsection').forEach(function(sec){
    var shown=0;
    sec.querySelectorAll('.ncard').forEach(function(c){
      var visible=c.dataset.variant===curVariant &&
        (curRole==='All' || c.dataset.role===curRole) &&
        (curStage==='All' || c.dataset.stage===curStage);
      c.style.display=visible?'':'none'; if(visible) shown++;
    });
    sec.style.display=shown?'':'none';
  });
  var q=new URLSearchParams(location.search);
  if(curRole==='All') q.delete('role'); else q.set('role',curRole);
  if(curStage==='All') q.delete('stage'); else q.set('stage',curStage);
  var url=location.pathname+(q.toString()?'?'+q:'')+location.hash;
  if(push) history.pushState(null,'',url); else history.replaceState(null,'',url);
}
function setFilter(kind,value){
  if(kind==='role') curRole=value; else curStage=value;
  applyFilters(true);
}
function setDevice(dev){
  curDev = dev;
  var sub = D.sub[dev] || "";
  document.querySelectorAll('img.shot').forEach(function(img){ img.src = 'screens/'+sub+img.dataset.label+'.png'; });
  document.querySelectorAll('a.shotlink').forEach(function(a){ a.href = 'screens/'+sub+a.dataset.label+'.png'; });
  applyLayout(dev, curVariant);
  var v = document.getElementById('vid');
  if (v){ var src = D.videos[dev]; if (src){ v.src = src; v.style.display=''; } else { v.removeAttribute('src'); v.style.display='none'; } }
  var ew = document.getElementById('emailwrap');
  if (ew){ var es = D.emails[dev] || []; ew.innerHTML = es.length ? es.map(function(f){ return '<div class="card"><a href="'+f+'" target="_blank"><img src="'+f+'"></a><div class="cap">'+f.split('/').pop()+'</div></div>'; }).join('') : '<p class="muted">No emails captured for this device.</p>'; }
  setTimeout(function(){ document.querySelectorAll('.nframe').forEach(checkFrame); }, 60);
}
var LABELS = { screens: 'Screens', video: 'Video', emails: 'Emails', social: 'Social' };
var TABS = ['home','screens','video','emails','social'];
// Tab = URL hash, so the run number stays in the breadcrumb and the browser
// Back button steps a type view → home (types) → runs list, not straight out.
function renderTab(t){
  if(TABS.indexOf(t) < 0) t = 'home';
  document.body.classList.toggle('screens-mode', t==='screens');
  TABS.forEach(function(x){ var el=document.getElementById('tab-'+x); if(el) el.style.display = x===t?'':'none'; });
  var mc = document.getElementById('modecrumb'); if(mc) mc.innerHTML = (t!=='home' && LABELS[t]) ? '<span class="sep">›</span><span class="cur">'+LABELS[t]+'</span>' : '';
  var dw = document.getElementById('devwrap'); if(dw) dw.style.display = (t==='home') ? 'none' : '';
  var vw = document.getElementById('varwrap'); if(vw) vw.style.display = (t==='screens') ? '' : 'none'; // variant only applies to Screens
  ['rolewrap','stagewrap'].forEach(function(id){ var el=document.getElementById(id); if(el) el.style.display=(t==='screens')?'':'none'; });
  var ft = document.getElementById('appfooter'); if(ft) ft.style.display = (t==='screens') ? 'none' : ''; // footer off in the full-canvas screens view
  if(t==='screens') setTimeout(function(){ document.querySelectorAll('.nframe').forEach(checkFrame); }, 30);
}
function tabFromHash(){ return (location.hash||'').replace(/^#/,'') || 'home'; }
function showTab(t){ if(tabFromHash()===t) renderTab(t); else location.hash = (t==='home' ? '' : t); }
window.addEventListener('hashchange', function(){ renderTab(tabFromHash()); });
document.querySelectorAll('.nframe').forEach(function(fr){ var img=fr.querySelector('img'); if(img) img.addEventListener('load', function(){ checkFrame(fr); }); });
document.getElementById('device').addEventListener('change', function(e){ setDevice(e.target.value); });
var vwrap = document.getElementById('varwrap');
if(vwrap){ vwrap.querySelectorAll('.vt').forEach(function(btn){ btn.addEventListener('click', function(){ setVariant(btn.dataset.variant); }); }); }
['role','stage'].forEach(function(kind){ var el=document.getElementById(kind); if(el) el.addEventListener('change',function(e){setFilter(kind,e.target.value);}); });
document.querySelectorAll('.homecard').forEach(function(b){ b.addEventListener('click', function(){ showTab(b.dataset.tab); }); });
var qs=new URLSearchParams(location.search);
if(document.getElementById('role') && qs.get('role')){ curRole=qs.get('role'); document.getElementById('role').value=curRole; }
if(document.getElementById('stage') && qs.get('stage')){ curStage=qs.get('stage'); document.getElementById('stage').value=curStage; }
window.addEventListener('popstate',function(){
  var q=new URLSearchParams(location.search); curRole=q.get('role')||'All'; curStage=q.get('stage')||'All';
  if(document.getElementById('role')) document.getElementById('role').value=curRole;
  if(document.getElementById('stage')) document.getElementById('stage').value=curStage;
  applyFilters(false);
});
renderTab(tabFromHash()); setDevice(document.getElementById('device').value);
window.addEventListener('resize', function(){ document.querySelectorAll('.nframe').forEach(checkFrame); });
</script>`;

// US Eastern, human-readable (e.g. "Jun 17, 2026, 7:12 AM ET").
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
const fmtET = (d) => (d ? ET.format(d) + " ET" : "—");
const ETD = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium" });
const fmtDate = (d) => (d ? ETD.format(d) : "—"); // date only, no time
function runDate(run) {
  const iso = run.summary?.ranAt;
  if (iso) { const d = new Date(iso); if (!isNaN(+d)) return d; }
  const m = run.name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (m) { const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`); if (!isNaN(+d)) return d; }
  return null;
}

const SORT_JS = `<script>
(function(){
  var table=document.getElementById('runs'); if(!table) return;
  var tb=table.tBodies[0], cur=-1, asc=true, ths=table.tHead.rows[0].cells;
  function v(tr,i){var s=tr.children[i].getAttribute('data-sort')||'',n=parseFloat(s);return isNaN(n)?{s:s.toLowerCase()}:{n:n};}
  for(var i=0;i<ths.length;i++){(function(idx){ths[idx].onclick=function(){
    asc=(cur===idx)?!asc:(idx===0?false:true); cur=idx;
    var rows=[].slice.call(tb.rows);
    rows.sort(function(a,b){var va=v(a,idx),vb=v(b,idx),r;
      if('n'in va&&'n'in vb)r=va.n-vb.n; else r=(va.s<vb.s?-1:va.s>vb.s?1:0); return asc?r:-r;});
    rows.forEach(function(r){tb.appendChild(r);});
    for(var j=0;j<ths.length;j++)ths[j].removeAttribute('data-dir');
    ths[idx].setAttribute('data-dir',asc?'▲':'▼');};})(i);}
  ths[0].onclick(); // default: newest first (by #)
})();
</script>`;

// Delete a run from the table (calls the hub's POST ?delete=1 endpoint).
const DEL_JS = `<script>
document.querySelectorAll('button.del').forEach(function(b){ b.addEventListener('click', function(){
  var run=b.dataset.run;
  if(!confirm('Delete run '+run+'?\\nThis removes its screenshots, video, and emails.')) return;
  fetch('./'+run+'?delete=1',{method:'POST'}).then(function(r){ if(r.ok){ var tr=b.closest('tr'); if(tr) tr.remove(); } else alert('Delete failed'); }).catch(function(){ alert('Delete failed'); });
});});
</script>`;

const SCREEN_JS = `<script>
(function(){
  function check(fr){ var c=fr.closest('figure'); if(!c) return;
    c.classList.toggle('scrollable', fr.scrollHeight > fr.clientHeight + 2); }
  document.querySelectorAll('.frame').forEach(function(fr){
    var img=fr.querySelector('img');
    if(img && img.complete) check(fr); else if(img) img.addEventListener('load', function(){check(fr);});
  });
  window.addEventListener('resize', function(){ document.querySelectorAll('.frame').forEach(check); });
})();
</script>`;

async function listRuns(artRoot) {
  const entries = await readdir(artRoot, { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(artRoot, e.name);
    runs.push({ name: e.name, dir, summary: await readJSON(join(dir, "summary.json")), manifest: await readJSON(join(dir, "manifest.json")) });
  }
  // Newest first by recorded time (folder names are no longer ISO-sortable).
  return runs.sort((a, b) => (b.summary?.ranAt || b.name).localeCompare(a.summary?.ranAt || a.name));
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || "").replace(/^https?:\/\//, "").split("/")[0] || ""; } };

// Mock how the shared link renders on each platform, from the page's scraped
// OG/Twitter meta + the captured og image. Same image, platform-specific crop.
function renderLinkPreviews(m, warnings, img) {
  const t = esc(m.title || ""), d = esc(m.description || ""), dom = esc(hostOf(m.url) || "your-site");
  const tt = esc(m.twitterTitle || m.title || ""), td = esc(m.twitterDescription || m.description || "");
  const card = (cls, plat, inner) => `<figure class="pv ${cls}">${inner}<span class="pvtag">${plat}</span></figure>`;
  const cards = [
    card("pv-imsg", "iMessage", `<div class="pvimg wide"><img src="${img}"></div><figcaption><b>${t}</b><span class="dom">${dom}</span></figcaption>`),
    card("pv-wa", "WhatsApp", `<div class="pvrow"><div class="pvtext"><b>${t}</b><p>${d}</p><span class="dom">${dom}</span></div><div class="pvimg sq"><img src="${img}"></div></div>`),
    card("pv-x", "X (Twitter)", `<div class="pvimg wide"><img src="${img}"></div><figcaption><span class="dom">${dom}</span><b>${tt}</b><p>${td}</p></figcaption>`),
    card("pv-fb", "Facebook", `<div class="pvimg wide"><img src="${img}"></div><figcaption class="fbmeta"><span class="dom up">${dom}</span><b>${t}</b><p>${d}</p></figcaption>`),
    card("pv-slack", "Slack", `<div class="pvbar"></div><div class="pvslackbody"><span class="site">${esc(m.siteName || dom)}</span><b>${t}</b><p>${d}</p><div class="pvimg sq sm"><img src="${img}"></div></div>`),
  ].join("");
  const warn = (warnings && warnings.length) ? `<div class="warns">⚠ ${warnings.map(esc).join(" &nbsp;·&nbsp; ")}</div>` : "";
  return `<h2>Link previews <span class="muted">(how the shared link renders per platform)</span></h2>${warn}<div class="previews">${cards}</div>`;
}

// Render a social/brand asset catalog (OG cards, icons, brand marks) — used in
// the per-run Social view. srcPrefix is relative to the page (e.g. "social/").
function renderSocial(manifest, srcPrefix) {
  const assets = manifest.assets || [];
  const groups = [];
  for (const a of assets) if (!groups.includes(a.group)) groups.push(a.group);
  const sections = groups.map((g) => {
    const inG = assets.filter((a) => a.group === g);
    const items = inG.map((a) => `<figure class="asset"><div class="assetimg"><img loading="lazy" src="${srcPrefix}${esc(a.file)}" alt="${esc(a.key)}"></div><figcaption class="acap"><b>${esc(a.key)}</b><div class="muted">${esc(a.spec)}${a.bytes ? ` · ${Math.round(a.bytes / 1024)} KB` : ""}</div><div class="trig">${esc(a.usage || "")}</div></figcaption></figure>`).join("");
    return `<h2>${esc(g)} <span class="muted">(${inG.length})</span></h2><div class="assets">${items}</div>`;
  }).join("");
  const swatches = (manifest.colors || []).map((c) => `<span class="swatch"><i style="background:${esc(c.hex)}"></i> ${esc(c.name)} <code>${esc(c.hex)}</code></span>`).join("");
  const previews = manifest.meta ? renderLinkPreviews(manifest.meta, manifest.warnings || [], `${srcPrefix}og.png`) : "";
  return `${previews}<h2>Raw assets</h2>${swatches ? `<div class="swatches">${swatches}</div>` : ""}${sections}`;
}

async function buildRun(run, project, seq) {
  const s = run.summary || {};
  const mscreens = run.manifest?.screens || [];
  // devices from manifest; legacy single-device runs use a flat "" device.
  const devs = (run.manifest?.devices && run.manifest.devices.length) ? run.manifest.devices : [{ name: "", label: "screens" }];

  // Per-device assets (video filename is hashed; emails vary), for the JS swapper.
  const SUB = {}, VIDEOS = {}, EMAILS = {};
  for (const d of devs) {
    const sub = d.name ? d.name + "/" : "";
    SUB[d.name] = sub;
    const vfiles = await readdir(join(run.dir, "video", d.name)).catch(() => []);
    const vid = vfiles.find((f) => f.endsWith(".mp4")) || vfiles.find((f) => f.endsWith(".webm")); // prefer mp4 (Safari)
    const mails = (await readdir(join(run.dir, "emails", d.name)).catch(() => [])).filter((f) => f.endsWith(".png")).sort();
    VIDEOS[d.name] = vid ? `video/${sub}${vid}` : null;
    EMAILS[d.name] = mails.map((f) => `emails/${sub}${f}`);
  }
  const def = devs[0].name;

  // Directional canvas layout: col → x (left-to-right journey), row → y (depth).
  const GX = 90, GY = 60, PAD = 20, CAP = 40, R = 14;
  const cardWidthFor = (vw) => (vw >= 1000 ? 500 : 300); // wide viewports (desktop) get a roomier frame

  // Variants let ONE run capture the same routes in multiple states (e.g.
  // zero-state vs seeded "dummy data"). Screens with no variant fall under
  // "Zero state"; the gallery shows a toggle when there's more than one.
  const variantOf = (sc) => sc.variant || "Zero state";
  const groupOf = (sc) => sc.group || "__ungrouped__";
  const variants = [];
  for (const sc of mscreens) { const v = variantOf(sc); if (!variants.includes(v)) variants.push(v); }
  // A run with zero screens (e.g. a failed run with an empty/missing manifest)
  // would otherwise leave `variants` empty → no layout → crash. Keep one empty
  // variant so the run still renders (empty Screens canvas; video/emails/social
  // tabs unaffected) instead of being dropped.
  if (!variants.length) variants.push("Zero state");
  const groups = [];
  for (const sc of mscreens) { const g = groupOf(sc); if (!groups.includes(g)) groups.push(g); }
  if (!groups.length) groups.push("__ungrouped__");
  if (groups.length > 1 && groups.includes("__ungrouped__")) {
    groups.splice(groups.indexOf("__ungrouped__"), 1);
    groups.push("__ungrouped__");
  }
  const hasExplicitGroups = groups.some((g) => g !== "__ungrouped__");
  const idxsByVariantGroup = {};
  for (const v of variants) {
    idxsByVariantGroup[v] = {};
    for (const g of groups) idxsByVariantGroup[v][g] = mscreens
      .map((sc, i) => [variantOf(sc), groupOf(sc), i])
      .filter(([vv, gg]) => vv === v && gg === g)
      .map(([, , i]) => i);
  }
  const gindexOf = [];
  { const c = {}; mscreens.forEach((sc, i) => { const k = `${variantOf(sc)}\0${groupOf(sc)}`; gindexOf[i] = c[k] || 0; c[k] = (c[k] || 0) + 1; }); }
  const firstV = variants[0];

  // Per-(device, variant) layout: frame aspect = that device's capture viewport,
  // so the card SHAPE matches the device. Each variant lays out from its OWN
  // origin (cols/rows normalized) so it isn't offset by the other variants' cols.
  const layoutFor = (vw, vh, idxs, grouped) => {
    const Wd = cardWidthFor(vw);
    const frameH = Math.round(Wd * (vh / vw));
    const cardH = frameH + CAP;
    // A bad/missing flow coordinate must never hide a screen under another.
    // Preserve explicit placement where possible, move collisions downward,
    // and collect unplaced captures in their own lane to the right.
    const explicitCols = idxs.map((i) => mscreens[i].flow?.col).filter(Number.isFinite);
    const unplacedCol = (explicitCols.length ? Math.max(...explicitCols) : -1) + 1;
    const occupied = new Set();
    const resolved = new Map();
    let unplacedRow = 0;
    for (const i of idxs) {
      const flow = mscreens[i].flow;
      const col = Number.isFinite(flow?.col) ? flow.col : unplacedCol;
      let row = Number.isFinite(flow?.row) ? flow.row : unplacedRow++;
      while (occupied.has(`${col},${row}`)) row++;
      occupied.add(`${col},${row}`);
      resolved.set(i, { col, row });
    }
    const cols = idxs.map((i) => resolved.get(i).col);
    const rows = idxs.map((i) => resolved.get(i).row);
    const minCol = idxs.length ? Math.min(...cols) : 0;
    const minRow = idxs.length ? Math.min(...rows) : 0;
    const flowOf = (i) => {
      const flow = resolved.get(i) || { col: 0, row: 0 };
      return { col: flow.col - minCol, row: flow.row - minRow };
    };
    const pos = idxs.map((i) => { const f = flowOf(i); return [PAD + f.col * (Wd + GX), PAD + f.row * (cardH + GY)]; });
    const cw = (pos.length ? Math.max(...pos.map((p) => p[0] + Wd)) : Wd) + PAD;
    const ch = (pos.length ? Math.max(...pos.map((p) => p[1] + cardH)) : cardH) + PAD;
    let arrows = "";
    const seq = grouped ? idxs.map((i, k) => mscreens[i].flow ? k : -1).filter((k) => k >= 0) : pos.map((_, k) => k);
    for (let k = 0; k < seq.length - 1; k++) {
      const ai = seq[k], bi = seq[k + 1];
      const a = { x: pos[ai][0], y: pos[ai][1] }, b = { x: pos[bi][0], y: pos[bi][1] };
      const ac = flowOf(idxs[ai]), bc = flowOf(idxs[bi]);
      let d;
      if (bc.row === ac.row && bc.col > ac.col) { const y = a.y + frameH / 2; d = `M${a.x + Wd} ${y} H${b.x}`; }
      else if (bc.col === ac.col && bc.row > ac.row) { const x = a.x + Wd / 2; d = `M${x} ${a.y + cardH} V${b.y}`; }
      else if (b.x > a.x) { const sx = a.x + Wd, sy = a.y + frameH / 2, ex = b.x, ey = b.y + frameH / 2, mx = (sx + ex) / 2, dir = ey > sy ? 1 : -1; d = `M${sx} ${sy} H${mx - R} Q${mx} ${sy} ${mx} ${sy + dir * R} V${ey - dir * R} Q${mx} ${ey} ${mx + R} ${ey} H${ex}`; }
      else { d = `M${a.x + Wd / 2} ${a.y + frameH / 2} L${b.x + Wd / 2} ${b.y + frameH / 2}`; }
      arrows += `<path d="${d}" marker-end="url(#ah)"/>`;
    }
    return { cardW: Wd, frameH, cardH, cw, ch, pos, arrows };
  };
  const layouts = {};
  for (const d of devs) {
    const vp = d.viewport || { width: 393, height: 660 };
    layouts[d.name] = {};
    for (const v of variants) {
      layouts[d.name][v] = {};
      for (const g of groups) layouts[d.name][v][g] = layoutFor(
        vp.width, vp.height, idxsByVariantGroup[v][g], hasExplicitGroups
      );
    }
  }
  const cardsByGroup = {};
  for (const g of groups) cardsByGroup[g] = [];
  mscreens.forEach((sc, i) => {
    const v = variantOf(sc), g = groupOf(sc), gi = gindexOf[i];
    const lay = layouts[def][v][g];
    const p = lay.pos[gi] || [0, 0];
    const hidden = v !== firstV;
    const src = `screens/${esc(SUB[def])}${esc(sc.label)}.png`;
    const more = [sc.state && `state: ${esc(sc.state)}`, sc.group && `group: ${esc(sc.group)}`, sc.role && `role: ${esc(sc.role)}`, sc.stage && `stage: ${esc(sc.stage)}`, sc.variant && `variant: ${esc(sc.variant)}`, sc.note && esc(sc.note), sc.flow && `flow: ${sc.flow.col},${sc.flow.row}`].filter(Boolean).join("<br>");
    cardsByGroup[g].push(`<figure class="ncard" data-variant="${esc(v)}" data-group="${esc(g)}" data-gindex="${gi}" data-role="${esc(sc.role || "")}" data-stage="${esc(sc.stage || "")}" style="left:${p[0]}px;top:${p[1]}px;width:${lay.cardW}px${hidden ? ";display:none" : ""}">
      <div class="nwrap"><div class="nframe" style="height:${lay.frameH}px"><img class="shot" loading="lazy" data-label="${esc(sc.label)}" src="${src}"></div><div class="nfade"></div></div>
      <figcaption class="ncap"><details><summary><b><span class="stepno">${esc(String(sc.idx ?? i).padStart(2, "0"))}</span>${esc(sc.route || sc.label)}</b> <span class="dim">${esc(sc.state || "")}</span></summary><div class="more">${more}<br><a class="open shotlink" data-label="${esc(sc.label)}" href="${src}" target="_blank">open full ↗</a></div></details></figcaption>
    </figure>`);
  });
  const groupSections = groups.map((g) => {
    const L = layouts[def][firstV][g];
    const title = g === "__ungrouped__" ? "Other" : g;
    const heading = hasExplicitGroups ? `<h2>${esc(title)}</h2>` : "";
    return `<section class="groupsection" data-group="${esc(g)}">${heading}<div class="canvas" style="width:${L.cw}px;height:${L.ch}px">
      <svg class="arrows" width="${L.cw}" height="${L.ch}"><defs><marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#297041"/></marker></defs><g class="arrowpaths">${L.arrows}</g></svg>
      ${cardsByGroup[g].join("")}
    </div></section>`;
  }).join("");

  const socialManifest = await readJSON(join(run.dir, "social", "manifest.json"));
  const ctx = [s.appVersion && `app v${esc(s.appVersion)}`, s.gitBranch && esc(s.gitBranch), s.gitCommit && `<code>${esc(s.gitCommit)}</code>`, s.qaVersion && `captured by qa v${esc(s.qaVersion)}`].filter(Boolean).join(" · ");
  const badge = s.ok ? `<span class="badge ok">✓ ok</span>` : `<span class="badge fail">✗ ${(s.failures || []).length} failure(s)</span>`;
  const deviceOpts = devs.map((d) => `<option value="${esc(d.name)}">${esc(d.label)}${d.viewport ? ` (${d.viewport.width}×${d.viewport.height})` : ""}</option>`).join("");

  const runName = seq ? `${fmtDate(runDate(run))} · #${seq}` : fmtDate(runDate(run));
  // Breadcrumb = plain text of the current mode (set by JS); the run-name crumb
  // returns to run home, where cards link into Screens/Video/Emails. The device
  // picker rides in the breadcrumb and is hidden on the home view.
  const variantToggle = variants.length > 1
    ? `<span id="varwrap" class="dsel" style="display:none"> · <span class="views">${variants.map((v, i) => `<button class="vt${i === 0 ? " active" : ""}" data-variant="${esc(v)}">${esc(v)}</button>`).join("")}</span></span>`
    : "";
  const roles = [...new Set(mscreens.map((sc) => sc.role).filter(Boolean))];
  const stages = [...new Set(mscreens.map((sc) => sc.stage).filter(Boolean))];
  const available = Object.fromEntries(variants.map((v) => {
    const screens = mscreens.filter((sc) => variantOf(sc) === v);
    return [v, {
      roles: [...new Set(screens.map((sc) => sc.role).filter(Boolean))],
      stages: [...new Set(screens.map((sc) => sc.stage).filter(Boolean))],
    }];
  }));
  const filterSelect = (id, label, values) => values.length
    ? `<span id="${id}wrap" class="dsel" style="display:none"> · ${label} <select id="${id}"><option>All</option>${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}</select></span>`
    : "";
  const navHtml = `<a href="${link("/")}">runshot</a><span class="sep">›</span>${project ? `<a href="${esc(appUrl(project))}">${esc(project)}</a><span class="sep">›</span>` : ""}<a href="./">${esc(runName)}</a><span id="modecrumb"></span><span id="devwrap" class="dsel" style="display:none"> · Device <select id="device">${deviceOpts}</select></span>${variantToggle}${filterSelect("role", "Role", roles)}${filterSelect("stage", "Stage", stages)}`;
  const body = `
    <div id="tab-home" class="tab">
      <p style="margin-top:4px">${badge} <span class="muted">${devs.length} device(s) · ${mscreens.length} screens/device · ${s.emailsFound ?? "?"}/${s.emailsExpected ?? "?"} emails · mode ${esc(s.mode || "?")}</span></p>
      <p class="muted">${esc(run.name)}${ctx ? " · " + ctx : ""}</p>
      <div class="homelinks">
        <button class="homecard" data-tab="screens"><b>Screens →</b><span class="muted">${mscreens.length}-screen flow canvas${hasExplicitGroups ? ` · ${groups.length} groups` : ""}${variants.length > 1 ? ` · ${variants.length} variants (${variants.map((v) => `${Object.values(idxsByVariantGroup[v]).flat().length} ${esc(v)}`).join(" + ")})` : ""}</span></button>
        <button class="homecard" data-tab="video"><b>Video →</b><span class="muted">full session recording</span></button>
        <button class="homecard" data-tab="emails"><b>Emails →</b><span class="muted">captured emails</span></button>
        ${socialManifest ? `<button class="homecard" data-tab="social"><b>Social →</b><span class="muted">${(socialManifest.assets || []).length} OG / icon / brand assets</span></button>` : ""}
      </div>
    </div>
    <div id="tab-screens" class="tab"><div class="canvaswrap">${groupSections}</div></div>
    <div id="tab-video" class="tab"><video id="vid" controls preload="metadata"></video></div>
    <div id="tab-emails" class="tab">${project ? `<p class="muted">Emails captured during this run. <a href="${link(`/${project}/emails`)}">📧 View all branded email templates →</a></p>` : ""}<div id="emailwrap" class="grid"></div></div>
    <div id="tab-social" class="tab">${socialManifest ? renderSocial(socialManifest, "social/") : '<p class="muted">No social assets captured for this run.</p>'}</div>
    ${RUN_JS(JSON.stringify({ sub: SUB, videos: VIDEOS, emails: EMAILS, layouts, variants, available }))}`;
  await writeFile(join(run.dir, "index.html"), PAGE(runName, body, navHtml), "utf8");
}

async function buildProject(project, artRoot) {
  const runs = await listRuns(artRoot);
  // Stable sequential #1.. in chronological order (oldest first) — the run's primary name.
  const runsAsc = [...runs].sort((a, b) => a.name.localeCompare(b.name));
  const seqOf = new Map(runsAsc.map((r, i) => [r.name, i + 1]));
  // Prefer the run's own stable runNumber (never reused); fall back to ordinal.
  const numOf = (r) => r.summary?.runNumber ?? seqOf.get(r.name);
  for (const r of runs) {
    try { await buildRun(r, project, numOf(r)); }
    catch (e) { console.warn(`runshot gallery: skipping run ${r.name} — ${e.message}`); }
  }
  const rows = runs.map((r) => {
    const s = r.summary || {};
    const d = runDate(r);
    const seq = numOf(r);
    const ok = !!s.ok;
    const screens = s.stepsRun ?? 0;
    const ef = s.emailsFound ?? 0, ee = s.emailsExpected ?? 0;
    return `<tr>
      <td class="num" data-sort="${seq}"><a href="${esc(r.name)}/index.html"><b>#${seq}</b></a></td>
      <td data-sort="${ok ? 1 : 0}"><span class="badge ${ok ? "ok" : "fail"}">${ok ? "ok" : "fail"}</span></td>
      <td data-sort="${d ? +d : 0}"><a href="${esc(r.name)}/index.html">${esc(fmtET(d))}</a></td>
      <td class="num" data-sort="${screens}">${esc(screens)}</td>
      <td class="num" data-sort="${ef}">${esc(`${ef}/${ee}`)}</td>
      <td data-sort="${esc(s.appVersion || "")}">${s.appVersion ? "v" + esc(s.appVersion) : "—"}</td>
      <td data-sort="${esc(s.gitBranch || "")}">${esc(s.gitBranch || "—")}</td>
      <td data-sort="${esc(s.gitCommit || "")}">${s.gitCommit ? `<code>${esc(s.gitCommit)}</code>` : "—"}</td>
      <td class="delcol"><button class="del" data-run="${esc(r.name)}" title="Delete this run">🗑</button></td>
    </tr>`;
  }).join("");
  const body = `<div class="pagehead"><h1>${esc(project)} — walkthrough runs</h1>
    <p class="muted sub">${runs.length} run(s) · times in US Eastern · click a column header to sort · <a href="${link("/")}">← all projects</a></p></div>
    <table id="runs"><thead><tr>
      <th class="num">#</th><th>Status</th><th>Date / Time (ET)</th><th class="num">Screens</th><th class="num">Emails</th><th>Version</th><th>Branch</th><th>Commit</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>
    ${SORT_JS}${DEL_JS}`;
  await writeFile(join(artRoot, "index.html"), PAGE(`${project} runs`, body, [{ label: "runshot", href: withBasePath("/") }, { label: project }]), "utf8");
  return runs;
}

async function listProjects() {
  const entries = await readdir(BASE, { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const artRoot = artRootOf(e.name);
    if (await exists(artRoot)) projects.push(e.name);
  }
  return projects.sort();
}

// Per-project catalog of app email templates, grouped by series, each rendered
// in an iframe (preserving the email's own inline styles) with its trigger + when.
async function buildEmailsPage(project) {
  const root = emailRootOf(project);
  const manifest = await readJSON(join(root, "manifest.json"));
  if (!manifest) return null;
  const tps = manifest.templates || [];
  const series = [];
  for (const t of tps) if (!series.includes(t.series)) series.push(t.series);
  const sections = series.map((sname) => {
    const inSeries = tps.filter((t) => t.series === sname);
    const items = inSeries.map((t) => `
      <figure class="mail">
        <figcaption class="mailcap">
          <b>${esc(t.key)}</b>
          <div class="muted">Subject: ${esc(t.subject)}</div>
          <div class="trig">${esc(t.when)}<br><span class="pill">${esc(t.trigger)}</span></div>
        </figcaption>
        <iframe loading="lazy" src="${link(`/${project}/emails/${t.file}`)}"></iframe>
      </figure>`).join("");
    return `<h2>${esc(sname)} <span class="muted">(${inSeries.length})</span></h2><div class="mails">${items}</div>`;
  }).join("");
  const body = `<div class="pagehead"><h1>${esc(project)} — email templates</h1>
    <p class="muted sub">${tps.length} templates from <code>lib/emails.ts</code> · grouped by series · <a href="${esc(appUrl(project))}">← runs</a> · <a href="${link("/")}">all projects</a></p></div>
    ${sections}`;
  return PAGE(`${project} emails`, body, [{ label: "runshot", href: withBasePath("/") }, { label: project, href: appUrl(project) }, { label: "Email templates" }]);
}

async function buildHub() {
  const projects = await listProjects();
  const items = [];
  for (const p of projects) {
    const runs = await listRuns(artRootOf(p));
    if (!runs.length) continue;
    const latest = runs[0];
    const s = latest.summary || {};
    const badge = s.ok ? `<span class="badge ok">ok</span>` : `<span class="badge fail">fail</span>`;
    items.push(`<li>${badge} <a href="${esc(appUrl(p))}">${esc(p)}</a> <span class="muted">— ${runs.length} run(s) · latest ${esc(fmtET(runDate(latest)))}</span></li>`);
  }
  const body = `<div class="pagehead"><h1>runshot</h1>
    <p class="muted sub">${items.length} project(s) under ${esc(BASE)}</p></div>
    <ul class="runs">${items.join("") || "<li class='muted'>No projects with runshot/artifacts yet.</li>"}</ul>`;
  return PAGE("runshot", body, [{ label: "runshot" }]);
}

// ---------- run ----------
if (!serve) {
  const projects = await listProjects();
  for (const p of projects) { const runs = await buildProject(p, artRootOf(p)); console.log(`  ${p}: ${runs.length} run(s)`); }
  console.log(`Built galleries for ${projects.length} project(s) under ${BASE}`);
} else {
  // build everything once up front
  for (const p of await listProjects()) await buildProject(p, artRootOf(p));
  const MIME = { ".html": "text/html", ".png": "image/png", ".webm": "video/webm", ".mp4": "video/mp4", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
  const send = (res, code, body, type = "text/plain") => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
  const server = createServer(async (req, res) => {
    try {
      const rawPath = decodeURIComponent(req.url.split("?")[0]);
      // Strip the configured BASE_PATH so the rest of the router works in terms
      // of internal, root-relative paths regardless of how runshot is mounted.
      const urlPath = stripBasePath(rawPath);
      if (urlPath === null) return send(res, 404, `not found: ${rawPath}`);
      // Health check (smoke-testable under any base path: /<base>/api/health).
      if (urlPath === "/api/health" || urlPath === "/api/health/") {
        return send(res, 200, JSON.stringify({ ok: true, service: "runshot", version: VERSION, basePath: getBasePath() || "/" }), "application/json");
      }
      const segs = urlPath.split("/").filter(Boolean);
      if (segs.length === 0) return send(res, 200, await buildHub(), "text/html");
      const project = segs[0];
      const artRoot = artRootOf(project);
      const emailRoot = emailRootOf(project);
      if (!(await exists(artRoot)) && !(await exists(emailRoot))) return send(res, 404, `no such project: ${project}`);
      // Delete a run: POST /<project>/<run>?delete=1
      if (req.method === "POST" && new URLSearchParams(req.url.split("?")[1] || "").get("delete") === "1") {
        const runName = segs.slice(1).join("/").replace(/\/+$/, "");
        const target = join(artRoot, runName);
        if (runName && target.startsWith(artRoot + "/") && (await exists(target))) {
          await rm(target, { recursive: true, force: true });
          return send(res, 200, "deleted");
        }
        return send(res, 404, "no such run");
      }
      if (segs[1] === "emails") {
        const rest2 = segs.slice(2).join("/");
        if (rest2 === "") { const html = await buildEmailsPage(project); return html ? send(res, 200, html, "text/html") : send(res, 404, "no email templates"); }
        const full2 = join(emailRoot, rest2);
        if (!full2.startsWith(emailRoot)) return send(res, 403, "nope");
        return streamFile(req, res, full2, MIME);
      }
      const rest = segs.slice(1).join("/").replace(/\/+$/, "");
      let target = rest ? join(artRoot, rest) : join(artRoot, "index.html");
      if (!target.startsWith(artRoot)) return send(res, 403, "nope");
      // A directory URL (project root or a run dir) → its index.html.
      try { if ((await stat(target)).isDirectory()) target = join(target, "index.html"); } catch { /* may not exist yet — buildProject creates it */ }
      if (target.endsWith("index.html")) await buildProject(project, artRoot); // rebuild fresh
      return streamFile(req, res, target, MIME);
    } catch (e) { send(res, 500, String(e)); }
  });
  // If the port is taken, fail loudly and exit — never silently pick another port.
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`runshot: port ${PORT} is already in use — refusing to fall back to another port.`);
      console.error(`  Free port ${PORT}, or pick one explicitly:  PORT=<port> runshot serve   (or --port <port>)`);
    } else {
      console.error(`runshot: failed to start server: ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const basePath = getBasePath();
    console.log(`Runshot listening locally at http://127.0.0.1:${PORT}${basePath}`);
    if (PUBLIC_BASE_URL) console.log(`Public URL: ${PUBLIC_BASE_URL}`);
    console.log(`Base path: ${basePath || "/"}`);
    console.log(`  serving ${BASE}/*/runshot/artifacts  (bound to ${HOST}; also reachable on this host's LAN address; project path = repo folder name)`);
  });
}

async function streamFile(req, res, full, MIME) {
  let st;
  try { st = await stat(full); } catch { res.writeHead(404); return res.end("not found"); }
  if (st.isDirectory()) { full = join(full, "index.html"); try { st = await stat(full); } catch { res.writeHead(404); return res.end("not found"); } }
  const type = MIME[full.slice(full.lastIndexOf("."))] || "application/octet-stream";
  // HTML is rebuilt every request — never let the browser cache it (Safari clings
  // to stale pages with mere no-cache). Assets revalidate.
  const cc = type === "text/html" ? "no-store, max-age=0, must-revalidate" : "no-cache";
  const onErr = (rs) => rs.on("error", () => { try { res.end(); } catch { /* already closed */ } });
  // Range support — Safari/WebKit requires 206 byte-range responses to play <video>.
  const range = req && req.headers && req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= st.size) end = st.size - 1;
    if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1, "Cache-Control": cc });
    return onErr(createReadStream(full, { start, end })).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": st.size, "Cache-Control": cc });
  return onErr(createReadStream(full)).pipe(res);
}
