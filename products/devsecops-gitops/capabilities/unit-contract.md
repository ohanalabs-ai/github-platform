# unit-contract

The **unit** is one ArgoCD `Application` on one cluster — what the workflow renders, live-diffs, refreshes and reports. How a repo's changed paths map to units is the only repo-specific knowledge, so it stays in the repo as a small script and the workflow calls it: `discover-command` (e.g. `bash clusters/discover-units.sh --json --cluster <c> --group <g>`), with the changed paths (∩ `watch-paths`) appended as arguments. It must print ONE JSON object:

```json
{
  "units": [
    {
      "app": "kagent",                                  // Application metadata.name (required)
      "path": "addons/platform/kagent",                 // the git source path CI renders (required)
      "tier": "platform",                               // display column (required)
      "cluster": "platform-aws-eks-use1-prd",           // optional — the workflow input is authoritative
      "local": true,                                    // false → the path is another repository: listed, never rendered/diffed
      "multi_source": true,                             // spec.sources[]: helm template the chart source(s) + build the git path
      "render_only": true,                              // rendered, never live-diffed (multi-source, templates)
      "plugin": false,                                  // spec.source.plugin → render with render-plugin-script + placeholders
      "manifest": "clusters/platform-aws-eks-use1-prd/hooks/argocd/platform/kagent.yaml", // optional; REQUIRED for multi_source
      "feeds": "^(env/x/prd|env/x/tenant|base)(/|$)"    // optional ERE of repo paths that feed this unit's render (default ^<path>(/|$))
    }
  ],
  "unmapped": ["README.md"]                             // changed paths no Application owns — listed in the summary, not diffed
}
```

Rules the workflow relies on:

- `app` is unique within the group (artifact and fragment names derive from it).
- `local: false` units are reported `⏭️ external` in both columns.
- `multi_source: true` needs `manifest`: the render parses `spec.sources[]` of that file **in each tree** (base and head), so a chart bump between the two shows up. Without a manifest the unit renders like a single-source path.
- `render_only: true` keeps the live step off (`ℹ️ render-only` / `ℹ️ build-only`); `mode=refresh` still validates it.
- `feeds` decides which changed files are highlighted in the component tree/Mermaid and listed in the report; a unit whose render is fed by shared directories (a kustomize `base/`) sets it so those files count.
- With **zero** units the workflow emits one placeholder matrix row `{"app":"(no units)","noop":true,…}` so the Checks UI reads `🧩 render (no units)` instead of an unexpanded `${{ matrix.app }}`.

Reference implementations: `planeodev/planeo-infra` `clusters/discover-units.sh` (derived from the Application manifests, longest source-path prefix, tier fan-outs, ApplicationSet directory generators) and `planeodev/customers` `scripts/gitops/discover-units.sh` (a fixed layout → `cust-<tenant>-prd` / `customer-authentik`).
