import { test } from "node:test";
import assert from "node:assert/strict";
import { mermaid, parseCompose, parseDockerfile } from "./graph.ts";

const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:24@sha256:abc AS base
FROM base AS deps
RUN pnpm install
FROM rust:1 AS rust
FROM deps AS runner-pkg
RUN --mount=type=bind,from=rust,source=/usr/local/cargo,target=/usr/local/cargo \\
    cargo build
FROM deps AS build
COPY --from=runner-pkg /app/dist dist
FROM base AS production
COPY --chown=node:node --from=build /app /app
`;

test("parseDockerfile: stages, bases, COPY --from and RUN --mount from=", () => {
  const s = parseDockerfile(DOCKERFILE);
  assert.deepEqual(s.map((x) => x.name), ["base", "deps", "rust", "runner-pkg", "build", "production"]);
  assert.deepEqual(s.find((x) => x.name === "runner-pkg")?.froms, ["rust"]);
  assert.deepEqual(s.find((x) => x.name === "build")?.froms, ["runner-pkg"]);
  assert.equal(s[0].base, "node:24@sha256:abc");
});

test("parseDockerfile: unnamed stages get BuildKit's index", () => {
  assert.equal(parseDockerfile("FROM alpine\nFROM busybox\n")[1].name, "stage-1");
});

test("parseCompose: block, flow and scalar build; services without build are skipped", () => {
  const c = parseCompose(`services:
  app:
    image: x
    build:
      context: .
      dockerfile: Dockerfile
      target: production
      args:
        A: b
    ports: ["3100:3100"]
  stage:
    profiles: [stages]
    build: {context: ., dockerfile: Dockerfile, target: build}
  plain:
    build: ./svc
  db:
    image: postgres
`);
  assert.deepEqual(c, [
    { service: "app", context: ".", dockerfile: "Dockerfile", target: "production" },
    { service: "stage", context: ".", dockerfile: "Dockerfile", target: "build" },
    { service: "plain", context: "./svc", dockerfile: "Dockerfile", target: "" },
  ]);
});

test("mermaid: runtime = last stage highlighted, edges, services linked, missing target flagged", () => {
  const files = [{ path: "Dockerfile", stages: parseDockerfile(DOCKERFILE) }];
  const g = mermaid(files, [
    { service: "app", context: ".", dockerfile: "Dockerfile", target: "" },
    { service: "bad", context: ".", dockerfile: "Dockerfile", target: "nope" },
  ]);
  assert.match(g, /d0_production\["production \(runtime, default target\)"\]:::runtime/);
  assert.match(g, /d0_base --> d0_deps/);
  assert.match(g, /d0_rust -\. copy\/mount \.-> d0_runner_pkg/);
  assert.match(g, /svc_app\(\["compose: app"\]\):::service --> d0_production/);
  assert.match(g, /target nope NOT FOUND/);
});
