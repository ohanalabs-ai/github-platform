# devsecops-kubernetes

**Will these manifests actually run?** A pull request that changes Kubernetes resources is checked
for what a reviewer cannot see in a diff: the rendered objects are valid for the cluster's Kubernetes
version, use no removed API, and **every image they reference exists and has the cluster's
platform**.

| File | Role |
|---|---|
| [`.github/workflows/kubernetes-kustomize-devsecops.yaml`](../../.github/workflows/kubernetes-kustomize-devsecops.yaml) | standalone: `kustomize build --enable-helm` each top-level kustomization under `paths` → kubeconform (Kubernetes + datree CRDs-catalog) → removed APIs → image availability → job summary + sticky PR comment; fails under `policy: enforce` |
| [`gitops-argocd-group.yaml`](../../.github/workflows/gitops-argocd-group.yaml) job `🧪 kustomize check` | the same check on the units the group rendered — **the pre-condition of `🔍 diff` and so of the 🚦 gate** (input `manifest-check`, on by default) |
| [`actions/kubernetes/manifest-check/`](../../actions/kubernetes/manifest-check/README.md) | the TypeScript modules, the policy table and the auth profiles |
| [`.github/workflows/kubernetes-kustomize-selftest.yaml`](../../.github/workflows/kubernetes-kustomize-selftest.yaml) | real-registry end-to-end on `tests/kubernetes/manifest-check/{good,bad}` |

## Where it sits relative to the ArgoCD gate

```
PR ─ <group job> (gitops-argocd-group.yaml, mode: diff)
       🧭 discover → 🧩 render <app> → 🧪 kustomize check ──(error)──▶ 🔍 diff skipped → group ❌ → 🚦 gate ❌
                                                         └─(ok/warn)─▶ 🔍 diff <app> → 📋 result → 🚦 gate
```

Repos on [devsecops-gitops](../devsecops-gitops/README.md) inherit it with no caller change. Opt out
per group with `manifest-check: false`; report-only with `manifest-check-policy: warn`. A tree ArgoCD
does not watch (an app repo's `kustomize/`, a demo fork) calls the standalone reusable.

## Example caller (thin)

```yaml
name: 🧪 kustomize
on:
  pull_request:
    paths: ["kustomize/**"]
permissions:
  contents: read
  packages: read        # ghcr.io images visible to this repo's token
  pull-requests: write  # sticky comment
jobs:
  kustomize:
    name: 🧪 kustomize
    uses: ohanalabs-ai/github-platform/.github/workflows/kubernetes-kustomize-devsecops.yaml@main
    with:
      paths: kustomize
      kubernetes-version: "1.35.0"
```

## Inputs (`kubernetes-kustomize-devsecops.yaml`)

| Input | Default | Meaning |
|---|---|---|
| `paths` | `.` | kustomization roots (newline/comma); a dir that is not itself a kustomization is searched for the top-level ones |
| `kubernetes-version` | `1.35.0` | schemas + removed APIs |
| `policy` | `enforce` | `warn` = report only |
| `required-platforms` | `linux/amd64` | every image must provide these |
| `require-digest` · `fail-on-floating` · `fail-on-unverifiable` | `false` | tighten notices/warnings into errors |
| `check-images` | `true` | `false` = build/schema/removed-API only |
| `all-kustomizations` | `false` | build every kustomization, not only top-level ones |
| `kustomize-build-args` | `--enable-helm` | extra build flags |
| `skip-kinds` · `schema-locations` · `kubeconform-strict` | `""` · `""` · `false` | kubeconform tuning |
| `title` · `comment` · `comment-key` | `kustomize` · `true` · title | report + sticky comment |

Secrets (all optional): `GCP_ACCESS_TOKEN` (Artifact Registry / gcr.io), `DOCKERHUB_USERNAME` +
`DOCKERHUB_TOKEN`. Outputs: `errors`, `warnings`.

Group inputs (`gitops-argocd-group.yaml`): `manifest-check` (`true`), `manifest-check-policy`
(`enforce`), `kubernetes-version` (`1.35.0`), `required-platforms` (`linux/amd64`),
`manifest-check-fail-on-unverifiable` (`false`); secret `GCP_ACCESS_TOKEN` (optional).

## Lineage — `ohanalabs-ai/oahana-github` `kubernetes-kustomize-devsecops-workflow.yaml` (vionix)

| Kept | Dropped | Added |
|---|---|---|
| `kustomize build` per kustomization dir, results in a sticky PR comment per run | vionix DinD runner label; `kubectl` v1.22 download (`kubectl kustomize`); yamllint job (kustomize + kubeconform parse strictly); in-workflow `argocd` CLI Project/Application checks (gitops-argocd-group owns ArgoCD); Artifactory + Slack secrets; `HEAD^..HEAD`-only change detection | Helm inflation; kubeconform + CRD catalog; removed APIs per target version; **image availability + platform**; digest/floating-tag policy; policy gate inside the reusable; TypeScript + sha256-pinned tools; self-tests |
