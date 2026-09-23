# gitops/argocd-diff

`argocd app diff <app> --revision <PR head sha>` against the live cluster and the **verdict** — `diff · new · meta · noop-expected · noop-prune-nothing · noop-live-equal · noop-allowed · noop · error` — decided from the argocd exit code, whether the app is in ArgoCD, the files the PR changes under the unit, and the unit's own render fragment. 3× retry on a managed-resources cache miss (`app get --refresh -o json`, never `-o name`). Every verdict, its cell and whether it passes: [verdicts](../../../products/devsecops-gitops/capabilities/verdicts.md). Script: [`argocd-diff.sh`](argocd-diff.sh).

Needs `argocd` on `PATH` and `ARGOCD_SERVER` / `ARGOCD_AUTH_TOKEN` / `ARGOCD_OPTS` in the environment (the step's `env:`), plus the caller's checkout (the `meta` rule runs `git diff --name-only <base> <head> -- <path>`).

```yaml
- uses: ./.gitops-platform/actions/gitops/argocd-diff
  id: diff
  env:
    ARGOCD_AUTH_TOKEN: ${{ steps.vault.outputs.ARGOCD_AUTH_TOKEN }}
  with:
    app: ${{ matrix.app }}
    path: ${{ matrix.path }}
    revision: ${{ github.event.pull_request.head.sha }}
    base-sha: ${{ github.event.pull_request.base.sha }}
    in-argocd: ${{ env.IN_ARGOCD || 'unknown' }}
    render-fragment: ${{ runner.temp }}/renderfrag/render-${{ matrix.app }}.json
    block-noop: ${{ vars.GITOPS_BLOCK_NOOP || 'true' }}
```

Output `status` = the verdict; the step itself never fails — the workflow's `🚧 Enforce` step turns `noop`/`error` into a failure. Writes `act-<app>.json` / `.md` fragments and the raw diff to `diff-output`.
