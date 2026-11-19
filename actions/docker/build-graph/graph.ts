// 🗺️ The Docker build graph of a repo, computed (not guessed) from its compose file and Dockerfile(s), as a Mermaid
// flowchart: one node per Dockerfile stage (`FROM … AS <name>`), an edge for every `FROM <stage>`, `COPY --from=<stage>`
// and `RUN --mount=…,from=<stage>`, the default target (the LAST stage) highlighted, and one node per compose service
// that builds, linked to the stage it targets (no `target` = the last stage).
//
// Used by docker-multiarch-cicd.yaml's `docker-review` job: the graph goes to the run summary and into the Docker
// reviewer's prompt, so the review shows the real stage structure even though the reviewer only sees the PR diff.
// Line-based on purpose (no YAML/Dockerfile parser dependency): compose `build:` in scalar, block or flow style.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Stage { name: string; base: string; froms: string[] }
export interface Dockerfile { path: string; stages: Stage[] }
export interface ComposeBuild { service: string; context: string; dockerfile: string; target: string }

/** Stages of one Dockerfile, in file order. An unnamed stage is called `stage-<index>` (BuildKit's own numbering). */
export function parseDockerfile(text: string): Stage[] {
  const stages: Stage[] = [];
  // Join continuation lines so a multi-line RUN --mount=… is one logical line.
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      stages.push({ name: from[2] ?? `stage-${stages.length}`, base: from[1], froms: [] });
      continue;
    }
    const cur = stages[stages.length - 1];
    if (!cur) continue;
    if (/^COPY\s/i.test(line)) for (const m of line.matchAll(/--from=([^\s,]+)/g)) cur.froms.push(m[1]);
    if (/^RUN\s/i.test(line)) for (const m of line.matchAll(/--mount=\S*?\bfrom=([^\s,]+)/g)) cur.froms.push(m[1]);
  }
  return stages;
}

const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "");

/** Services with a `build:` in a compose file. Paths stay as written (relative to the compose file's directory). */
export function parseCompose(text: string): ComposeBuild[] {
  const out: ComposeBuild[] = [];
  let inServices = false;
  let svcIndent = -1;
  let buildIndent = -1;
  let svc: (ComposeBuild & { builds: boolean }) | null = null;
  const flush = () => { if (svc?.builds) out.push({ service: svc.service, context: svc.context || ".", dockerfile: svc.dockerfile || "Dockerfile", target: svc.target }); svc = null; buildIndent = -1; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) { flush(); inServices = /^services:\s*$/.test(line); svcIndent = -1; continue; }
    if (!inServices) continue;
    const name = /^([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (name && (svcIndent === -1 || indent === svcIndent)) {
      flush(); svcIndent = indent;
      svc = { service: name[1], context: "", dockerfile: "", target: "", builds: false };
      continue;
    }
    if (!svc) continue;
    const s = svc as ComposeBuild & { builds: boolean };
    if (buildIndent >= 0 && indent <= buildIndent) buildIndent = -1;
    const flow = /^build:\s*\{(.*)\}\s*$/.exec(line);
    if (flow) {
      s.builds = true;
      for (const kv of flow[1].split(",")) {
        const i = kv.indexOf(":"); if (i < 0) continue;
        const k = kv.slice(0, i).trim(); const v = unquote(kv.slice(i + 1));
        if (k === "context") s.context = v; else if (k === "dockerfile") s.dockerfile = v; else if (k === "target") s.target = v;
      }
      continue;
    }
    if (/^build:\s*$/.test(line)) { s.builds = true; buildIndent = indent; continue; }
    const scalar = /^build:\s*(\S.*)$/.exec(line);
    if (scalar) { s.builds = true; s.context = unquote(scalar[1]); continue; }
    if (buildIndent >= 0) {
      const kv = /^(context|dockerfile|target):\s*(.+)$/.exec(line);
      if (kv) { if (kv[1] === "context") s.context = unquote(kv[2]); else if (kv[1] === "dockerfile") s.dockerfile = unquote(kv[2]); else s.target = unquote(kv[2]); }
    }
  }
  flush();
  return out;
}

const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

/** Mermaid flowchart of the Dockerfiles (one subgraph each) and the compose services that build them. */
export function mermaid(files: Dockerfile[], services: ComposeBuild[]): string {
  const out = ["flowchart LR"];
  files.forEach((f, fi) => {
    const p = `d${fi}_`;
    const names = new Set(f.stages.map((s) => s.name));
    const last = f.stages[f.stages.length - 1]?.name ?? "";
    out.push(`  subgraph ${p}df["${f.path}"]`);
    for (const s of f.stages) {
      const label = names.has(s.base) ? s.name : `${s.name}<br/><small>${s.base.split("@")[0]}</small>`;
      out.push(`    ${p}${id(s.name)}["${s.name === last ? `${label} (runtime, default target)` : label}"]${s.name === last ? ":::runtime" : ""}`);
    }
    out.push("  end");
    const edges = new Set<string>();
    for (const s of f.stages) {
      if (names.has(s.base)) edges.add(`  ${p}${id(s.base)} --> ${p}${id(s.name)}`);
      for (const fr of s.froms) if (names.has(fr) && fr !== s.base) edges.add(`  ${p}${id(fr)} -. copy/mount .-> ${p}${id(s.name)}`);
    }
    out.push(...edges);
    for (const svc of services) {
      if (path.posix.normalize(path.posix.join(svc.context, svc.dockerfile)) !== f.path) continue;
      const target = svc.target || last;
      if (!names.has(target)) { out.push(`  svc_${id(svc.service)}(["compose: ${svc.service}<br/>target ${target} NOT FOUND"]):::missing`); continue; }
      out.push(`  svc_${id(svc.service)}(["compose: ${svc.service}"]):::service --> ${p}${id(target)}`);
    }
  });
  out.push(
    "  classDef runtime fill:#d1fae5,stroke:#059669,stroke-width:2px",
    "  classDef service fill:#e0e7ff,stroke:#4f46e5",
    "  classDef missing fill:#fee2e2,stroke:#dc2626",
  );
  return out.join("\n");
}

/** Reads the compose file (and every Dockerfile it builds) under `root`; returns the graph and the reviewer prompt. */
export function buildGraph(root: string, composeFile: string): { graph: string; prompt: string; files: Dockerfile[] } {
  const composePath = path.join(root, composeFile);
  const composeDir = path.posix.dirname(composeFile);
  const services = (existsSync(composePath) ? parseCompose(readFileSync(composePath, "utf8")) : [])
    .map((s) => ({ ...s, context: path.posix.normalize(path.posix.join(composeDir, s.context)) }));
  const paths = [...new Set(services.map((s) => path.posix.normalize(path.posix.join(s.context, s.dockerfile))))];
  if (paths.length === 0 && existsSync(path.join(root, "Dockerfile"))) paths.push("Dockerfile");
  const files = paths
    .filter((p) => existsSync(path.join(root, p)))
    .map((p) => ({ path: p, stages: parseDockerfile(readFileSync(path.join(root, p), "utf8")) }));
  const graph = mermaid(files, services);
  const prompt = [
    "BUILD GRAPH (computed by the pipeline from the PR head's full Dockerfile(s) and compose file; authoritative, not from the diff):",
    "```mermaid",
    graph,
    "```",
    "Include this diagram VERBATIM in a `### Build graph` section near the top of your review, as a ```mermaid block.",
    "Then assess the structure: the last stage should be the runtime image (highlighted); independent stages should not be",
    "chained serially (BuildKit builds independent branches in parallel); build toolchains and dev dependencies should not",
    "reach the runtime stage; every compose service should name an explicit `target` that exists in the graph.",
  ].join("\n");
  return { graph, prompt, files };
}

interface Ctx {
  core: {
    setOutput: (k: string, v: string) => void;
    summary: { addRaw: (s: string) => { write: () => Promise<unknown> } };
  };
}

export default async function run({ core }: Ctx): Promise<void> {
  const root = process.env.BUILD_GRAPH_ROOT || process.cwd();
  const compose = process.env.BUILD_GRAPH_COMPOSE_FILE || "docker-compose.yaml";
  const { graph, prompt, files } = buildGraph(root, compose);
  core.setOutput("graph", graph);
  core.setOutput("prompt", prompt);
  const counts = files.map((f) => `\`${f.path}\`: ${f.stages.length} stages`).join(" · ") || "no Dockerfile found";
  await core.summary.addRaw(`### 🗺️ Docker build graph\n\n${counts}\n\n\`\`\`mermaid\n${graph}\n\`\`\`\n`).write();
}
