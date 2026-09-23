# gitops/group-report

Merges one group's per-unit fragments (`render-<app>.json/-tree.md/-mermaid.md/-diff.md`, `act-<app>.json/.md`) into `comment.md` — the sticky PR comment / job summary: one table `Application | tier | rendered objects | expected change (base → head) | <mode> | run`, per-unit components / Mermaid / rendered diff / live result collapsed in `<details>` — and `group.json` for the gate. Every live verdict has its cell (`📝 live already equal`, `❌ live no-op (blocked)`, `ℹ️ render-only (multi-source)`, …); a multi-source unit shows `⎈ helm` and any chart version bump. Script: [`gitops-group-report.sh`](gitops-group-report.sh) `<frags-dir> <cluster> <group> <mode> <run-url> <units-json> <out-dir>`.

```yaml
- uses: ./.gitops-platform/actions/gitops/group-report
  with:
    frags-dir: frags
    cluster: platform-aws-eks-use1-prd
    group: core
    mode: diff
    run-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    units: ${{ needs.discover.outputs.units }}
    out-dir: out
```

Outputs: `comment` (path), `group-json` (path). The comment footer carries the sticky header `gitops-<cluster>-<group>`.
