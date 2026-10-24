# Multi-tenant notes

## Two backends, two economics

| Backend | Active cost | Idle cost | Isolation |
|---|---:|---:|---|
| `ProtocolBackend` (`whatsapp-rust`) | tens of MB | near zero | one session per tenant, SQLite |
| `ObscuraBackend` (real page) | 210–280 MB | ~0 if suspended | process per tenant |

## Obscura backend

- One OS process per tenant; `--storage-dir` per tenant.
- Strong isolation; no shared JS heap between tenants.
- Idle tenants must be **suspended**: persist storage, stop the process, restart on demand. Idle metadata should be a few MB.
- Active admission control: cap by count and PSS, not by number of tenants.
- 50 tenants × 250 MB = 12.5 GB if all active; suspend is mandatory for density.

## Protocol backend

- Many sessions can share a process; SQLite per tenant.
- Much higher density, but a shared process weakens isolation.
- For paying clients, use process-per-tenant or a cgroup boundary if hard isolation is required.

## Rules

- One backend per tenant/account. Do not pair the same phone through both; that creates two linked devices.
- Store credentials/session per tenant outside git; restrict permissions.
- Quota disk per tenant; media/history can dominate.
- Delete the storage dir on offboarding.
- Never expose the preview UI on a public interface; it has no auth.

## Targets

- Obscura engine at QR: 200–240 MB.
- Obscura total at QR: 250–280 MB.
- Idle suspended tenant: ≤10 MB metadata.
- 10 tenants / 3 active on one host as the first density gate.
