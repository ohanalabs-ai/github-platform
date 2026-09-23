# gitops/gate-summary

The consolidated `🚦 gate` summary over every group's `group.json` (the `gitops-group-*` artifacts): a table groups → units → objects +~−, totals, a note for units not in ArgoCD yet and for `noop-live-equal` units ("already live, git catches up"), a "Merging this PR will …" list, the failing units, and ONE Mermaid graph changed files → kustomizations → Applications → group → cluster for the units that change. A PR that touches no unit yields "No GitOps units changed". Script: [`gitops-gate-summary.sh`](gitops-gate-summary.sh) `<groups-dir> <out.md> [diff|refresh]`.

```yaml
- uses: ./.gitops-platform/actions/gitops/gate-summary
  id: consolidated
  with:
    groups-dir: groups
    output: consolidated.md
    mode: diff
```

Output `failing` = `true` when a unit failed (render failed, live error/failed, or a blocking `noop`) — informational; the gate workflow fails from the group jobs' results.
