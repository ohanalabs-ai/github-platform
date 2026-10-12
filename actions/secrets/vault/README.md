# 🔑 secrets/vault

| Action | What |
|---|---|
| [`setup-config-stream`](setup-config-stream/) | create (KV `cas: 0`) or `rotate` (compare-and-set) the org's `CONFIG_STREAM_KEY` at `<kv-mount>/global/<github-host>/<org>/platform/vionix/config-stream`; optional org-secret copy via `gh secret set` (GitHub's REST API needs a libsodium sealed box — no npm here) |
| [`get-config-stream`](get-config-stream/) | read it, mask it, export env `CONFIG_STREAM_KEY` — skipped when the org-secret copy is already in the env |
| [`revoke-token`](revoke-token/) | `auth/token/revoke-self` — run `if: always()` at the end of a job that logged in |

All three need a prior `hashicorp/vault-action` login with `exportToken: true` (`VAULT_ADDR` +
`VAULT_TOKEN`; optional `VAULT_NAMESPACE`). Logic: [`lib/config-stream.ts`](lib/config-stream.ts);
tests: `node --test actions/secrets/vault/lib/config-stream.test.ts`. The key value is never printed.
