# 🧩 devsecops-engram-analyzer — one conformance gate for every Engram analyzer image

Reusable workflow: [`engram-analyzer-conformance.yaml`](../../.github/workflows/engram-analyzer-conformance.yaml).
Helpers: [`actions/engram/analyzer-conformance/`](../../actions/engram/analyzer-conformance) (TypeScript, Node
built-ins only, run by `actions/github-script`; checked out at the reusable's own commit).

An Engram analyzer is its own Docker image whose `ENTRYPOINT` is the interface (contract `engram-analyzer/v1`,
[`okf/analyzer-contract-v1.md`](https://github.com/ohanalabs-ai/vionix-codegraph-analyzer/blob/main/okf/analyzer-contract-v1.md)):
the repo read-only at `REPO_ROOT` (default `/repo`), one sub-graph JSON on stdout, stderr for humans, exit
`0` full / `1` partial / `2` fatal, no tenant/memory/credential env. This gate proves it **on the built image, by
digest**, right after `docker-multiarch-cicd.yaml` builds it — so "all analyzers implement the same contract" is
a CI fact, not a convention.

## Checks

| id | check |
|---|---|
| `alpine` | final base is Alpine — `/etc/os-release` read out of the image with `docker cp` (no binary in the image needed) |
| `base-pinned` | the Dockerfile's final `FROM` (stage aliases and `ARG` defaults followed) is `alpine:<tag>@sha256:<digest>` |
| `non-root` | image `USER` is not root (contract target `65532:65532`) |
| `entrypoint` | exec-form, absolute `argv[0]` (no reliance on `WORKDIR`/`PATH`), equal to the manifest's `entrypoint` |
| `manifest` | `/engram/analyzer.yaml` is in the image and byte-identical to the source `engram-analyzer.yaml` |
| `label` | `dev.rekorda.engram.analyzer.manifest-digest` = `sha256:<sha256 of /engram/analyzer.yaml>` |
| `busybox` | `mkdir`, `tar -x --no-same-owner --no-same-permissions`, `chmod` work as uid 65532 on a read-only root (the Substrate runner stages the snapshot with them) |
| `run` | `docker run --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65532:65532 --tmpfs /tmp -v <fixture>:/repo:ro -e REPO_NODE_ID -e REPO_SHA -e ENGRAM_CONTRACT -e ENGRAM_ANALYZER <image>` → exit `0`/`1`, exactly one JSON document on stdout, valid against the schema, `metadata.analyzer` = manifest `name`, `repo`/`sha` echo the env, exit `1` ⇒ `metadata.partial: true` |
| `relocated` | the same with the tree at `/mnt/conformance/tree` (`REPO_ROOT`) and `--workdir /` |
| `missing-env` | the same without `REPO_NODE_ID` → exit `2` |
| `serve` *(grpc profile)* | `interface: grpc` (registry `service: true`): instead of `run`/`relocated`/`missing-env`, the service starts in the same sandbox and LISTENs on the manifest's `grpc.port` within 30 s (read from `/proc/net/tcp` of its network namespace by a digest-pinned `alpine` probe) |

## Usage — a thin caller, after the build

```yaml
  conformance:
    name: 🧩 conformance
    needs: docker-multiarch
    uses: ohanalabs-ai/github-platform/.github/workflows/engram-analyzer-conformance.yaml@main
    permissions: { contents: read, packages: read }
    with:
      image: ${{ needs.docker-multiarch.outputs.image_ref }}
      analyzer: npm-default
      fixture: languages/javascript/ecosystems/npm-default/testdata
      manifest: languages/javascript/ecosystems/npm-default/engram-analyzer.yaml
      dockerfile: languages/javascript/ecosystems/npm-default/Dockerfile
```

## Enforcement — report-only until migrated

`enforcement-file` (default `.github/analyzer-conformance.json` in the caller) maps each analyzer to `"enforce"` or
`"report"`; an analyzer not listed is `report`. Report-only: the table is in the run summary and a warning is
raised, the job passes. Enforced: any failing check fails the job. Put a **blank line between entries** so the
per-analyzer PRs that flip their own line never conflict with each other:

```json
{
  "analyzers": {

    "npm-default": "enforce",

    "nuget-default": "report"
  }
}
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `image` | *(required)* | `repo@sha256:…` (the build's `image_ref`); empty = skipped |
| `analyzer` | *(required)* | registry id; enforcement lookup, and the name when the image has no manifest |
| `fixture` | *(required)* | fixture tree in the caller's checkout |
| `manifest` / `dockerfile` | `""` | source `engram-analyzer.yaml` / `Dockerfile` (empty = those comparisons are skipped / `n/a`) |
| `schema` | `schema/subgraph.schema.json` | the sub-graph schema |
| `enforcement-file` | `.github/analyzer-conformance.json` | see above |
| `mode` | `""` | `enforce` / `report` overrides the file |
| `profile` | `""` | `cli` / `grpc` overrides the manifest's `interface` |
| `inputs-dir` | `""` | a checkout directory staged read-only at `/in` (contract §7 `consumes`, e.g. a build tier's `decision.json` naming the gate's fixture sha `0c0ffee0…`) |
| `env` | `""` | extra `KEY=VALUE` lines for the contract runs; the manifest's `env.set` is always applied |
| `platform` | `linux/amd64` | platform pulled and run (the platform's own manifest of an index is pulled) |
| `timeout-seconds` | `600` | per-run ceiling (the manifest's `timeout` can only lower it) |

Outputs: `status` (`pass` · `fail` · `report-fail` · `skipped`), `report` (JSON).

## Run it locally

```bash
node actions/engram/analyzer-conformance/cli.ts \
  --image ghcr.io/ohanalabs-ai/vionix-codegraph-analyzer/npm-default@sha256:… \
  --fixture <analyzer repo>/languages/javascript/ecosystems/npm-default/testdata \
  --schema <analyzer repo>/schema/subgraph.schema.json \
  --manifest <analyzer repo>/languages/javascript/ecosystems/npm-default/engram-analyzer.yaml \
  --dockerfile <analyzer repo>/languages/javascript/ecosystems/npm-default/Dockerfile
# or many at once: --batch targets.json  ([{image, fixture, schema, manifest?, dockerfile?, analyzer?}], one table)
```

Node ≥ 22.18 (native type stripping). Self-tests: `node --test actions/engram/analyzer-conformance/conformance.test.ts`
(also run by `actions-typescript-selftest.yaml`).
