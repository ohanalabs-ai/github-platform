# gitops/render-diff

The `🧩 render` of one unit: render it in the head tree and in the base tree, split per object, normalise, diff → the **expected change after merge** (objects added / changed / removed + unified diff), the component tree and, when it changes, a Mermaid graph — written as fragments (`render-<app>.json`, `-tree.md`, `-mermaid.md`, `-diff.md`) for [`group-report`](../group-report/). Two scripts:

- [`render-diff.sh`](render-diff.sh) `<head-tree> <base-tree|-> <unit-path> <out-dir>` — the render + diff engine. `kustomize build $KUSTOMIZE_BUILD_ARGS`; with `RENDER_PLUGIN=true` + `RENDER_PLUGIN_SCRIPT` the repo's CMP script with placeholder `CHANGE_ME_*` values; with `MULTI_SOURCE=true` + `APP_MANIFEST` the [multi-source `helm template` path](../../../products/devsecops-gitops/capabilities/multi-source-helm-template.md). Writes `head.yaml`, `diff.txt`, `summary.json` (`new, base, added, changed, removed, unchanged, total, diff_bytes, objects{}, render_mode, charts[], note`).
- [`render-unit.sh`](render-unit.sh) — the workflow step around it: changed-files highlight (`FEEDS`), fragments, optional attestation command, step summary, outputs.

```yaml
- uses: ./.gitops-platform/actions/gitops/render-diff
  id: render
  with:
    app: ${{ matrix.app }}
    path: ${{ matrix.path }}
    tier: ${{ matrix.tier }}
    cluster: platform-aws-eks-use1-prd
    local: ${{ matrix.local }}
    multi-source: ${{ matrix.multi_source || false }}
    plugin: ${{ matrix.plugin || false }}
    manifest: ${{ matrix.manifest || '' }}
    feeds: ${{ matrix.feeds || '' }}
    changed-files: ${{ needs.discover.outputs.changed_files }}
    base-tree: ${{ env.BASE_TREE || '-' }}
    render-plugin-script: addons/platform/argocd/cmp/render.sh
    kustomize-build-args: --enable-helm
```

Outputs: `rendered` (head.yaml path), `difftxt` (diff.txt path), `result` (`ok | failed | external`). Needs kustomize/helm (via [`toolchain`](../toolchain/)), yq v4, jq. Local example: `bash render-diff.sh . /tmp/base addons/core/cert-manager /tmp/rd && cat /tmp/rd/diff.txt`.
