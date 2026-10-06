# 🛡️ devsecops-image-security — scan the image right after it is built

Reusable workflow: [`docker-image-security.yaml`](../../.github/workflows/docker-image-security.yaml).
Helpers: [`actions/docker/image-security/`](../../actions/docker/image-security) (checksum-pinned Trivy +
Syft installer, the policy/report script), checked out at the reusable's own commit.

**Scope: the docker image only.** In the Vionix supply chain (Source → Build → Deploy) this is the
Build-phase image gate: it runs right after `docker-multiarch-cicd.yaml` builds an image, so a
vulnerable image fails the build before it is ever scheduled anywhere (shift-left). Dockerfiles and
compose files are verified statically at build time; deployment manifests are a Deploy-phase concern
and are not scanned here.

## Usage — a thin caller

```yaml
jobs:
  docker:
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@main
    with: { … }
  scan:
    name: 🛡️ scan
    needs: docker
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-image-security.yaml@main
    permissions: { contents: read, packages: read, attestations: read, pull-requests: write }
    with:
      image: ${{ needs.docker.outputs.image_ref }}
      severity-threshold: CRITICAL
```

No `if:`, no scripts, no status parsing in the caller: the policy decision and the failure live in
this reusable. An empty `image` (nothing built, e.g. a closed PR) skips the scan.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `image` | *(required)* | `repo:tag` or `repo@sha256:…` — the build's `image_ref`. Resolved to its digest first |
| `severity-threshold` | `CRITICAL` | Fail on findings at or above it: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `UNKNOWN`, or `NONE` (report only) |
| `ignore-unfixed` | `false` | Only findings with a fixed version count against the threshold; all stay in the report |
| `sbom-source` | `build` | `build`: the SPDX SBOM the build attested to the image (GitHub attestation, else cosign), falling back to Syft when absent; `generate`: always Syft |
| `add-pr-comment` | `true` | One sticky PR comment per image on `pull_request` runs |

Outputs: `status` (`pass` / `policy-fail` / `skipped`), `critical-count`, `high-count`,
`blocking-count`, `image-digest`. Artifact `image-security-report`: the SBOM, Trivy JSON, report.

## SBOM: reuse the build's

`docker-multiarch-cicd.yaml` already produces an SPDX SBOM (`anchore/sbom-action`) and attests it to
the image digest — `actions/attest-sbom` (GitHub attestation) on public repos, `cosign attest --type
spdxjson` on private ones. This reusable verifies and extracts that SBOM by digest (`gh attestation
verify --predicate-type https://spdx.dev/Document/v2.3`, or `cosign download attestation`) and runs
`trivy sbom` on it, so the scan judges exactly what the build declared. The report says which origin
was used.

## Report

The same format as Vionix's `actions/docker/sbom-reporter` (used by the `sbom` job of
`docker-compose-devsecops-check-workflow.yaml` in Viasat/vionix and ohanalabs-ai/oahana-github):
`# :jigsaw: SBOM Report`, `## :whale: <image>`, `* Revision:`, a collapsed
`|Dependency|Version|Type|` table, written to the job summary and a sticky PR comment keyed by
image. Below it: a vulnerability section with the policy, totals and fixable counts per severity,
and the blocking findings.

## Supply-chain notes

- Trivy and Syft come from their release tarballs, each checked against a sha256 pinned in
  `install.sh`. Trivy is not installed through `aquasecurity/trivy-action` or `setup-trivy`, whose
  tags were compromised (GHSA-69fq-xp46-6x23). The pins come from PR #35's toolchain.
- Registry access: `ghcr.io` with the run's `GITHUB_TOKEN` (`packages: read`); other registries
  anonymously.

## The PR security synchronizer — evaluate-and-decide over every image of a PR

A monorepo builds one image per caller file (the build reusable cannot run in a matrix — its job
names collide), so a PR fans out into N independent workflows with no shared `needs:` graph.
`.github/workflows/pr-security-synchronizer.yaml` runs on the same PR, waits for all of them and
consolidates:

```yaml
# .github/workflows/pr-security-synchronizer.yaml in the consuming repo — thin, no logic
name: 🛡️ pr-security-synchronizer
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  sync:
    uses: ohanalabs-ai/github-platform/.github/workflows/pr-security-synchronizer.yaml@main
    permissions: { contents: write, pull-requests: write, checks: read, actions: read }
    secrets: inherit                     # optional SYNC_APP_ID / SYNC_APP_PRIVATE_KEY
    with:
      accept-trivy-job-patches: critical # none | critical | high | medium | low
```

What it does, all inside the reusable:

1. **Collect** — lists the check runs of the head SHA, excludes its own run by run id, waits
   (bounded: `poll-interval-seconds`, `timeout-minutes`; a new push cancels the old poller), groups
   them by workflow run (= one service) and classifies them: build (`🏗️ pr-build`/`ref-build`),
   scan (`🛡️ image security`), other. Downloads each scan's `image-security-report` artifact
   (trivy.json + `image-security-meta.json`) and links it.
2. **Fix paths** — every finding gets one, and every one is a **declarative source change that
   rebuilds the image**: `commit-go` / `commit-pip` (deterministic language bump), `base-image`
   (OS packages and Go stdlib — a newer base fixes them; Dependabot `docker` bumps the `FROM`),
   `dockerfile` (an OS package the Dockerfile installs itself via `apk add` / `apt-get install` — pin
   or upgrade it on that line), `dockerfile-binary` (a binary the Dockerfile downloads, e.g.
   `grpc_health_probe` — bump its pin), `dependabot-lang` (npm, maven/gradle, nuget, …), `none` (no
   fixed version).
3. **Patch** (`accept-trivy-job-patches` ≠ `none`) — ONE commit on the PR branch with the
   deterministic bumps at or above the level: `go get mod@fixed` (kept only while the module's `go`
   directive stays within the Dockerfile's `golang:` builder) and pip-compile pins (kept only if pip
   still resolves). A commit pushed with `GITHUB_TOKEN` does not re-trigger workflows — give it a
   GitHub App (`SYNC_APP_ID`, `SYNC_APP_PRIVATE_KEY`) so the builds re-run on the fix.
4. **Decide** — one table (sticky comment + summary) and the verdict: fails when a build failed or
   any image is still above its policy. The failure is the reusable's, never the caller's.

**No post-build image patching.** Copa (and any tool that rewrites layers of an already-built image)
is deliberately not used: a patched image no longer matches what the repository declares, which
breaks the rule that GitOps configuration is declarative — what runs must be reproducible from the
repo. OS-package fixes therefore come from a newer base image (Dependabot `docker`) or an explicit
Dockerfile change, and the image is rebuilt and re-scanned by the normal pipeline.

**Why polling and not `workflow_run`:** `workflow_run` only fires from workflow files already on the
default branch (it cannot be validated in the PR that introduces it) and the caller would have to
list every build workflow by name.

### Dependabot is the other half

Everything not deterministic — npm, maven/gradle, nuget, base images, GitHub Actions — is
Dependabot's. For a multi-service monorepo, one entry per ecosystem per service directory:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - { package-ecosystem: gomod,  directory: /src/frontend,         schedule: { interval: weekly } }
  - { package-ecosystem: npm,    directory: /src/paymentservice,   schedule: { interval: weekly } }
  - { package-ecosystem: pip,    directory: /src/emailservice,     schedule: { interval: weekly } }
  - { package-ecosystem: gradle, directory: /src/adservice,        schedule: { interval: weekly } }
  - { package-ecosystem: nuget,  directory: /src/cartservice/src,  schedule: { interval: weekly } }
  - package-ecosystem: docker      # FROM lines (tags and digests) of every service
    directories: [/src/frontend, /src/paymentservice, /src/emailservice, /src/adservice, /src/cartservice/src]
    schedule: { interval: weekly }
  - { package-ecosystem: github-actions, directory: /, schedule: { interval: weekly } }
```
