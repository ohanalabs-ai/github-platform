# verdicts

The `🔍 diff <app>` job (mode=diff) runs `argocd app diff <app> --revision <PR head sha>` — the repo-server fetches that commit from the registered repo and renders it exactly as it would after merge (Config Management Plugins included) and diffs it against the live state. Never `--local … --server-side-generate`: its tgz upload is a client-streaming gRPC call that grpc-web through an ALB cannot carry (checksum error against the empty SHA). Consequence: only branches of the repo the repo-server can fetch diff (a fork PR gets `error`; the rendered diff still tells the story).

The unit's own **rendered base→head diff** (`🧩 render`) is read next to the live result to decide the verdict:

| Verdict | Report cell | Passes | When |
|---|---|---|---|
| `diff` | ✅ live diff | yes | argocd exit 1 — a live change; the diff (≤ 60 kB inline, full in the `argocd-diff-<cluster>-<app>` artifact) is the review artifact |
| `new` | 🆕 not in ArgoCD yet (created after merge) | yes | `argocd app list` does not show the app (a non-admin token gets `PermissionDenied`, not NotFound, so the list decides); the rendered diff is the whole expected change; `new-app-hint` says who creates it |
| `meta` | 📝 meta-only (docs) | yes | every file the PR changes under the unit matches `meta-file-pattern` (default: the `.render-kustomize` CMP marker and Markdown) — nothing rendered can change |
| `noop-expected` | 📝 expected no-op | yes | live empty **and** the render is +0 ~0 −0: the changed files under the unit's path are rendered by another Application (an apps-of-apps root) or not at all |
| `noop-prune-nothing` | 🧹 nothing to prune | yes | live empty **and** the render only removes objects (+0 ~0 −N): none of them exists live (never created — e.g. refused by a webhook — or already gone) |
| `noop-live-equal` | 📝 live already equal | yes | live empty **and** the render does change (+a ~c −r > 0, not new): the cluster already carries that state — see below |
| `noop-allowed` | ⚠️ live no-op (allowed) | yes (warning) | live empty and `block-noop` is `"false"` (repo var `GITOPS_BLOCK_NOOP=false`) — decided before the three above |
| `noop` | ❌ live no-op (blocked) | **no** | live empty and nothing explains it: no usable render fragment (render failed / unavailable), or the render says *new* while the app exists live |
| `error` | 💥 failed | **no** | argocd exit > 1 after the retries (connection, RBAC, a reconcile that itself fails) |
| `render-only` · `build-only` · `external` | ℹ️ render-only (multi-source) · ℹ️ build-only · ⏭️ external | yes | the live step does not apply: multi-source Application · a template excluded by an ApplicationSet generator · a path in another repository |
| `skipped-no-argocd` · `skipped-no-tailnet` | ⏭️ skipped (no ARGOCD_SERVER) · ⏭️ skipped (no Tailscale OAuth secrets) | yes | not configured — the render still ran; never trust a green gate for the live half in that state |

Post-merge (mode=refresh) statuses: `validated` ✅ (sync.revision == the merged SHA, Synced, Healthy, kubectl cross-check when configured), `new` 🆕, `refresh-failed` / `validate-failed` 💥.

## The no-op policy

The Applications auto-sync from the target branch, so **a merge IS a deploy**, and a deploy that changes nothing is a defect until proven otherwise: either the change is cosmetic (say so — a docs-only change is `meta`), or the author believed it would take effect when it will not (a values key at the wrong nesting, a token already substituted, a manifest the chart ignores). Failing the check forces the question before the merge. The escape hatch is the repo variable `GITOPS_BLOCK_NOOP=false` (input `block-noop`), meant for adopting a cluster whose live state already matches git — never a `[skip ci]`.

## `noop-live-equal`

Added 2026-09-22 (owner-approved). Before it, this PR shape was **blocked** as `noop`: the rendered manifests DO change base→head, yet `argocd app diff` is empty. Real case: `planeodev/customers#49` pins `runtime: python` on every `Agent` because the kagent 0.10 CRD flips the default to `go` — the cluster already had `runtime: python` (the CRD default filled it in server-side), so the render showed `🟡 +0 ~1 −0 objects` and the live column `❌ live no-op (blocked)` for all three tenants. Git catching up with the live state is exactly the intent of such a PR, so it passes as `📝 live already equal` and the message names the rendered objects that changed (added / changed / removed) and why the live diff is empty: a field a CRD or admission default filled in that the PR now pins explicitly, a value applied by hand before the PR, or a difference ArgoCD normalises away (`ignoreDifferences`, known types). The gate summary marks those units "already live, git catches up". Plain `noop` (nothing in the render explains the empty live diff) stays blocking.

## Cache misses

The diff reads ArgoCD's cached managed resources; the cache is cold after a Redis restart and rewritten during every reconcile, so a read can race a refresh (`error getting cached app managed resources: cache: key is missing`). Up to 3 attempts, each preceded by `argocd app get <app> --refresh -o json` and a 25 s pause. `argocd app get` has **no** `-o name` output format (`json|yaml|wide|tree`; the CLI exits 20 before any request) — only `app list -o name` is valid; the self-test asserts it.
