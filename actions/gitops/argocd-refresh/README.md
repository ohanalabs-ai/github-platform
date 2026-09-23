# gitops/argocd-refresh

Post-merge: `argocd app get --hard-refresh -o json`, then **prove the merge landed** — poll until the git SHA ArgoCD synced (`status.sync.revision`, or the 40-hex entry of `status.sync.revisions[]` for a multi-source Application) equals `want-sha`, `Synced` and `Healthy` (15 min); with a read-only kubeconfig, cross-check `kubectl get application` and `kubectl rollout status` for every Deployment/StatefulSet/DaemonSet the unit renders. Statuses: `validated`, `new`, `refresh-failed`, `validate-failed`. Script: [`argocd-refresh.sh`](argocd-refresh.sh). ArgoCD's automated sync applies; this never applies anything.

```yaml
- uses: ./.gitops-platform/actions/gitops/argocd-refresh
  env:
    ARGOCD_AUTH_TOKEN: ${{ steps.vault.outputs.ARGOCD_AUTH_TOKEN }}
  with:
    app: ${{ matrix.app }}
    want-sha: ${{ github.sha }}
    in-argocd: ${{ env.IN_ARGOCD || 'unknown' }}
    new-apps-appear-after-merge: "true"     # ApplicationSet-created units: poll for them
    kubeconfig-content: ${{ steps.vault.outputs.KUBECONFIG_CONTENT }}
    rendered: ${{ runner.temp }}/rendered/head.yaml
```

Needs `argocd` (+ `kubectl`, `yq`) on `PATH`. Exits non-zero unless `validated` (or `new`).
