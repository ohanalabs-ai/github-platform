# 🛡️ devsecops-images — manifest-driven container image security

Reusable workflow: `.github/workflows/docker-images-devsecops-scan.yaml` (`workflow_call` + `workflow_dispatch`).
Helpers: `actions/images/*` (composite actions) over the tested Python library `actions/images/lib/imgsec`,
always checked out from **this repository at the reusable workflow's own commit** (`job.workflow_sha`), never from the caller.

## Pipeline

| job | credentials | what |
|---|---|---|
| 🧭 plan | none (`contents: read`) | checkout `source-repository@source-ref` (or download `source-artifact` from the same run), **render** (`kustomize build` / `helm template`), discover images from structured PodSpec fields, merge `images` → `plan.json` |
| 🔎 resolve | only the profile of that image's exact host | resolve each unique ref once → index + per-platform manifest digests (attestation manifests filtered, missing requested platforms fail) |
| 🧮 scan-plan | none | bounded per-image/platform matrix (≤ `options.max-scan-jobs`, never mixing hosts in one job) |
| 🛡️ scan | only that host's profile | Trivy on the exact platform digest (**the gate**), SBOM (verified attestation → else Syft), optional provenance; results uploaded before the gate |
| 📋 report | none | always runs; missing/stale results → `error`; `report.md`, `inventory.json`, `digest-lock.json` (+ `kustomize-images.yaml` when passing) |
| 📤 sarif | caller grants `security-events: write` | optional (`options.upload-sarif`), never a prerequisite |

Outputs: `status` (`pass` / `policy-fail` / `error`), `report-artifact`, `plan-fingerprint`.
Use a distinct `artifact-prefix` for each call when a run calls the workflow more than once.

## Inputs (schemas — full docstrings in `lib/imgsec/plan.py`, `render.py`, `auth.py`)

- `images`: a single ref (`my/image` → `docker.io/my/image`; `ubuntu` → `docker.io/library/ubuntu`), a JSON array, or
  `{"version":1,"mode":"scan|annotate","defaults":{…},"images":[{"ref","platforms","sbom-policy","severity-threshold","ignore-unfixed","expected-source","labels"}]}`.
  - Merge rule: the scanned set is the union with discovered images, deduplicated by normalized reference, with every occurrence kept.
  - `annotate` entries only attach settings and labels to discovered refs; an entry that matches nothing is an error.
- `sources`: `{"version":1,"sources":[…],"adapters":[…],"unsupported-resources":"fail|warn","forbidden-images":[…]}` where each source is
  - `manifests`: `paths` globs, confined to the source root;
  - `kustomize`: `path`; remote resources only when listed exactly with a 40-hex `ref=`;
  - `helm`: `chart`, `release-name`, `namespace`, ordered `values-files`, typed `set`, `set-string`, `kube-version`, `api-versions`, `hooks`, `skip-tests`, `include-crds`, and `dependencies: vendored|build-locked` with `allowed-dependency-repositories`.
- `registry-auth-profiles`: per exact `host[:port]`, one of `anonymous`, `github-token`, `secret` (read from `REGISTRY_CREDENTIALS_JSON[host]` or the `DOCKERHUB_*` secrets), or `vault` (GitHub OIDC → KV read; the server, path and role come from the trusted profile, never from image data). Credential values are rejected in every JSON input.
- `options`: `allowed-registries`, `allow-empty`, `max-parallel`, `max-scan-jobs`, `upload-sarif`, `report-only`, `trivy{scanners,timeout,db-repository,java-db-repository}`, `attestation-signers`, `provenance: off|verify|verify-source`, `allow-credentials-on-pull-request`.
- Defaults: threshold `HIGH`, `ignore-unfixed: false`, SBOM policy `prefer-registry`. All severities are always kept in the results.

## Permissions and trust

- plan and report request only `contents: read`. resolve, scan and sarif inherit what the **caller's job** grants:
  - `packages: read` for ghcr.io;
  - `id-token: write` only when a Vault profile is used;
  - `security-events: write` only with SARIF.
- Vault roles should bind `job_workflow_ref` to `ohanalabs-ai/github-platform/.github/workflows/docker-images-devsecops-scan.yaml@<ref>` together with the caller's `repository` and `ref`.
  - A direct `workflow_dispatch` of this repository's copy has no caller, so its token has this repository's identity. Use a caller workflow that grants `id-token: write` if you need Vault.
- Vault KV only retrieves stored registry credentials; it does not mint dynamic registry tokens. Use short-lived, least-privilege policies.
- On `pull_request` events, non-anonymous profiles are refused unless `allow-credentials-on-pull-request` is set.
- Kubernetes `imagePullSecrets` are never read. Rendered YAML is never uploaded (it can contain Secrets); only the inventory and the digest lock are published.

## Guarantees and blind spots

- **Discovery**:
  - Covers built-in PodSpec paths for Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, ReplicationController, Job, CronJob and `List` items: containers, initContainers (including sidecars), ephemeralContainers and image volumes.
  - CRDs are handled only through configured adapters. Other resources that may hold images fail or warn, per `unsupported-resources`.
  - Unresolved templates or placeholders fail. Zero images fail unless `allow-empty` is set.
- **Rendering is offline**:
  - Helm `lookup` returns empty and `.Capabilities` come only from `kube-version`/`api-versions`.
  - Admission-injected sidecars and operator-created pods are **not** covered and need live or admission integration.
- **Separate claims**:
  - A passing Trivy scan means vulnerability findings met the policy with the recorded DB. It is **not** proof of who built the image.
  - Provenance/signature verification is reported separately.
  - Source-to-build correspondence is claimed only with `verify-source` against a GitHub attestation whose source digest matches.
- **Tag drift**: `digest-lock.json` maps every scanned digest to its deployment occurrences. `actions/images/pin` rewrites rendered manifests to those digests (structured fields only, with `--require-digest`). Deploy only digest-pinned output produced from the **same** render settings (compare `plan-fingerprint`). This workflow never deploys.

## Examples

- `examples/wso2-online-boutique/build-map.json` — the checked-in, explicit build map for `wso2/gcp-microservices-demo@57fdd78…`:
  - 10 app services plus an optional `loadgenerator`, taken from `skaffold.yaml`; cartservice uses context `src/cartservice/src`.
  - `actions/images/buildmap validate` fails on any mismatch with skaffold or the Dockerfiles, and on a wrong revision.
  - `assemble` produces the digest mapping, the expect/forbid lists (the short Skaffold names are forbidden, so they can never be scanned as Docker Hub images) and annotate labels (service → source → build digest).
- Google upstream (prebuilt images, **not** a WSO2 build) — `sources`:
  `{"version":1,"sources":[{"id":"google-ob","type":"kustomize","path":"kustomize"}]}` with
  `source-repository: GoogleCloudPlatform/microservices-demo`, `source-ref: 38e7348eb289eb5b87c0c6e8cb19ced0449dc389`.
  - Rendering this locally discovered 13 images: 11 services, `redis:alpine`, and `busybox`.

## Status / not yet done

- Executed locally: plan against the Google kustomize example; resolve and scan of public `busybox` and `redis:alpine`; the report failing closed on missing results; checksum-verified tool installs (except helm).
- **Not** executed: no image builds, no pushes, no Vault, no private registries, no GitHub attestation verification (api.github.com was unreachable in the sandbox).
- Not yet implemented in this PR:
  - the WSO2 build → render → scan example workflow (build map and helpers exist; the workflow is pending);
  - fixture unit tests plus a selftest workflow.
