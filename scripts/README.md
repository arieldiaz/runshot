# runshot

**One-shot a complete visual record of any web app** — every screen, email, and
social/link preview, plus a video — laid out as a browsable flow canvas
(Figma export optional).

## Quick start (npx)

```bash
npx runshot setup                                       # one-time: install Chromium
npx runshot record --config ./runshot/skills.config.json
npx runshot serve                                       # browse captured runs at :8080
```

`runshot assert` is the same capture but exits non-zero on failure — use it as a
CI gate. Config defaults to `./runshot/skills.config.json`.

## Hosting & base path

`runshot serve` runs a hub at `:8080` that lists every project under
`~/github/*/runshot/artifacts` and serves each one under its folder name. It can
be mounted at the root or under a sub-path via environment variables (see
[`.env.example`](.env.example)):

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port to bind. Fails loudly if busy — never auto-increments. |
| `HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` when behind a reverse proxy). |
| `BASE_PATH` | `/` | URL prefix. `/` = root; `/runshot` = mount everything under `/runshot`. |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Canonical external URL, including the base path. |

All internal links, redirects, asset paths, and API calls respect `BASE_PATH`, so
clicking an app card stays under the prefix (e.g. `/runshot/heirlooming/` instead
of escaping to `/heirlooming/`). A health endpoint is served at
`<base>/api/health`.

### Examples

```bash
# Local dev (root)
PORT=8080 HOST=0.0.0.0 BASE_PATH=/ PUBLIC_BASE_URL=http://localhost:8080 \
  npx runshot serve

# Local network — same as dev; HOST=0.0.0.0 already exposes it on the LAN
#   http://your-machine.local:8080  /  http://192.168.x.x:8080

# Tailscale path mode (https://your-machine.your-tailnet.ts.net/runshot)
PORT=8080 HOST=0.0.0.0 BASE_PATH=/runshot \
  PUBLIC_BASE_URL=https://your-machine.your-tailnet.ts.net/runshot \
  npx runshot serve

# Caddy subdomain mode (https://runshot.example.com) — bind localhost, root path
PORT=8080 HOST=127.0.0.1 BASE_PATH=/ PUBLIC_BASE_URL=https://runshot.example.com \
  npx runshot serve
```

On startup runshot logs the local URL, the public URL, and the active base path.

Smoke test the base-path behavior with `npm test` (or `node test/smoke.mjs`).

Also available as a **Claude Code plugin** (skills `runshot:walkthrough` and
`runshot:flow-doc`). Full docs, config reference, and source:
**https://github.com/arieldiaz/runshot**

## License

[MIT](LICENSE).
