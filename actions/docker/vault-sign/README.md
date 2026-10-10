# 🔏 docker/vault-sign

Sign + attest a container image **digest** with the org's **Vault Transit** key — cosign
`--key hashivault://<org>-ci-images`, **no transparency log** — and prove the round trip with the
exported public key. The `attestation-mode: vault` path of
[`docker-multiarch-cicd.yaml`](../../../.github/workflows/docker-multiarch-cicd.yaml)
([devsecops-docker](../../../products/devsecops-docker/README.md)); Jira INTEGRATE-29.

| File | Role |
|---|---|
| `action.yaml` | composite: plan → (tailnet) → `hashicorp/vault-action` (JWT; token as a step **output**, never exported to the job env) → cosign → Syft SBOM → sign |
| `plan.ts` | sign this run? Never `pull_request`/`pull_request_target`; only `signing-refs` (default main/develop); missing inputs fail. Stages an optional private-CA bundle |
| `provenance.ts` | the SLSA v1 predicate from the **OIDC claims**: `builder.id` = claim `job_workflow_ref` (this reusable), `externalParameters.workflow` = `{repository, ref, path}` of the caller |
| `policy.ts` | pure decisions: `decide`, cosign flags per major version, the org's `approved-build` CUE (mirrors planeo-infra `clusters/base/hooks/policy/clusterimagepolicy-<org>.yaml`) |
| `sign.ts` | `cosign sign --recursive`, `cosign attest --type slsaprovenance1` (+ `spdxjson`), `cosign public-key`, `cosign verify` + `verify-attestation --policy <cue>`, then revokes the Vault token |
| `verify.ts` | the 🛡️ slsa job's re-verification with **no Vault access** (public key + registry only); emits the `docker/slsa-report` outputs |
| `provenance.test.ts` | `node --test actions/docker/vault-sign/*.test.ts` (run by `actions-typescript-selftest.yaml`) |

**Vault side** (planeo-infra `vault/clusters/platform-aws-eks-use1-prd/`): one `JWTOIDCAuthEngineRole`
per repository × branch (`gha-<repo>-<branch>`, `boundClaims: {repository, ref}`, 15 min TTL),
carrying `ci-image-signer-<org>` = `update` on `transit/sign/<org>-ci-images[/*]` + `read` on
`transit/keys/<org>-ci-images` (the public half) — nothing else; verified sufficient with cosign
v3.0.6 and v3.1.3 against a dev Vault.

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
