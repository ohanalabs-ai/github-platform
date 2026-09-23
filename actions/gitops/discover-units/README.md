# gitops/discover-units

Runs the **caller's** repo-local discovery command over the changed files and turns its JSON ([unit contract](../../../products/devsecops-gitops/capabilities/unit-contract.md)) into the outputs the group workflow fans out on: `units`, `count`, `has_changes`, `matrix` (the units, or one `(no units)` placeholder row with `noop: true`), plus a step summary listing the units and the unmapped paths. Script: [`discover.sh`](discover.sh).

```yaml
- uses: ./.gitops-platform/actions/gitops/discover-units
  id: units
  with:
    command: bash clusters/discover-units.sh --json --cluster platform-aws-eks-use1-prd --group core
    changed-files: ${{ steps.changed.outputs.all_changed_files }}
    cluster: platform-aws-eks-use1-prd
    group: core
    mode: diff
```

The command must print `{"units":[…],"unmapped":[…]}`; anything else fails the step. Paths never contain spaces (by contract — they are word-split onto the command line).
