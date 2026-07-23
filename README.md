`npm install -g runshot`

# runshot

Builders shipping fast with AI can push code faster than ever — seeing what got
built still means clicking through every flow by hand. Runshot closes that gap.

Run one command and get a complete visual record of **any** web app: every screen
(including zero-states), every email the flow triggers, a video walkthrough, and a
browsable **flow canvas** (one frame per screen, in flow order). One config per app;
nothing hard-coded. Two modes: a human-reviewable QA artifact (`record`) and a
deterministic CI gate (`assert`).

> **Flow output:** every run renders a phone-framed flow canvas in the gallery,
> with screens laid out in flow order and arrows between them — no extra tooling or
> accounts required. Optional Figma export is available via the `flow-doc` skill.

The engine is config-driven, so the same procedure works for every app — the
per-app specifics live in that app's `runshot/skills.config.json`. Nothing about the
target app is hard-coded.

## Two skills

| Skill | What it does |
|-------|--------------|
| `walkthrough` | Drives the onboarding flow, records video + per-screen screenshots, captures emails, writes `manifest.json` + `summary.json`. Explicit-invoke only (creates real accounts/emails). |
| `flow-doc` | **Optional Figma export.** Consumes a `walkthrough` run's `screens/` + `manifest.json` and builds/updates a Figma flow doc (one frame per screen, in flow order). Needs the Figma MCP **write** path. Use it only when you specifically want the flow in Figma — the gallery already renders a flow canvas with no skill required. |

## Layout

```
runshot/
├── .claude-plugin/plugin.json
├── skills/
│   ├── walkthrough/SKILL.md
│   └── flow-doc/SKILL.md
├── scripts/
│   ├── walkthrough.mjs        # the engine (Playwright)
│   ├── gallery.mjs            # browsable HTML hub for artifacts (multi-project)
│   ├── urls.mjs               # central base-path / URL helper for the hub
│   └── package.json
├── site/                      # static about page (Cloudflare Pages → runshot.org)
└── templates/app-repo/        # copy these INTO each app repo
    ├── runshot/skills.config.json
    └── .github/workflows/runshot.yml
```

## Setup (once per machine)

```bash
cd scripts
npm install
npx playwright install chromium
```

## Onboard a new app

1. Copy `templates/app-repo/runshot/skills.config.json` into the app repo at
   `runshot/skills.config.json` and fill in `baseUrl`, the `steps`, and selectors.
   (The template's `_`-prefixed keys are inline docs — delete them when done.)
2. Make sure the app is running and reachable at `baseUrl`.
3. Run it:
   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/walkthrough.mjs" \
     --config ./runshot/skills.config.json --mode record
   ```
   (Inside Claude Code, `$CLAUDE_PLUGIN_ROOT` is set for you; from a raw shell,
   point at this plugin's `scripts/walkthrough.mjs`.)
4. Artifacts land in `runshot/artifacts/<timestamp>/`: `video/*.webm`,
   `screens/NN-<route>-<state>.png`, `emails/`, `manifest.json`, `summary.json`.

## Config reference

Top level: `appName`, `baseUrl`, `device` (any Playwright device descriptor).
Under `walkthrough`:

- `outputDir` — supports `{{timestamp}}`.
- `inbucketUrl` — mail-catcher base URL (see Email capture below). Omit
  `expectedEmails` to skip capture.
- `freshIdentity` — map of tokens (e.g. `email`, `name`, `password`) interpolated
  into step values. The `{{run}}` token is a per-run slug so reruns never collide.
- `steps[]` — ordered actions, each also screenshotted:
  `goto | fill | click | waitFor | expectText | screenshot`. Props: `selector`,
  `url`, `value`, `text`, `route`, `state`, `note`, `settleMs`, `fullPage`,
  `timeoutMs`, `flow` (`{col,row}` directional-canvas position), `variant`.
- `variant` — optional tag that groups a screenshot into a named **capture pass**
  (e.g. re-shooting the same routes after seeding: `"variant": "dummy data"`).
  Screens with no `variant` fall under "Zero state". When a run has more than one
  variant, the gallery shows a toggle next to the device selector that switches
  the flow canvas between them (each variant lays out from its own origin). The
  app declares what a variant means (e.g. seeding = hitting a dev endpoint); the
  plugin only groups + toggles by the tag.
- `expectedEmails[]` — `{ mailbox, subjectMatch, timeoutMs }`; each is captured as
  HTML + screenshot.

Under `flowDoc.figma` (optional — only used by the `flow-doc` Figma export skill):
`fileKey` + `pageName` to update one Figma page in place. The gallery flow canvas
needs no config.

## Modes

- `--mode record` (default) — never throws; produces artifacts even if the flow is
  imperfect. Failures are logged in `summary.json`. **Don't call a run "passing"
  unless `summary.json.ok` is true.**
- `--mode assert` — exits non-zero on any failed step / missing expected email.
  This is the CI gate (`templates/app-repo/.github/workflows/runshot.yml`).

## Email capture (Mailpit / Inbucket)

The engine polls a mail catcher's REST API for expected messages. **Heads-up on
Supabase local dev:** recent Supabase CLI versions ship **Mailpit**, older ones
ship **Inbucket**, and their REST APIs differ. The engine currently targets the
Inbucket `GET /api/v1/mailbox/<name>` shape; against Mailpit that path 404s, so
email capture is a no-op there (screenshots are unaffected). If your local stack
is Mailpit, either point `inbucketUrl` at a real Inbucket, drop `expectedEmails`,
or add a Mailpit adapter (`GET /api/v1/messages` + `search`). Tracked as a known
gap.

## Flow canvas

Every run's **Screens** tab renders a phone-framed **flow canvas**: each screen is
laid out from its `flow:{col,row}` in `manifest.json` (col → left-to-right journey,
row → depth) with arrows drawn between consecutive screens. Zero-state and seeded
variants each get their own layout, toggled next to the device picker. No account
or extra skill required; want the same flow in Figma instead, use the optional
`flow-doc` skill.

## Browse artifacts (multi-project)

`gallery.mjs` serves a phone-framed HTML hub across **all** projects on the
machine — useful when several apps run in parallel:

```bash
node scripts/gallery.mjs --serve            # serves http://localhost:8080
node scripts/gallery.mjs --serve --base /path --port 9000
#   http://localhost:8080/         → index of all projects
#   http://localhost:8080/<repo>/  → that project's runs
```

### Port (stable, configurable, no silent fallback)

The server binds a **stable, explicit port** — it never auto-picks a random one.
Resolution order: **`--port` flag → `$PORT` → `8080`** (the default). On startup
it logs the exact URL, e.g. `runshot gallery → http://localhost:8080`.

```bash
node scripts/gallery.mjs --serve            # default: http://localhost:8080
PORT=8080 node scripts/gallery.mjs --serve  # same, via env
PORT=9000 node scripts/gallery.mjs --serve  # custom port via env
node scripts/gallery.mjs --serve --port 9000  # custom port via flag

# or keep it in a file — copy .env.example → .env (it ships with PORT=8080):
cp scripts/.env.example scripts/.env
node --env-file=scripts/.env scripts/gallery.mjs --serve
```

If port 8080 (or whatever you set) is **already in use**, runshot **fails loudly
and exits** with a clear message rather than quietly choosing another port — so
the gallery is always at the URL you expect. Free the port or pick another one
explicitly. An invalid `$PORT`/`--port` value (non-numeric, out of range, or a
bare `--port` with no value) also exits with an error instead of falling back.

### Keep it running (macOS, launchd)

To have the hub start at login and auto-restart if it crashes, install a
LaunchAgent. Save as `~/Library/LaunchAgents/com.runshot.gallery.plist`
(adjust the node path, the `gallery.mjs` path, and `--base` to your machine):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.runshot.gallery</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/runshot/scripts/gallery.mjs</string>
    <string>--serve</string><string>--base</string><string>/ABSOLUTE/PATH/TO/projects</string>
    <string>--port</string><string>8080</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/runshot-gallery.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/runshot-gallery.log</string>
</dict></plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.runshot.gallery.plist  # install + start
launchctl kickstart -k gui/$(id -u)/com.runshot.gallery                            # restart (reload code)
launchctl bootout   gui/$(id -u)/com.runshot.gallery                               # stop + uninstall
tail -f ~/Library/Logs/runshot-gallery.log                                         # logs
```

`KeepAlive` restarts it on crash; `kickstart -k` is how you reload after pulling
new gallery code (the server process loads the engine once at startup).

## Running several apps in parallel

The engine is per-app and stateless, so multiple products coexist fine — give each
its own `baseUrl` (dev port) and, for local email capture, its own mail-catcher
port. Example layout used on one machine: app A on `:3000` with Supabase
`543xx`; app B on `:3100` with Supabase `553xx`. The `runshot/skills.config.json` in
each repo points at that app's ports.

## Notes

- The `walkthrough` skill is **explicit-invoke only** — it launches a browser and
  creates a real account each run. Use plus-addressed `freshIdentity` so reruns
  don't collide. Local QA accounts are fine; never point at production.
- The flow canvas renders in the gallery by default (above). `flow-doc` is the
  **optional** Figma export — it needs the Figma MCP **write-to-canvas** path
  connected and is rate-limit sensitive. See `skills/flow-doc/SKILL.md`.

## About page (Cloudflare Pages → runshot.org)

A static landing/about page lives in [`site/`](site/) — a single self-contained
`index.html` (no build step) distilled from this README. It's wired for
**Cloudflare Pages**, which auto-deploys on every push to `main`:

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** →
   pick `arieldiaz/runshot`.
2. Build settings: **Framework preset = None**, **Build command = (empty)**,
   **Build output directory = `site`**.
3. **Custom domains** → add `runshot.org` (and `www.runshot.org`). Since the DNS is
   already on Cloudflare, the records are created for you.

After that, editing `site/index.html` and pushing to `main` redeploys the page
automatically. (The same folder also works as a GitHub Pages source if you ever
point Pages at `/site`.)

## License

[MIT](LICENSE.md) — use it freely for anything, commercial or not; just keep the
copyright notice. No warranty.
