# 🔏 docker/attest

Attest a container image **digest** with the org's **Vault Transit** key — cosign
`--key hashivault://<org>-ci-images`, **no transparency log** — and prove the round trip with the
exported public key. The composite behind
[`docker-image-attest.yaml`](../../../.github/workflows/docker-image-attest.yaml); the build
([`docker-multiarch-cicd.yaml`](../../../.github/workflows/docker-multiarch-cicd.yaml)) uses only
`identity.ts`. [devsecops-docker](../../../products/devsecops-docker/README.md) · Jira INTEGRATE-29.

| File | Role |
|---|---|
| `action.yaml` | composite: plan → (tailnet) → `hashicorp/vault-action` (JWT; token as a step **output**, never exported to the job env) → cosign → Syft SBOM → `sign.ts` |
| `identity.ts` | **build job**: its GitHub OIDC claims (never the token) as the `build_identity` output; **attest job**: `bindProblems` — the build must be the expected builder reusable and share this job's repository, commit, ref and run |
| `plan.ts` | sign this run? Never `pull_request`/`pull_request_target`; only `signing-refs` (default main/develop); missing inputs fail. Stages an optional private-CA bundle |
| `provenance.ts` | the SLSA v1 predicate from the build's claims: `builder.id` = its `job_workflow_ref` (the builder reusable — what the admission CUE asserts), `externalParameters.workflow` = `{repository, ref, path}` of the caller |
| `policy.ts` | pure decisions: `decide`, cosign flags per major version, the org's `approved-build` CUE (mirrors planeo-infra `clusters/base/hooks/policy/clusterimagepolicy-<org>.yaml`) |
| `sign.ts` | mode `provenance`: `cosign sign --recursive` + `attest --type slsaprovenance1` (+ `spdxjson`); mode `vuln`: `attest --type vuln`; then `cosign public-key` + verify (+ `--policy <cue>`), revoke the Vault token |
| `verify.ts` | the 🛡️ verify job's re-verification with **no Vault access** (public key + registry only) |
| `*.test.ts` | `node --test actions/docker/attest/*.test.ts` (run by `actions-typescript-selftest.yaml`) |

**Vault side** (planeo-infra `vault/clusters/platform-aws-eks-use1-prd/`): the org-wide
`JWTOIDCAuthEngineRole` `gha-<org>-image-signer` (bound to the org's numeric `repository_owner_id`,
`main|develop`, `push|workflow_dispatch`; **no** `job_workflow_ref`, so the attest reusable may sign;
15 min TTL), carrying `ci-image-signer-<org>` = `update` on `transit/sign/<org>-ci-images[/*]` +
`read` on `transit/keys/<org>-ci-images` (the public half) — nothing else; verified sufficient with
cosign v3.0.6 and v3.1.3 against a dev Vault.

**cosign v3 gotcha:** `--tlog-upload=false` alone is rejected (`not supported with --signing-config
or --use-signing-config`) because v3 signs through a signing config that uploads to the public Rekor.
Key-based, Rekor-free, classic `.sig`/`.att` layout (what policy-controller reads) =
`--use-signing-config=false --tlog-upload=false --new-bundle-format=false`.

Local round trip (dev Vault + `registry:2`, what the self-tests do not cover):

```bash
vault server -dev -dev-root-token-id=root &           # VAULT_ADDR=http://127.0.0.1:8200
vault secrets enable transit && vault write -f transit/keys/ohanalabs-ai-ci-images type=ecdsa-p256
cosign sign --yes --use-signing-config=false --tlog-upload=false --new-bundle-format=false \
  --key hashivault://ohanalabs-ai-ci-images localhost:5000/x@sha256:…
cosign public-key --key hashivault://ohanalabs-ai-ci-images > k.pub
cosign verify --key k.pub --insecure-ignore-tlog=true localhost:5000/x@sha256:…
```
