// PR security synchronizer — the evaluate-and-decide engine behind pr-security-synchronizer.yaml.
// Run by actions/github-script (Node 24 strips the erasable TS types natively; no npm dependency).
//
// Per-service image workflows live in DIFFERENT files (one caller per compose service, each calling
// docker-multiarch-cicd.yaml then docker-image-security.yaml), so there is no shared `needs:` graph.
// This module discovers every check run on the PR head SHA, waits until all of them (except this
// workflow run's own jobs) completed, groups them by workflow run (= one service), re-classifies them
// (build / scan / other), downloads each scan's `image-security-report` artifact (trivy.json + meta),
// and decides.
//
// Entry points (each reads env, writes files under OUT_DIR, sets step outputs):
//   collect  wait + classify + consolidated.json (+ the committable patch candidates)
//   patch    apply DETERMINISTIC language fixes at/above ACCEPT_LEVEL in the checked-out PR tree:
//            Go modules (`go get mod@fixed`, kept only if the module's `go` directive stays within the
//            Dockerfile's golang builder) and pip-compile pins (`pkg==fixed`, kept only if pip can
//            still resolve the file). Everything else is left to Dependabot or a Dockerfile edit.
//   push     commit the patched tree as ONE commit on the PR branch and push it.
//   decide   render the consolidated report (job summary + sticky comment), fail on policy-fail.
//
// Fix paths — every one a DECLARATIVE source change that rebuilds the image (post-build image
// patching such as Copa is rejected: it mutates a built image away from what the repo declares):
// commit-go / commit-pip (committed here), base-image (OS packages and Go stdlib — a newer base
// image fixes them; Dependabot `docker` bumps the FROM), dockerfile (an OS package the Dockerfile
// installs itself via apk/apt — pin or upgrade it there), dockerfile-binary (a binary the Dockerfile
// downloads, e.g. grpc_health_probe — bump its version pin), dependabot-lang (npm, maven, nuget, … —
// Dependabot PRs), none (no fixed version).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Ctx } from "../image-security/types.ts";

export const ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
const env = process.env;
const OUT = () => env.OUT_DIR || "pr-security-sync";
const REPO = () => env.REPO || env.GITHUB_REPOSITORY || "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Finding {
  id: string; pkg: string; installed: string; fixed: string; sev: string;
  class: string; type: string; target: string; path: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function atOrAbove(level: string | undefined): string[] {
  const l = (level || "none").toUpperCase();
  return l === "NONE" ? [] : ORDER.slice(0, ORDER.indexOf(l) + 1);
}

// Code-point string order (= Python's default sort), not locale order.
function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function cmpTuple(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
  return a.length - b.length;
}

// ----------------------------------------------------------------------------------------------
// fix paths
// ----------------------------------------------------------------------------------------------
function readDockerfile(ctxDir: string): string | null {
  const df = join(ctxDir || "", "Dockerfile");
  return ctxDir && existsSync(df) ? readFileSync(df, "utf8") : null;
}

/** True when the scanned binary is fetched by the Dockerfile (wget/curl/ADD URL), not built here. */
export function downloadedByDockerfile(target: string, ctxDir: string): boolean {
  const base = basename((target || "").replace(/\/+$/, ""));
  const text = readDockerfile(ctxDir);
  if (!base || text === null) return false;
  return text.includes(base) && /\b(wget|curl)\b|^ADD\s+https?:\/\//im.test(text);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the Dockerfile installs this OS package itself (apk add / apt-get install / yum). */
export function installedByDockerfile(pkg: string, ctxDir: string): boolean {
  const text = readDockerfile(ctxDir);
  if (!pkg || text === null) return false;
  const re = /\b(?:apk\s+add|apt-get\s+install|apt\s+install|yum\s+install|dnf\s+install|microdnf\s+install)\b(.*?)(?:&&|;|$)/gis;
  const word = new RegExp(`^${esc(pkg)}(?:[=<>~].*)?$`);
  for (const m of text.matchAll(re)) {
    if (m[1].split(/[\s\\]+/).some((w) => word.test(w))) return true;
  }
  return false;
}

const normPip = (n: string) => n.replace(/[-_.]+/g, "-").toLowerCase();

export function fixPath(resClass: string, resType: string, pkg: string, fixed: string, ctxDir: string, target = ""): string {
  if (!fixed) return "none";
  if (resClass === "os-pkgs") return installedByDockerfile(pkg, ctxDir) ? "dockerfile" : "base-image";
  const t = (resType || "").toLowerCase();
  if (t === "gobinary" && downloadedByDockerfile(target, ctxDir)) return "dockerfile-binary"; // bump the tool's pin
  if (t === "gobinary" || t === "gomod") {
    if (pkg === "stdlib") return "base-image";
    return ctxDir && existsSync(join(ctxDir, "go.mod")) ? "commit-go" : "dependabot-lang";
  }
  if (["python-pkg", "pip", "pipenv", "poetry"].includes(t)) {
    const req = join(ctxDir || "", "requirements.txt");
    if (ctxDir && existsSync(req)) {
      const pins = new Set(readFileSync(req, "utf8").split("\n")
        .filter((l) => l.includes("==") && !l.trimStart().startsWith("#"))
        .map((l) => normPip(l.split("==")[0])));
      if (pins.has(normPip(pkg))) return "commit-pip";
    }
    return "dependabot-lang";
  }
  return "dependabot-lang";
}

// ----------------------------------------------------------------------------------------------
// evaluate one service's scan (pure apart from the Dockerfile/go.mod/requirements reads)
// ----------------------------------------------------------------------------------------------
const stripVgo = (s: string) => (s || "").replace(/^[vgo]+/, "");

export function evaluate(svc: Json, meta: Json, trivy: Json, sbom: Json | null, accept: string[]): Finding[] {
  // `trivy sbom` leaves Result.Target empty for Go binaries — the SBOM (Syft sourceInfo:
  // "… go module information: /usr/bin/grpc_health_probe") says which binary a module is in.
  const where = new Map<string, Set<string>>();
  for (const p of sbom?.packages || []) {
    const m = /information: (\S+)/.exec(p.sourceInfo || "");
    if (m) {
      const k = `${p.name}\u0000${stripVgo(p.versionInfo || "")}`;
      if (!where.has(k)) where.set(k, new Set());
      where.get(k)!.add(m[1]);
    }
  }
  Object.assign(svc, {
    image: meta.image || "", digest: meta.digest || "",
    status: meta.status || (svc.scan.conclusion === "failure" ? "policy-fail" : "pass"),
    threshold: (meta.threshold || "CRITICAL").toUpperCase(),
    ignore_unfixed: Boolean(meta.ignore_unfixed),
  });
  const blockSev = atOrAbove(svc.threshold);
  const vulns: Finding[] = [];
  for (const r of trivy.Results || []) {
    for (const v of r.Vulnerabilities || []) {
      const fixed = v.FixedVersion || "";
      const bins = [...(where.get(`${v.PkgName}\u0000${stripVgo(v.InstalledVersion || "")}`) || [])].sort(cmp);
      vulns.push({
        id: v.VulnerabilityID || "", pkg: v.PkgName || "", installed: v.InstalledVersion || "", fixed,
        sev: (v.Severity || "UNKNOWN").toUpperCase(), class: r.Class || "", type: r.Type || "",
        target: r.Target || bins.join(","),
        path: fixPath(r.Class, r.Type, v.PkgName || "", fixed, svc.context, r.Target || bins[0] || ""),
      });
    }
  }
  svc.counts = Object.fromEntries(ORDER.map((s) => [s, vulns.filter((v) => v.sev === s).length]));
  svc.fixable = Object.fromEntries(ORDER.map((s) => [s, vulns.filter((v) => v.sev === s && v.fixed).length]));
  svc.blocking = vulns.filter((v) => blockSev.includes(v.sev) && (v.fixed || !svc.ignore_unfixed));
  return vulns.filter((v) => accept.includes(v.sev) && v.fixed && (v.path === "commit-go" || v.path === "commit-pip"));
}

// ----------------------------------------------------------------------------------------------
// collect
// ----------------------------------------------------------------------------------------------
function runIdOf(check: Json): string | null {
  const m = /\/actions\/runs\/(\d+)\//.exec(check.details_url || "");
  return m ? m[1] : null;
}

async function waitForChecks({ core, github }: Ctx, owner: string, repo: string, sha: string, own: string, ignoreRe: RegExp): Promise<Json[]> {
  const interval = Number(env.POLL_INTERVAL || 30);
  const deadline = Date.now() + 60_000 * Number(env.TIMEOUT_MINUTES || 60);
  const settle = Number(env.SETTLE_SECONDS || 90);
  const start = Date.now();
  let lastN = -1, stable = 0;
  for (;;) {
    const all: Json[] = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 });
    const checks = all.filter((c) => runIdOf(c) !== own && !ignoreRe.test(c.name || ""));
    const pending = checks.filter((c) => c.status !== "completed").map((c) => c.name);
    const n = checks.length;
    stable = n === lastN && !pending.length ? stable + 1 : 0;
    lastN = n;
    core.info(`[${String(Math.floor((Date.now() - start) / 1000)).padStart(4)}s] ${n} check(s), ${pending.length} pending`
      + (pending.length ? `: ${pending.slice(0, 6).join(", ")}${pending.length > 6 ? " …" : ""}` : ""));
    // Done: nothing pending, the set is stable across two polls, and the settle window passed
    // (workflows triggered by the same push can register their checks a little later).
    if (!pending.length && stable >= 1 && Date.now() - start >= settle * 1000) return checks;
    if (Date.now() > deadline) throw new Error(`timed out after ${env.TIMEOUT_MINUTES || 60} min; still pending: ${pending.join(", ")}`);
    await sleep(interval * 1000);
  }
}

/** service -> build context dir (relative to the repo root), from `docker compose config`. */
async function composeContexts({ core, exec }: Ctx): Promise<Record<string, string>> {
  const f = env.COMPOSE_FILE || "docker-compose.yaml";
  if (!existsSync(f)) return {};
  const r = await exec.getExecOutput("docker", ["compose", "-f", f, "config", "--format", "json"], { silent: true, ignoreReturnCode: true });
  if (r.exitCode !== 0) {
    core.warning(`docker compose config failed for ${f}: ${r.stderr.slice(0, 200)}`);
    return {};
  }
  const ctx: Record<string, string> = {};
  for (const [name, svc] of Object.entries<Json>(JSON.parse(r.stdout).services || {})) {
    const b = svc.build;
    const c = b && typeof b === "object" ? b.context : b;
    if (c) ctx[name] = relative(process.cwd(), resolve(c)) || ".";
  }
  return ctx;
}

export async function collect(ctx: Ctx): Promise<void> {
  const { core, exec, github } = ctx;
  try {
    const [owner, repo] = REPO().split("/");
    const sha = env.HEAD_SHA || "", own = env.GITHUB_RUN_ID || "";
    const buildRe = new RegExp(env.BUILD_PATTERN || "🏗️ (pr|ref)-build$", "u");
    const scanRe = new RegExp(env.SCAN_PATTERN || "🛡️ image security$", "u");
    const ig = env.IGNORE_PATTERN || "(?i)pr-delete|github-release|slsa|🏷️ release";
    // Python's inline (?i) flag → a JS flag.
    const ignoreRe = new RegExp(ig.replace(/^\(\?i\)/, ""), ig.startsWith("(?i)") ? "iu" : "u");
    const accept = atOrAbove(env.ACCEPT_LEVEL);
    mkdirSync(OUT(), { recursive: true });
    const checks = await waitForChecks(ctx, owner, repo, sha, own, ignoreRe);
    const contexts = await composeContexts(ctx);

    const services = new Map<string, Json>(), others: Json[] = [], names = new Map<string, string>();
    for (const c of checks) {
      const rid = runIdOf(c);
      const kind = buildRe.test(c.name) ? "build" : scanRe.test(c.name) ? "scan" : "other";
      if (kind === "other" || !rid) {
        others.push({ name: c.name, conclusion: c.conclusion ?? null, url: c.html_url });
        continue;
      }
      if (!names.has(rid)) {
        // NOT the run's `name`/`display_title` — with `run-name:` that is the title
        // ("🐳 adservice image 2/merge @ …"); the workflow's own `name:` is the service.
        const wfId = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(rid) })).data.workflow_id;
        const wfName = wfId ? (await github.rest.actions.getWorkflow({ owner, repo, workflow_id: wfId })).data.name : rid;
        names.set(rid, String(wfName || rid).replace(/^[^A-Za-z0-9]+/, "").trim());
      }
      if (!services.has(rid)) services.set(rid, { service: names.get(rid), run_id: rid, run_url: `https://github.com/${REPO()}/actions/runs/${rid}` });
      services.get(rid)[kind] = { conclusion: c.conclusion ?? null, url: c.html_url };
    }

    const patchCands: Json[] = [];
    for (const [rid, svc] of services) {
      svc.context = contexts[svc.service] || "";
      if (!svc.scan) continue;
      const arts: Json[] = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: Number(rid), per_page: 100 });
      const art = arts.find((a) => a.name === "image-security-report" && !a.expired);
      if (!art) { svc.scan.error = "no image-security-report artifact"; continue; }
      svc.trivy_json_url = `https://github.com/${REPO()}/actions/runs/${rid}/artifacts/${art.id}`;
      const d = join(OUT(), "scans", svc.service);
      mkdirSync(d, { recursive: true });
      const zip = await github.rest.actions.downloadArtifact({ owner, repo, artifact_id: art.id, archive_format: "zip" });
      const zf = join(d, "artifact.zip");
      writeFileSync(zf, Buffer.from(zip.data as ArrayBuffer));
      await exec.exec("unzip", ["-o", "-q", zf, "-d", d]);
      const readJson = (f: string) => (existsSync(join(d, f)) ? JSON.parse(readFileSync(join(d, f), "utf8")) : null);
      const accepted = evaluate(svc, readJson("image-security-meta.json") || {}, readJson("trivy.json"), readJson("sbom.spdx.json"), accept);
      for (const v of accepted) patchCands.push({ service: svc.service, context: svc.context, ...v });
    }

    const result = {
      version: 1, repo: REPO(), head_sha: sha, accept_level: (env.ACCEPT_LEVEL || "none").toLowerCase(),
      services: [...services.values()].sort((a, b) => cmp(a.service, b.service)), others,
      patch_candidates: patchCands,
    };
    writeFileSync(join(OUT(), "consolidated.json"), JSON.stringify(result, null, 1));
    core.setOutput("has_patches", String(patchCands.length > 0));
    core.setOutput("services", services.size);
    core.info(`${services.size} service(s); ${patchCands.length} committable fix(es)`);
  } catch (e) {
    core.setFailed((e as Error).message);
  }
}

// ----------------------------------------------------------------------------------------------
// patch
// ----------------------------------------------------------------------------------------------
type Key = Array<number | string>;
export function vkey(v: string): Key {
  return v.replace(/^v+/, "").split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}
/** Python list ordering; a number-vs-string position is not comparable (TypeError in Python). */
export function cmpKey(a: Key, b: Key): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (typeof x !== typeof y) throw new TypeError(`cannot compare ${x} and ${y}`);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

/** Smallest listed fixed version strictly above the installed one (Trivy lists one per branch). */
export function pickFixed(installed: string, fixed: string): string {
  const cands = fixed.split(",").map((f) => f.trim()).filter(Boolean);
  let above: string[];
  try {
    above = cands.filter((c) => cmpKey(vkey(c), vkey(installed)) > 0).sort((a, b) => cmpKey(vkey(a), vkey(b)));
  } catch {
    above = cands;
  }
  return above[0] || cands[cands.length - 1] || "";
}

function newer(a: string, b: string): boolean {
  try { return cmpKey(vkey(a), vkey(b)) > 0; } catch { return a > b; }
}

function goDirective(gomod: string): string {
  const m = /^go\s+(\d+\.\d+)/m.exec(readFileSync(gomod, "utf8"));
  return m ? m[1] : "";
}

function builderGo(ctxDir: string): string {
  const df = join(ctxDir, "Dockerfile");
  if (!existsSync(df)) return "";
  const m = /^FROM\s+(?:\S*\/)?golang:(\d+\.\d+)/im.exec(readFileSync(df, "utf8"));
  return m ? m[1] : "";
}

export async function patch({ core, exec }: Ctx): Promise<void> {
  const run = async (cmd: string, args: string[], cwd: string): Promise<[number, string]> => {
    const r = await exec.getExecOutput(cmd, args, { cwd, silent: true, ignoreReturnCode: true });
    return [r.exitCode, (r.stdout + r.stderr).slice(-600)];
  };
  const data = JSON.parse(readFileSync(join(OUT(), "consolidated.json"), "utf8"));
  const best = new Map<string, Json>();
  for (const c of data.patch_candidates) {
    const k = JSON.stringify([c.context, c.path, c.pkg]);
    const ver = pickFixed(c.installed, c.fixed);
    if (!best.has(k) || newer(ver, best.get(k).to)) best.set(k, { ...c, to: ver });
  }
  const applied: Json[] = [], deferred: Json[] = [];
  const sorted = [...best.values()].sort((a, b) => cmpTuple([a.context, a.path, a.pkg], [b.context, b.path, b.pkg]));
  for (const c of sorted) {
    const { context: ctxDir, path, pkg } = c;
    if (path === "commit-go") {
      const gm = join(ctxDir, "go.mod"), gs = join(ctxDir, "go.sum");
      const before = readFileSync(gm, "utf8");
      const sumBefore = existsSync(gs) ? readFileSync(gs, "utf8") : null;
      const to = c.to.startsWith("v") ? c.to : `v${c.to}`;
      let [rc, log] = await run("go", ["get", `${pkg}@${to}`], ctxDir);
      if (rc === 0) [rc, log] = await run("go", ["mod", "tidy"], ctxDir);
      const limit = builderGo(ctxDir), now = existsSync(gm) ? goDirective(gm) : "";
      if (rc !== 0 || (limit && now && newer(now, limit))) {
        writeFileSync(gm, before);
        if (sumBefore !== null) writeFileSync(gs, sumBefore);
        const last = log.trim().split("\n").pop();
        const why = rc === 0
          ? `needs Go ${now} but the Dockerfile builder is golang:${limit} — base image first (Dependabot docker)`
          : `\`go get\` failed: ${log.trim() ? last : rc}`;
        deferred.push({ ...c, reason: why });
        continue;
      }
      applied.push(c);
    } else if (path === "commit-pip") {
      const req = join(ctxDir, "requirements.txt");
      const before = readFileSync(req, "utf8");
      const pat = new RegExp(`^(${esc(pkg)}|${esc(pkg.replace(/-/g, "_"))})==\\S+`, "gmi");
      let n = 0;
      const after = before.replace(pat, (_m, name) => { n++; return `${name}==${c.to}`; });
      if (!n) { deferred.push({ ...c, reason: "pin not found" }); continue; }
      writeFileSync(req, after);
      // pip is the resolver of the project being patched (a tool, like `go get` above).
      const [rc] = await run("python3", ["-m", "pip", "install", "--dry-run", "--quiet", "--ignore-installed",
        "--report", "/dev/null", "-r", "requirements.txt"], ctxDir);
      if (rc !== 0) {
        writeFileSync(req, before);
        deferred.push({ ...c, reason: "pip cannot resolve with the bump — leave to Dependabot" });
        continue;
      }
      applied.push(c);
    }
  }
  writeFileSync(join(OUT(), "patches.json"), JSON.stringify({ applied, deferred }, null, 1));
  core.setOutput("applied", applied.length);
  core.setOutput("deferred", deferred.length);
  core.info(`applied ${applied.length}, deferred ${deferred.length}`);
}

// ----------------------------------------------------------------------------------------------
// push — ONE commit on the PR branch
// ----------------------------------------------------------------------------------------------
export async function push({ core, exec }: Ctx): Promise<void> {
  await exec.exec("git", ["add", "-A", "--", ".", ":!.pr-security-sync", ":!pr-security-sync"]);
  const diff = await exec.exec("git", ["diff", "--cached", "--quiet"], { ignoreReturnCode: true });
  if (diff === 0) return core.info("nothing to commit");
  await exec.exec("git", ["-c", "user.name=pr-security-synchronizer[bot]", "-c", "user.email=pr-security-synchronizer@users.noreply.github.com",
    "commit", "-q", "-m", `:lock: deps: apply Trivy fixes at or above ${env.LEVEL} (pr-security-synchronizer)`]);
  await exec.exec("git", ["push", "-q", "origin", `HEAD:${env.HEAD_REF}`]);
  core.setOutput("commit", (await exec.getExecOutput("git", ["rev-parse", "HEAD"], { silent: true })).stdout.trim());
  if (env.HAS_APP !== "true") core.warning("fix commit pushed with GITHUB_TOKEN — it will NOT re-trigger the builds; pass SYNC_APP_ID/SYNC_APP_PRIVATE_KEY or push an empty commit");
}

// ----------------------------------------------------------------------------------------------
// decide
// ----------------------------------------------------------------------------------------------
const ICON: Record<string, string> = { success: "✅", failure: "❌", cancelled: "🚫", skipped: "⏭️", pass: "✅", "policy-fail": "❌" };
const icon = (k: string | null | undefined, dflt: string) => (k == null ? "⏳" : ICON[k] ?? dflt);

export interface Decision { md: string; status: "pass" | "policy-fail"; blocking: number; buildsFailed: number; scansFailed: number }

export function renderDecision(data: Json, patches: Json, commit: string): Decision {
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);
  const services: Json[] = data.services;
  const buildsFailed = services.filter((s) => ![undefined, null, "success", "skipped"].includes(s.build?.conclusion));
  const scansFailed = services.filter((s) => s.status === "policy-fail" || s.scan?.error);
  const failed = buildsFailed.length > 0 || scansFailed.length > 0;
  w(`# :shield: PR security synchronizer — ${failed ? "❌ policy-fail" : "✅ pass"}`);
  w("");
  w(`* Head: \`${data.head_sha.slice(0, 12)}\` · services: ${services.length} · accept-trivy-job-patches: \`${data.accept_level}\``);
  w("");
  w("| Service | Build | Scan | Policy | CRITICAL | HIGH | MEDIUM | LOW | Blocking | Trivy JSON |");
  w("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of services) {
    const c = s.counts || {}, b = s.build || {}, sc = s.scan || {};
    const trivy = s.trivy_json_url ? `[artifact](${s.trivy_json_url})` : sc.error || "—";
    w(`| [${s.service}](${s.run_url}) | ${icon(b.conclusion, b.conclusion || "—")} `
      + `| ${icon(s.status, "—")} | ${s.threshold ?? "—"} | `
      + ORDER.slice(0, 4).map((k) => String(c[k] ?? "—")).join(" | ")
      + ` | ${(s.blocking || []).length} | ${trivy} |`);
  }
  const blocking: Array<[string, Finding]> = services.flatMap((s) => (s.blocking || []).map((v: Finding) => [s.service, v] as [string, Finding]));
  if (blocking.length) {
    w("");
    w("<details open>");
    w(`  <summary>${blocking.length} blocking finding(s)</summary>`);
    w("");
    w("| Service | ID | Package | Installed | Fixed | Severity | Fix path |");
    w("|---|---|---|---|---|---|---|");
    const ranked = [...blocking].sort((x, y) => (ORDER.indexOf(x[1].sev) - ORDER.indexOf(y[1].sev)) || cmp(x[0], y[0]) || cmp(x[1].pkg, y[1].pkg));
    for (const [svc, v] of ranked.slice(0, 150)) {
      w(`| ${svc} | ${v.id} | ${v.pkg} | ${v.installed} | ${v.fixed || "—"} | ${v.sev} | \`${v.path}\` |`);
    }
    if (blocking.length > 150) w(`| … ${blocking.length - 150} more in the artifacts |||||||`);
    w("");
    w("</details>");
    const paths: Record<string, number> = {};
    for (const [, v] of blocking) paths[v.path] = (paths[v.path] || 0) + 1;
    w("");
    w("**Fix paths for the blocking findings:** " + Object.keys(paths).sort(cmp).map((k) => `\`${k}\` ${paths[k]}`).join(", "));
  }
  w("");
  w("## :adhesive_bandage: Remediation");
  w("");
  const uniq = (rows: string[][]) => [...new Map(rows.map((r) => [JSON.stringify(r), r])).values()].sort(cmpTuple);
  if (data.accept_level === "none") {
    w("* `accept-trivy-job-patches: none` — nothing applied; the table above is the plan.");
  } else {
    if (patches.applied.length) {
      w(`* **Committed** to this PR${commit ? ` in \`${commit.slice(0, 12)}\`` : ""} (${patches.applied.length}):`);
      for (const c of patches.applied) w(`  * \`${c.service}\` ${c.pkg} ${c.installed} → ${c.to} (${c.path})`);
    } else {
      w("* No deterministic language fix to commit.");
    }
    if (patches.deferred.length) {
      w(`* **Left to Dependabot** (${patches.deferred.length}):`);
      for (const c of patches.deferred) w(`  * \`${c.service}\` ${c.pkg} → ${c.to}: ${c.reason}`);
    }
    const tools = uniq(blocking.filter(([, v]) => v.path === "dockerfile-binary").map(([svc, v]) => [svc, (v.target || "").split(",")[0], v.pkg]));
    if (tools.length) {
      const byBin = new Map<string, Set<string>>();
      for (const [svc, binary] of tools) {
        const b = basename(binary) || "?";
        if (!byBin.has(b)) byBin.set(b, new Set());
        byBin.get(b)!.add(svc);
      }
      w("* **Dockerfile-downloaded tools** — bump their version pin in the Dockerfile: "
        + [...byBin.keys()].sort(cmp).map((b) => `\`${b}\` in ${byBin.get(b)!.size} image(s)`).join("; "));
    }
    const base = [...new Set(blocking.filter(([, v]) => v.path === "base-image").map(([svc]) => svc))].sort(cmp);
    if (base.length) {
      w(`* **Base image** (${blocking.filter(([, v]) => v.path === "base-image").length} finding(s) in ${base.length} image(s)): `
        + "a newer base fixes them — Dependabot `docker` bumps the FROM: " + base.map((s) => `\`${s}\``).join(", "));
    }
    const own = uniq(blocking.filter(([, v]) => v.path === "dockerfile").map(([svc, v]) => [svc, v.pkg]));
    if (own.length) {
      w(`* **Dockerfile-installed OS packages** (${own.length}) — pin or upgrade them on their \`apk\`/\`apt\` line: `
        + own.slice(0, 30).map(([s, p]) => `\`${s}:${p}\``).join(", ") + (own.length > 30 ? " …" : ""));
    }
    const dep = uniq(blocking.filter(([, v]) => v.path.startsWith("dependabot")).map(([svc, v]) => [svc, v.pkg, v.path]));
    if (dep.length) {
      w(`* **Dependabot scope** (${dep.length} package(s)): `
        + dep.slice(0, 30).map(([s, p]) => `\`${s}:${p}\``).join(", ") + (dep.length > 30 ? " …" : ""));
    }
  }
  if (data.others.length) {
    const bad = data.others.filter((o: Json) => !["success", "skipped", "neutral"].includes(o.conclusion));
    w("");
    w(`* Other checks: ${data.others.length} (${bad.length} not successful — reported, not gating)`);
  }
  return {
    md: lines.join("\n") + "\n", status: failed ? "policy-fail" : "pass",
    blocking: blocking.length, buildsFailed: buildsFailed.length, scansFailed: scansFailed.length,
  };
}

export async function decide({ core }: Ctx): Promise<void> {
  const data = JSON.parse(readFileSync(join(OUT(), "consolidated.json"), "utf8"));
  const pf = join(OUT(), "patches.json");
  const patches = existsSync(pf) ? JSON.parse(readFileSync(pf, "utf8")) : { applied: [], deferred: [] };
  const d = renderDecision(data, patches, env.PATCH_COMMIT || "");
  writeFileSync(join(OUT(), "pr-security-sync.md"), d.md);
  if (env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(d.md).write();
  core.setOutput("status", d.status);
  core.setOutput("blocking", d.blocking);
  core.setOutput("builds_failed", d.buildsFailed);
  if (d.status === "policy-fail") {
    return core.setFailed(`PR security: ${d.buildsFailed} build(s) failed, ${d.scansFailed} image(s) above policy — see the summary`);
  }
  core.info("✅ all builds green, all images within policy");
}
