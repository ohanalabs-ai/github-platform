# actions/vault — 🔏 sign · 🔄 rotate against a Vault, with the job's GitHub OIDC token

TypeScript modules run by `actions/github-script@v8` (Node 24 native type stripping, **no npm
dependencies, no Python/bash logic**), used by
[`vault-sign.yaml`](../../.github/workflows/vault-sign.yaml) and
[`vault-rotate-secret.yaml`](../../.github/workflows/vault-rotate-secret.yaml) — the
[devsecops-vault](../../products/devsecops-vault/README.md) product.

| Module | Does |
|---|---|
| `client.ts` | minimal Vault HTTP client (global `fetch`, injectable): JWT login, transit sign/verify/public key, KV v2 read + check-and-set write, `revoke-self`; path guard (no `..`, no empty segments), https-only URLs, error messages with Vault's reason + a hint and never the request body |
| `sign.ts` | 🔏 login → **key guard** (refuses an `exportable` / `allow_plaintext_backup` transit key) → `mode=digest`: transit sign of a SHA-256 (prehashed, ASN.1) + transit verify · `mode=cosign`: `cosign sign --key hashivault://<key> --use-signing-config=false --tlog-upload=false` + `cosign verify` → revoke |
| `rotate.ts` | 🔄 login → read the KV v2 record → new value (`generate` N random bytes, or `input`) → **CAS write** on the version read → optional `repository_dispatch` (path + version, never the value) → revoke |
| `ca.ts` | optional custom CA (base64 PEM) → file + `VAULT_CACERT`; the Vault-talking steps set `NODE_EXTRA_CA_CERTS` |
| `install.ts` | cosign 3.1.3 from its release, **sha256-pinned in the file** |
| `selftest.ts` | fixture for `vault-selftest.yaml`: configures a dev-mode Vault like a tenant (jwt mount bound to the repo's numeric ids + a per-run audience, non-exportable key, kv-v2) and the confused-deputy negative test |
| `vault.test.ts` | node:test unit tests (fake fetch, no network) — run by `actions-typescript-selftest.yaml` |

## Invariants the code holds

- **The Vault token never leaves the step that logged in** — no step output, no `GITHUB_ENV`, masked
  with `core.setSecret`, revoked in a `finally` (it would expire with its TTL anyway).
- **No value is ever logged.** The rotated value is masked; the dispatch payload carries the path and
  version only; error messages carry Vault's `errors[]`, never the JWT or the body.
- **A signing key that can leave Vault is refused** (`require-non-exportable: true` by default).
- **Images are signed by digest only** — a tag can move after it is signed.
- **No transparency log** in cosign mode: the key is private to the tenant's Vault; publish the
  public key (output `public-key`) to whoever verifies. cosign 3 deprecated `--tlog-upload` in favour of
  a signing config; `--use-signing-config=false --tlog-upload=false` is the combination that keeps it off
  (flags verified in the v3.1.3 source, `cmd/cosign/cli/options/sign.go`).
- The sigstore hashivault client reads `VAULT_ADDR`, `VAULT_TOKEN` and **`TRANSIT_SECRET_ENGINE_PATH`**
  (default `transit`) — `sigstore/sigstore` `pkg/signature/kms/hashivault/client.go`.

## Run the tests

```bash
node --test actions/vault/vault.test.ts
```
