# devsecops-github

Reusable workflows that automate GitHub repository hygiene itself — as opposed to `devsecops-terraform`/`devsecops-docker`, which automate a *build/deploy* pipeline. Each capability is documented separately under [`capabilities/`](capabilities/), since this product bundles multiple independent workflows rather than one.

## Capabilities

- [`codeowners-validation`](capabilities/codeowners-validation.md) — [`github-team-codeowners-actions.yaml`](../../.github/workflows/github-team-codeowners-actions.yaml): YAML-lints `.github/workflows`, validates `.github/CODEOWNERS` syntax, and resolves every `@team`/`@user` it references against the real GitHub org.

Add a new `capabilities/<name>.md` file (plus a bullet above) for each additional GitHub-automation workflow this product grows to cover.
