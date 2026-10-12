# 🧬 cicd-context

Seal · open · enrich the **vionix-cicd context envelope** (`vionix.dev/cicd-context/v1`) — the design,
key distribution and rationale are in [`products/vionix-cicd`](../../../products/vionix-cicd/README.md).

| Mode | Inputs | Result |
|---|---|---|
| `seal` | `plain-json`, `secret-env-names` (+ `secret-section`), `stage` | `outputs.context` v1 — `plain.org`/`githubHost` from the run |
| `open` | `context` | every sealed value masked + exported as env (`export-env`), optional `.env` (`dotenv-path`, 0600); `outputs.plain` |
| `enrich` | `context`, `section`, `plain-json` and/or `secret-env-names` | `outputs.context` v+1, the section appended (never overwritten), a `trail` entry |

Key: `config-stream-key` input, else env `CONFIG_STREAM_KEY` (exported by `get-config-stream`).
Logic: [`context.ts`](context.ts) (TypeScript via `actions/github-script`, `node:crypto` AES-256-GCM);
tests: `node --test actions/build/cicd-context/context.test.ts`.
