# Security

## Scope

This is an unofficial WhatsApp Web client. It is not affiliated with WhatsApp or Meta. Using it may violate Meta's Terms of Service and can result in account suspension. Use a test number.

## Secrets and session material

Never commit:

- QR payloads or QR screenshots that contain a live payload;
- `sessions/`, `results/`, cookies, localStorage, IndexedDB dumps;
- `.env`, API keys, private keys;
- `/tmp/ObscuraWA-state.json` after login (it may contain chat/message text).

`results/`, `sessions/`, `vendor/`, `node_modules/`, `.env`, and `*.log` are gitignored. Verify with `git status --short` before committing.

## Local UI

`spike/34-qr-ui.mjs` binds to `127.0.0.1` only and serves:

- the QR PNG;
- a JSON status with page flags and WebSocket frame counters;
- the login screenshot after pairing.

Do not expose it on a public interface. It has no authentication and is intended for a single local operator.

## Session storage

Obscura persists cookies and localStorage; IndexedDB is in-memory and lost on restart. Treat the storage directory as credential material: restrict permissions, do not back it up to shared storage, and delete it when decommissioning a tenant.

## Reporting

Open a private security advisory or contact the maintainer. Do not include live QR payloads, session files, or phone numbers in reports.
