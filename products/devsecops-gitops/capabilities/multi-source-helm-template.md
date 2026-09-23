# multi-source-helm-template

An ArgoCD **multi-source** Application (`spec.sources[]`) combines one or more Helm charts from an OCI or HTTP registry with a git source that carries `ref: values` (so the chart reads `$values/<path>/values.yaml`) and usually a `path` (an overlay the same source renders — extra CRs, a ServiceAccount, a database). `planeodev/planeo-infra` has four: `kagent` (kagent-crds + kagent + overlay), `karpenter`, `agentgateway`, `vault` (vault-operator + vault-config-operator + overlay).

Until 2026-09-22 CI rendered only the git `path` of such a unit, so a `values.yaml` edit read **`✅ 3 | ⚪ no rendered change | ℹ️ render-only`** (planeo-infra#301's kagent UI image swap: 3 overlay objects, no diff) — the values never reached a manifest.

## What the render does now (`actions/gitops/render-diff`, `MULTI_SOURCE=true`)

For the head tree and the base tree independently:

1. Parse the Application manifest the unit names (`manifest` in the [unit contract](unit-contract.md)) **in that tree** — so a `targetRevision` bump between base and head is rendered at both versions.
2. For every source with `chart`: `helm template <releaseName> oci://<repoURL>/<chart> --version <targetRevision> --namespace <destination.namespace> --include-crds --kube-version <helm-kube-version>` (HTTP repos: `<chart> --repo <repoURL>`), with
   - every `helm.valueFiles` entry of the form `$<ref>/<path>` resolved to `<tree>/<path>` (the `ref` source is this repository), honouring `ignoreMissingValueFiles`;
   - `helm.values` / `helm.valuesObject` written to temp files;
   - `helm.parameters` as `--set` (`--set-string` for `forceString`), `CHANGE_ME_*` values replaced by `ci-placeholder-<name>` — the same placeholder rule the plugin render uses, so base and head stay comparable;
   - `skipCrds: true` respected.
   Helm's `# Source:` comments and comment-only documents are dropped before the per-object split.
3. For every source with `path`: `kustomize build` (or the render plugin when `plugin: true`) exactly like a single-source unit.
4. Concatenate → split per `kind__namespace__name`, sort keys, diff base vs head — the same pipeline as every other unit.

`summary.json` gains `render_mode: helm-template`, `charts: [{chart, repo, release, base, head}]` and the report shows `✅ <n> · ⎈ helm` plus `⎈ <chart> <base>→<head>` next to the object counts when a version changed. The chart bump is also a diff in its own right (labels, images, CRD schemas).

Result on planeo-infra#301's change, run locally with the vendored script against `origin/develop`:

```
addons/platform/kagent [helm-template]: +0 ~1 -0 =50 (51 objects, diff 963 bytes) charts: kagent 0.9.12→0.9.12, kagent-crds 0.9.12→0.9.12
changed: deployment__kagent__kagent-ui
-              value: ghcr.io/ohanalabs-ai/kagent/ui/pr/32:ed068e1
+              value: ghcr.io/ohanalabs-ai/kagent/ui:vionix-main-073f40c
```

## Fallback

If a chart cannot be templated in either tree (registry unreachable, unknown version, a values file the tree lacks), the unit is rendered **again without the chart sources in both trees**, `render_mode` becomes `helm-template-partial`, `note` says which chart failed and why, and the report cell reads `⚠️ helm partial` with "The diff above covers the git source only." The unit does not fail — the git source render is still the signal it had before.

## The live step stays render-only

`argocd app diff --revision <sha>` evaluates one revision of one source; it cannot express "chart at its pin + git at the PR head" for `spec.sources[]`. Multi-source units therefore keep the `ℹ️ render-only (multi-source)` live cell and the note that the live diff appears in ArgoCD after merge. ArgoCD ≥ 2.11 offers `--revisions <sha> --source-positions <n>` for exactly this; wiring it is the recorded follow-up.

Not covered: a git source's `kustomize:` options set in the Application (`commonLabels`, `labelWithoutSelector`) are not applied by the CI render — identical in base and head, so they never produce a diff.
