# Obscura engine patches

Obscura's IndexedDB is in-memory in the released engine, so a WhatsApp session
cannot survive an engine restart. `0001-disk-backed-indexeddb.patch` adds a
JSON snapshot at `{storage-dir}/indexeddb.json`:

- loads the snapshot when the browser context is created;
- marks the store dirty on `open_ready`, `commit` and `delete`;
- flushes every two seconds from a weak-reference thread;
- flushes on `BrowserContext::save_storage` and on drop;
- raises the old 64 MB cap to 256 MB.

## Apply and build

The patch targets upstream commit `8b3dd47` (`obscura 0.1.0-dev`). The released
binary in `~/.local/share/obscurawa/bin` is 0.2.5 and does **not** include it.

```bash
scripts/build-obscura.sh
export OBSCURA_BIN="$PWD/vendor/obscura/target/release/obscura"
```

The script clones `h4ckf0r0day/obscura` into `vendor/obscura` if needed, applies
the patch once, and builds the CLI with the render feature required for
`Page.captureScreenshot`.

## Verify

```bash
OBSCURA_BIN="$PWD/vendor/obscura/target/release/obscura" \
  node spike/38-idb-persistence.mjs
```

Expected: `snapshot: ... bytes, exists=true`, `read after restart:
{"hello":"world","n":42}`, `result: PASS`.

## Notes

- The snapshot is a full JSON write, not an incremental log. It is simple and
  crash-safe (temp file + rename), but a large WhatsApp history will make each
  flush heavier. A redb-backed store is the next step.
- Do not commit `vendor/` or the built binary. The patch is the source of truth.
- The patch is a local fork of Apache-2.0 code; keep the upstream license and
  attribution when redistributing the binary.
