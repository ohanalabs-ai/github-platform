# gitops/toolchain

Puts `kustomize`, `helm`, `argocd`, `kubectl` (the `tools` subset) and `yq` on `PATH` — either from pinned GitHub releases, or as thin shims over the caller's own tools image (`tools-image`), so every downstream script just calls the tool. See [`install.sh`](install.sh) for the shim design (mounts the runner work dir, temp dir and `/tmp` at identical paths, runs in the caller's cwd, `--network host`) and why `yq` is always native.

```yaml
- uses: ./.gitops-platform/actions/gitops/toolchain
  with:
    tools-image: ghcr.io/<org>/<repo>/tools:latest   # or empty → releases
    registry-token: ${{ github.token }}
    tools: kustomize helm
```

| Input | Default |
|---|---|
| `tools-image` | `""` |
| `registry-token` | `""` |
| `tools` | `kustomize helm argocd kubectl` |
| `kustomize-version` / `helm-version` / `argocd-version` / `kubectl-version` / `yq-version` | `5.8.1` / `3.16.3` / `3.5.3` / `1.36.2` / `4.45.1` |

Also exports `HELM_CACHE_HOME` / `HELM_CONFIG_HOME` / `HELM_DATA_HOME` under `$RUNNER_TEMP`.
