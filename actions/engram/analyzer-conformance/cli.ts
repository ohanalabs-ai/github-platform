// Local runner of the conformance gate (Node >= 22.18 / 24: native type stripping, no build step).
//
//   node actions/engram/analyzer-conformance/cli.ts --image <ref> --fixture <dir> --schema <subgraph.schema.json> \
//        [--manifest <engram-analyzer.yaml>] [--dockerfile <Dockerfile>] [--analyzer <name>] [--profile cli|grpc] \
//        [--platform linux/amd64] [--inputs-dir <dir staged at /in>] [--env KEY=VALUE[,KEY=VALUE]] [--no-pull] [--json]
//   node actions/engram/analyzer-conformance/cli.ts --batch <targets.json> [--json]
//
// --batch reads a JSON array of {image, fixture, schema, manifest?, dockerfile?, analyzer?, profile?, inputsDir?, env?} (relative paths
// resolve against the file's directory) and prints one markdown table (one row per analyzer, one column per check)
// plus the per-check details. Exit 0 = every image conforms, 1 = at least one does not, 2 = usage error.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { docker } from "./docker.ts";
import { runGate } from "./gate.ts";
import type { GateOptions } from "./gate.ts";
import { renderDetail, renderTable } from "./checks.ts";
import type { Report } from "./types.ts";

function args(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    if (["no-pull", "json", "help"].includes(k)) m.set(k, "true");
    else m.set(k, argv[++i] ?? "");
  }
  return m;
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  if (a.has("help") || (!a.has("batch") && !a.has("image"))) {
    process.stderr.write(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n") + "\n");
    return a.has("help") ? 0 : 2;
  }
  const pull = !a.has("no-pull");
  let targets: GateOptions[];
  if (a.has("batch")) {
    const file = a.get("batch") as string;
    const base = dirname(file);
    const abs = (p?: string) => (p ? (isAbsolute(p) ? p : join(base, p)) : undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    targets = (JSON.parse(readFileSync(file, "utf8")) as any[]).map((t) => ({
      image: t.image, fixture: abs(t.fixture) as string, schemaPath: abs(t.schema) as string, manifestPath: abs(t.manifest),
      dockerfilePath: abs(t.dockerfile), analyzer: t.analyzer, profile: t.profile || "", mode: "report", pull,
      platform: a.get("platform"), inputsDir: abs(t.inputsDir), env: t.env || [],
    }));
  } else {
    targets = [{
      image: a.get("image") as string, fixture: a.get("fixture") || ".", schemaPath: a.get("schema") || "schema/subgraph.schema.json",
      manifestPath: a.get("manifest"), dockerfilePath: a.get("dockerfile"), analyzer: a.get("analyzer"),
      profile: (a.get("profile") || "") as GateOptions["profile"], mode: "report", pull, platform: a.get("platform"),
      inputsDir: a.get("inputs-dir"), env: a.get("env") ? (a.get("env") as string).split(",") : [],
    }];
  }
  const reports: Report[] = [];
  for (const t of targets) {
    process.stderr.write(`[conformance] ${t.analyzer || t.image} …\n`);
    const r = await runGate(t, docker);
    process.stderr.write(`[conformance] ${r.analyzer}: ${r.ok ? "pass" : "FAIL"} (${r.checks.filter((x) => x.status === "fail").map((x) => x.id).join(", ") || "-"})\n`);
    reports.push(r);
  }
  if (a.has("json")) process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  else process.stdout.write([renderTable(reports), "", ...reports.map(renderDetail).flatMap((d) => [d, ""])].join("\n"));
  return reports.every((r) => r.ok) ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { process.stderr.write(`${(e as Error).stack || e}\n`); process.exit(2); });
