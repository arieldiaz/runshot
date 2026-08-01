# Changelog

Notable changes to runshot. The version is set manually and kept in sync across
`scripts/package.json` and `.claude-plugin/plugin.json`.

## 0.1.20

### Added
- **Layer 2 social previews — `social.shareUrls`.** Verify that REAL share links
  unfurl end-to-end, not just that pre-supplied OG art renders. For each
  `{ label, url }` (absolute `https://…/<slug>` or `baseUrl`-relative `/<slug>`),
  runshot fetches the live page, parses **its** `<head>` for
  `og:title` / `og:description` / `og:image` / `twitter:card`, resolves + fetches
  **its** `og:image`, and renders the true per-platform unfurl (iMessage / WhatsApp
  / X / Facebook / Slack) from the actual parsed tags. It flags the blank-preview
  class of bug **loudly** — a missing `og:image`, a non-absolute image URL, a 404
  image, or a missing title fail the run (gating `assert`/CI); soft gotchas
  (no `twitter:card`, off-aspect or oversized image, …) render as amber warnings.
  This catches the case where a naked-slug link resolves 200 but previews blank.
- `scripts/social.mjs` — the OG/social capture layer (both passes), extracted from
  the Playwright flow so it's testable without a browser.
- `test/shareurls.mjs` — fixture-based test covering every unfurl outcome (good /
  relative / missing / 404 / absolute-form) plus the gallery render; wired into
  `npm test`.

### Changed
- Gallery **Social** tab renders the real share-link previews above the existing
  homepage reference preview, each with an ok/problem badge and a loud red problems
  banner. The `social.assets` card-art pass is unchanged and fully backward
  compatible. Added `jpg`/`jpeg`/`webp` to the gallery's served MIME types (an
  `og:image` isn't always PNG).
