# 🗺️ docker/build-graph

The Docker build graph of a repo, **computed** from its compose file and the Dockerfile(s) it builds, as a Mermaid
flowchart: one node per stage, an edge for `FROM <stage>`, `COPY --from=<stage>` and `RUN --mount=…,from=<stage>`, the
last stage highlighted as the runtime (the default target), and each compose service with a `build:` linked to its
`target` (flagged red when that stage does not exist).

Used by `docker-multiarch-cicd.yaml`'s `docker-review` job (input `docker-review: true`): the graph goes to the run
summary and into the cloud-native Docker reviewer's prompt, because the reviewer itself only sees the PR diff.

- `graph.ts`: pure `parseDockerfile`, `parseCompose`, `mermaid`, `buildGraph(root, composeFile)`, and `run({ core })`
  (env `BUILD_GRAPH_ROOT`, `BUILD_GRAPH_COMPOSE_FILE`; outputs `graph`, `prompt`).
- `graph.test.ts`: `node --test actions/docker/build-graph/graph.test.ts`.
- Line-based, no dependencies: compose `build:` in scalar, block or flow style; continuation lines in Dockerfiles.
