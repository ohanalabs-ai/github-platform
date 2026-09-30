# scripted/run-command

Run one shell command for [`scripted-phase.yaml`](../../../.github/workflows/scripted-phase.yaml) — on the runner, or inside the caller's **tools image** (`docker run --rm --network host`, the checkout and `$RUNNER_TEMP` mounted at the same paths, the named env vars forwarded when set) — and **capture its stdout** to a file. The workflow turns a `preview` command's captured stdout into the step summary, the artifact and (on a PR) the sticky comment the approver reads before the gated `apply`.

Convention: a **preview** command prints **markdown on stdout** and its progress/chatter on **stderr** (stderr goes to the job log only), and may write a **plan manifest** under `$PREVIEW_DIR` (`plan.json` / `resources.jsonl` — [`phase-summary`](../phase-summary/) renders it like the Terraform plan comment). Never print secret values — a preview names Vault paths, key NAMES, objects, counts and versions; a manifest diff carries key names, lengths and hashes, never values.

| Input | Default | Meaning |
|---|---|---|
| `command` | — | the shell command (`bash -c`) |
| `title` | `command` | label: `setup` · `preview` · `apply` · `post` |
| `tools-image` | `""` | run inside this image; empty → on the runner |
| `registry-token` | `""` | `docker login` token for the image's registry (ghcr.io: `github.token`) |
| `forward-env` | cloud creds, `REGION`/`STATE_BUCKET`/`LOCK_TABLE`, `VAULT_ADDR`/`VAULT_TOKEN`, `KUBECONFIG`, `PREVIEW_DIR`, `DRY_RUN` | env var **names** forwarded into the container when set |
| `capture-file` | `$RUNNER_TEMP/scripted-phase/<title>.out` | where stdout lands |
| `allow-failure` | `false` | `true` → report the exit code, do not fail the step |

Outputs: `exit-code`, `capture-file`, `lines`.

Why `--network host` and same-path mounts: the caller's cluster API is private (reached over the runner's Tailscale route + split DNS), and a `setup` command's kubeconfig (`$KUBECONFIG` under `$RUNNER_TEMP`) must be the file the next command's container reads.

```bash
COMMAND='bash scripts/preview-phase.sh vault-seed' TITLE=preview TOOLS_IMAGE=ghcr.io/planeodev/planeo-infra/tools:latest \
  REGISTRY_TOKEN="$GITHUB_TOKEN" bash actions/scripted/run-command/run.sh
```
