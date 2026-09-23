# gitops/kustomize-tree

Walks a kustomization recursively and prints what it is made of — an indented tree or a Mermaid `graph LR` of kustomization dirs → resource/patch/generator files, components, bases, Helm charts (`helmCharts`), remote resources — with changed files highlighted (`classDef changed`). Script: [`kustomize-tree.sh`](kustomize-tree.sh) `<path> [--mermaid] [--changed f1,f2,…] [--title T]`, paths relative to `GITOPS_REPO_ROOT` (default: cwd).

```yaml
- uses: ./.gitops-platform/actions/gitops/kustomize-tree
  with:
    path: addons/core/cert-manager
    mermaid: "true"
    changed: addons/core/cert-manager/values.yaml
    title: cert-manager · platform-aws-eks-use1-prd (core)
    output: ${{ runner.temp }}/tree.md
```

`render-diff` calls the script directly; this action exists for workflows that want the graph on its own (e.g. a "what changes where" summary). Needs yq v4 and jq.
