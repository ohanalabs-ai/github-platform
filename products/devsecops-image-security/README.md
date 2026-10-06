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
