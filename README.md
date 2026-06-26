# platform-crons

The capture engine. Cron code that queries Terra (phoenix-1) directly and writes
to the platform's data repos. Shared and tenant-agnostic — a cron takes a tenant
ID and writes to that tenant's repo, so onboarding a new collection is config,
not new code.

## Writes to
- `tla-core/`   — shared TLA ecosystem data
- `nft-<tenant>/` — per-collection NFT data
- `dao-<tenant>/` — per-DAO governance & treasury data

## Conventions
- One folder per domain cron; output follows the `module / product / files`
  layout (see `tla-core`).
- Each cron writes a `heartbeat.json` for health monitoring.
- Tokens are scoped per data repo (least privilege). Never commit credentials.
