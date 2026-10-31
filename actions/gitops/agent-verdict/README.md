# gitops/agent-verdict

The **machine-readable decision** of a `🚦 gate` (contract `planeo.dev/gitops-gate/v1`). Agents — the Planeo
Principal Engineer and its DevSecOps specialist — read `gate.json` before deciding anything about a GitOps PR,
instead of parsing sticky comments and job logs. Logic: [`agent-verdict.ts`](agent-verdict.ts) (TypeScript via
`actions/github-script`, no npm deps), self-tests in [`agent-verdict.test.ts`](agent-verdict.test.ts).

```yaml
- uses: ./.gitops-platform/actions/gitops/agent-verdict
  id: agent
  with:
    groups-dir: groups                      # the downloaded gitops-group-* artifacts
    results-json: ${{ inputs.results-json }} # the caller's toJson(needs)
    title: Rekorda
    mode: diff
```

Outputs `verdict` and `gate-json`; the step also appends a `## 🤖 Agent decision — gitops-gate/v1` section to the job
summary and writes `agent.md` (the same, collapsed) for the sticky comment. `gitops-argocd-gate.yaml` uploads
`gate.json` as the artifact **`gitops-gate-<title>`** and exposes `verdict` as a `workflow_call` output.

## gate.json

```json
{
  "schema": "planeo.dev/gitops-gate/v1",
  "title": "Rekorda", "mode": "diff", "repository": "ohanalabs-ai/k8s-infra", "pr": 18, "sha": "<head sha>",
  "run_url": "https://github.com/<repo>/actions/runs/<id>",
  "verdict": "pass | no-change | blocked | failed",
  "groups": [{ "name": "rekorda", "result": "success" }],
  "units": [{ "cluster": "", "group": "", "app": "", "path": "", "render": "ok|failed|external",
              "act_status": "<live verdict>", "new": false, "added": 0, "changed": 0, "removed": 0,
              "decision": "<decision>", "reason": "<one line>" }],
  "not_verified": ["live argocd diff not run for <app> (<cluster>/<group>): <status>"],
  "next_actions": ["…"]
}
```

| unit `decision` | when (render · live status — [verdicts](../../../products/devsecops-gitops/capabilities/verdicts.md)) | blocks |
|---|---|---|
| `fix-render` | render `failed` | yes |
| `fix-live-error` | `error` · `refresh-failed` · `validate-failed` | yes |
| `blocked-noop` | `noop` — the PR changes nothing live and nothing explains it | yes |
| `needs-human` | a status this contract does not know — never guess | yes |
| `review-new-app` | `new` — not in ArgoCD yet; the rendered objects are the whole change | no (a human reviews) |
| `merge-ok` | `diff` · `noop-live-equal` · `noop-expected` · `noop-prune-nothing` · `noop-allowed` · `meta` | no |
| `live-ok` | mode=refresh `validated` / `refreshed` | no |
| `merge-ok-render-only` | `skipped-no-argocd` · `skipped-no-tailnet` · `render-only` · `build-only` · `external` · no live step | no — listed in `not_verified` |

Gate `verdict`: a group `failure`/`cancelled` → `failed`; else any blocking unit → `blocked`; else no unit →
`no-change`; else `pass`. The gate job's own pass/fail is unchanged (it still fails from the group results).

**Rules for agents:** decide from `verdict` + `next_actions`; a `not_verified` entry means the live `argocd app diff`
did NOT run for that unit — never report it as live-verified; `pass` means "ready for human review" — agents never
merge. Only what `group.json` holds is reshaped here (names, paths, statuses, counts) — never a secret.
