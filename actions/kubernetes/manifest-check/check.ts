// 🧪 kustomize check — run by actions/github-script@v8 (Node 24, native type stripping):
//   const { default: run } = await import(`${dir}/check.ts`); await run({ core, exec, github, context });
// For every unit: kustomize build (or take the already-rendered YAML), kubeconform against the
// Kubernetes + CRD-catalog schemas, removed apiVersions for the target Kubernetes, and — the point —
// is every image it would run actually pullable (manifest resolves, required platform present)?
// Inputs are env vars (see README.md). Writes OUT_DIR/{report.md,result.json}; fails the step when
// POLICY=enforce and there is at least one error.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Ctx, Exec } from "./types.ts";
import { isPlaceholder, parseImageRef } from "./imageref.ts";
import { removedApi } from "./deprecations.ts";
import { extractImages, loadObjects, manifestFiles, objectId } from "./objects.ts";
import { checkImage, type Credentials, type ImageResult } from "./registry.ts";
import { imageFindings, renderReport, schemaFindings, type Finding, type ImageRow, type KubeconformResource, type Policy, type UnitSummary } from "./findings.ts";

const CRD_CATALOG = "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json";

export function list(v: string | undefined): string[] {
  return (v || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function isKustomizeDir(d: string): boolean {
  return ["kustomization.yaml", "kustomization.yml", "Kustomization"].some((f) => existsSync(join(d, f)));
}

function kustomizationFile(d: string): string {
  return ["kustomization.yaml", "kustomization.yml", "Kustomization"].map((f) => join(d, f)).find((f) => existsSync(f)) || "";
}

/** Every kustomization dir under root (charts/ caches and dot-dirs skipped). */
export function findKustomizations(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (isKustomizeDir(d)) out.push(d);
    for (const n of readdirSync(d)) {
      if (n.startsWith(".") || n === "charts" || n === "node_modules") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

/** The top-level kustomizations: those no other found kustomization pulls in as a local
 *  resources/components/bases entry — the overlays someone actually applies. */
async function topLevel(exec: Exec, dirs: string[]): Promise<string[]> {
  const referenced = new Set<string>();
  for (const d of dirs) {
    const f = kustomizationFile(d);
    const out = await exec.getExecOutput("yq", ["-o=json", "-I=0", "[.resources[], .components[], .bases[]] | map(select(. != null))", f], { silent: true, ignoreReturnCode: true });
    if (out.exitCode !== 0) continue;
    for (const r of JSON.parse(out.stdout.trim() || "[]") as string[]) {
      if (typeof r !== "string" || /^[a-z]+:\/\//.test(r) || r.includes("?ref=")) continue;
      referenced.add(resolve(d, r));
    }
  }
  return dirs.filter((d) => !referenced.has(resolve(d)));
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "root";
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

export function credentials(env: NodeJS.ProcessEnv): Credentials {
  const c: Credentials = {};
  // ghcr: the workflow's GITHUB_TOKEN (packages: read) — sees public packages and the private ones
  // that granted this repository access; anything else stays "unverifiable", never "missing".
  if (env.GHCR_TOKEN) c["ghcr.io"] = { username: env.GHCR_USERNAME || "x-access-token", password: env.GHCR_TOKEN, profile: "github-token" };
  // Google Artifact Registry / gcr.io: a short-lived OAuth access token (e.g. from WIF) —
  // placeholder until a caller wires one; without it the profile is anonymous.
  if (env.GCP_ACCESS_TOKEN) {
    const g = { username: "oauth2accesstoken", password: env.GCP_ACCESS_TOKEN, profile: "gcp" };
    c[".pkg.dev"] = g;
    c["gcr.io"] = g;
    c[".gcr.io"] = g;
  }
  if (env.DOCKERHUB_USERNAME && env.DOCKERHUB_TOKEN) c["docker.io"] = { username: env.DOCKERHUB_USERNAME, password: env.DOCKERHUB_TOKEN, profile: "dockerhub" };
  return c;
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const env = process.env;
  const source = env.SOURCE === "rendered" ? "rendered" : "kustomize";
  const k8s = (env.KUBERNETES_VERSION || "1.35.0").replace(/^v/, "");
  const mode = env.POLICY === "warn" ? "warn" : "enforce";
  const platforms = list(env.REQUIRED_PLATFORMS || "linux/amd64");
  const policy: Policy = {
    requireDigest: env.REQUIRE_DIGEST === "true",
    failOnUnverifiable: env.FAIL_ON_UNVERIFIABLE === "true",
    failOnFloating: env.FAIL_ON_FLOATING === "true",
  };
  const checkImages = env.CHECK_IMAGES !== "false";
  const outDir = resolve(env.OUT_DIR || join(env.RUNNER_TEMP || tmpdir(), "manifest-check"));
  mkdirSync(join(outDir, "rendered"), { recursive: true });
  const cwd = env.GITHUB_WORKSPACE || process.cwd();

  // 1. units → rendered YAML
  type Unit = { name: string; file: string; build: UnitSummary["build"] };
  const units: Unit[] = [];
  const findings: Finding[] = [];
  if (source === "rendered") {
    const skip = env.UNIT_SKIP ? new RegExp(env.UNIT_SKIP) : undefined;
    for (const t of list(env.TARGETS)) {
      const root = resolve(cwd, t);
      if (!existsSync(root)) continue;
      const entries = statSync(root).isDirectory() ? readdirSync(root).map((n) => join(root, n)) : [root];
      for (const e of entries.sort()) {
        const prefix = env.UNIT_PREFIX || "";
        const name = prefix && basename(e).startsWith(prefix) ? basename(e).slice(prefix.length) : basename(e);
        if (skip?.test(basename(e))) continue;
        units.push({ name, file: e, build: "rendered" });
      }
    }
  } else {
    const dirs: string[] = [];
    for (const t of list(env.TARGETS || ".")) {
      const root = resolve(cwd, t);
      if (!existsSync(root)) {
        findings.push({ level: "error", check: "build", unit: t, subject: t, message: "path does not exist" });
        continue;
      }
      const found = findKustomizations(root);
      dirs.push(...(isKustomizeDir(root) || env.ALL_KUSTOMIZATIONS === "true" ? (isKustomizeDir(root) ? [root] : found) : await topLevel(exec, found)));
    }
    const args = (env.KUSTOMIZE_BUILD_ARGS ?? "--enable-helm").split(/\s+/).filter(Boolean);
    for (const d of [...new Set(dirs)].sort()) {
      const name = relative(cwd, d) || ".";
      const file = join(outDir, "rendered", `${slug(name)}.yaml`);
      const out = await exec.getExecOutput("kustomize", ["build", ...args, d], { silent: true, ignoreReturnCode: true });
      if (out.exitCode !== 0) {
        findings.push({ level: "error", check: "build", unit: name, subject: "kustomize build", message: out.stderr.trim().split("\n").slice(-3).join(" ") });
        units.push({ name, file: "", build: "failed" });
        continue;
      }
      writeFileSync(file, out.stdout);
      units.push({ name, file, build: "ok" });
    }
  }
  if (!units.length) core.notice("kustomize check: no units to check");

  // 2. per unit: schema + removed APIs + image inventory
  const summaries: UnitSummary[] = [];
  const imageUnits = new Map<string, Set<string>>();
  const cache = join(outDir, "schema-cache");
  mkdirSync(cache, { recursive: true });
  const skipKinds = list(env.SKIP_KINDS).join(",");
  const extraSchemas = list(env.SCHEMA_LOCATIONS).flatMap((s) => ["-schema-location", s]);
  for (const u of units) {
    const s: UnitSummary = { unit: u.name, objects: 0, build: u.build, schema: "—", deprecated: 0, images: 0 };
    summaries.push(s);
    if (!u.file) continue;
    const files = manifestFiles(u.file);
    let objs: Awaited<ReturnType<typeof loadObjects>> = [];
    try {
      objs = await loadObjects(exec, files);
    } catch (e) {
      findings.push({ level: "error", check: "build", unit: u.name, subject: "yaml", message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    s.objects = objs.length;
    if (!files.length) continue;
    const kc = await exec.getExecOutput(
      "kubeconform",
      ["-output", "json", "-summary", "-kubernetes-version", k8s, "-ignore-missing-schemas", "-cache", cache,
        "-schema-location", "default", "-schema-location", CRD_CATALOG, ...extraSchemas,
        ...(skipKinds ? ["-skip", skipKinds] : []), ...(env.KUBECONFORM_STRICT === "true" ? ["-strict"] : []), ...files],
      { silent: true, ignoreReturnCode: true },
    );
    let parsed: { resources?: KubeconformResource[]; summary?: { valid?: number; invalid?: number; errors?: number; skipped?: number } } = {};
    try {
      parsed = JSON.parse(kc.stdout || "{}");
    } catch {
      findings.push({ level: "error", check: "schema", unit: u.name, subject: "kubeconform", message: (kc.stderr || kc.stdout).trim().slice(0, 300) });
    }
    const sf = schemaFindings(u.name, parsed.resources || []);
    findings.push(...sf);
    const sm = parsed.summary || {};
    s.schema = sf.length ? `❌ ${sf.length} invalid` : `✅ ${sm.valid ?? 0} valid${sm.skipped ? ` · ${sm.skipped} no schema` : ""}`;
    for (const { obj } of objs) {
      const r = removedApi(obj.apiVersion || "", obj.kind || "", k8s);
      if (r) {
        s.deprecated++;
        findings.push({ level: "error", check: "deprecated-api", unit: u.name, subject: objectId(obj), message: `${r.apiVersion} was removed in Kubernetes ${r.removedIn} → ${r.replacement}` });
      }
    }
    const imgs = new Set<string>();
    for (const { file, obj } of objs) for (const i of extractImages(obj, file)) imgs.add(i.image);
    s.images = imgs.size;
    for (const i of imgs) imageUnits.set(i, (imageUnits.get(i) || new Set()).add(u.name));
  }

  // 3. image availability — each distinct reference once (Docker Hub anonymous pulls are rate limited)
  const rows: ImageRow[] = [...imageUnits.keys()].sort().map((image) => ({ image, units: [...imageUnits.get(image)!] }));
  if (checkImages) {
    const creds = credentials(env);
    const f = (url: string, init?: { headers?: Record<string, string> }) => fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(30000) });
    await mapLimit(rows, 6, async (r) => {
      if (isPlaceholder(r.image)) return;
      r.res = await checkImage(f, parseImageRef(r.image), creds, platforms);
    });
    for (const r of rows) findings.push(...imageFindings(r.image, r.units, r.res, policy, platforms));
  }

  // 4. report
  const report = renderReport({ title: env.TITLE || "manifests", kubernetesVersion: k8s, policyMode: mode, platforms, units: summaries, images: checkImages ? rows : [], findings, runUrl: env.RUN_URL });
  writeFileSync(join(outDir, "report.md"), report);
  const errors = findings.filter((x) => x.level === "error");
  const result = { kubernetesVersion: k8s, policy: mode, units: summaries, images: rows.map((r) => ({ image: r.image, units: r.units, ...(r.res || { availability: "placeholder" }) })), findings, errors: errors.length };
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  await core.summary.addRaw(report, true).write();
  core.setOutput("report", join(outDir, "report.md"));
  core.setOutput("result", join(outDir, "result.json"));
  core.setOutput("errors", errors.length);
  core.setOutput("warnings", findings.filter((x) => x.level === "warning").length);
  for (const x of findings) {
    const msg = `[${x.check}] ${x.unit}: ${x.subject} — ${x.message}`;
    if (x.level === "error") core.error(msg);
    else if (x.level === "warning") core.warning(msg);
  }
  if (errors.length && mode === "enforce") core.setFailed(`kustomize check: ${errors.length} error(s) — see the job summary`);
}
