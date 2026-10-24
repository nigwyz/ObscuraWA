# Contributing

## Setup

```bash
pnpm install
node --check spike/33-qr-live-cdp.mjs
```

Obscura binary: set `OBSCURA_BIN` or use the default
`/home/hp/.local/share/obscurawa/bin/obscura`.

## Running the QR path

```bash
KEEPALIVE_MS=1800000 node spike/33-qr-live-cdp.mjs
UI_PORT=8787 node spike/34-qr-ui.mjs
```

Open `http://127.0.0.1:8787/`. The QR refreshes every second. The UI and state files live in `/tmp` and are not source.

## Evidence rules

- Never commit QR payloads, cookies, `sessions/`, `results/`, or `.env`.
- Only log frame **lengths/directions**, not payloads.
- Put reproductions in `spike/`, results in `results/` (gitignored).
- Delete `/tmp/ObscuraWA-*` state when it contains post-login page text.

## Commits

Use `type(scope): imperative summary`:

```
feat(spike): add raw CDP QR path
fix(bridge): handle post-pairing close frames
perf(engine): keep idle PSS flat with periodic GC
docs(adr): record backend architecture
test(memory): add PSS regression gate
chore(repo): organize ADRs
```

One logical change per commit. The body explains why, evidence, and verification. Do not squash the milestone commits; they document the feasibility path.

## Code style

- ESM `.mjs` for spike scripts, 2-space indent, single quotes.
- Keep diagnostic wrappers separate from the production bridge (`wa-diag.js` vs `wa-bridge.js`).
- Prefer raw CDP over Puppeteer for new paths.
- Any Rust crate must pass `cargo fmt --check` and `cargo clippy -- -D warnings` once the workspace exists.

## Docs

Architecture decisions go in `docs/adr/`, numbered. If a decision is reversed, mark the old ADR **Superseded** and link the new one; do not rewrite historical evidence.

## Review checklist

- QR still renders.
- No worker/page errors.
- PSS after GC within the current budget (see `docs/operations/memory.md`).
- No secrets in the diff.
- Commit message scoped and accurate.
