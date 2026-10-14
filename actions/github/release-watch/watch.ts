// 🔭 release-watch — "has upstream shipped what we are blocked on?" without anybody polling.
// For each entry of a watch list (YAML/JSON in the caller repo): list the repo's GitHub Releases, keep
// the GA ones whose tag matches, evaluate the entry's conditions against the newest few —
//   minVersion  semver ≥ (version extracted from the tag)
//   notesMatch  regex on the release body
//   fileMatch   regex on a file fetched at the release tag (or any ref/repo — a compat table, a CI matrix)
// (a condition marked `info: true` is evaluated and reported but never gates; `newerOnly` makes "a release
// newer than the pin exists" itself the signal — with `includePrerelease`, a nightly pre-release track),
// pull `extract` values (image digests, …) out of the notes or a file at the tag,
// — then publish a summary table + a JSON output, and for every entry whose conditions are met open
// (or update, deduped by a hidden marker) ONE issue in the caller repo — per entry, or per met version
// with `issuePer: version`. Never closes or reopens an
// issue: a closed one means a human acknowledged it.
//
// env: WATCH_FILE (path to the list), ISSUE_REPO (owner/name; default the run's repo),
//      CREATE_ISSUES ("true"/"false"), FAIL_ON_ERROR ("true"/"false")
import { readFileSync } from "node:fs";
import type {
  Candidate, Condition, ConditionResult, Ctx, EntryResult, Extract, Extracted, Release, WatchEntry, WatchList,
} from "./types.ts";

export const MARKER_PREFIX = "upstream-release-watch";
export const DEFAULT_TITLE = "Unblocked: {name} {version} supports Kubernetes {target}";

// ── semver (no npm) ─────────────────────────────────────────────────────────────────────────────
export interface SemVer { major: number; minor: number; patch: number; pre: string[] }

// Extract the first x.y[.z][-pre] from a tag: v1.20.2, argo-cd-10.10.3, helm-chart-2.12.0, 1.0.0-alpha13.
export function versionFromTag(tag: string): string {
  const m = tag.match(/(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/);
  if (!m) return "";
  return `${m[1]}.${m[2]}.${m[3] ?? "0"}${m[4] ?? ""}`;
}

export function parseSemver(v: string): SemVer | null {
  const m = String(v).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +(m[3] ?? 0), pre: m[4] ? m[4].split(".") : [] };
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`not a semver: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    // natural order inside an identifier: alpha13 > alpha9 (kagent tags), not strict-semver lexical
    const c = p.localeCompare(q, "en", { numeric: true });
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(r: Pick<Release, "prerelease">, version: string): boolean {
  // kagent tags 1.0.0-alphaN as non-prerelease on GitHub — the semver suffix is authoritative too
  return r.prerelease || (parseSemver(version)?.pre.length ?? 0) > 0;
}

// ── placeholders ────────────────────────────────────────────────────────────────────────────────
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function fill(template: string, vars: Record<string, string>, regex: boolean): string {
  return template.replace(/\{(version|minor|tag|target|name)\}/g, (_, k: string) => {
    const v = vars[k] ?? "";
    return regex ? escapeRe(v) : v;
  });
}

export function varsFor(c: Candidate, target: string, name: string): Record<string, string> {
  const s = parseSemver(c.version);
  return { version: c.version, minor: s ? `${s.major}.${s.minor}` : c.version, tag: c.tag, target, name };
}

// ── candidates ──────────────────────────────────────────────────────────────────────────────────
// GA (unless includePrerelease), non-draft, tag-matching releases, newest semver first. GitHub lists by
// creation date, so a v1.20.4 patch published after v1.21.2 would otherwise read as "latest".
export function candidates(releases: Release[], e: Pick<WatchEntry, "tagPattern" | "includePrerelease">): Candidate[] {
  const tagRe = e.tagPattern ? new RegExp(e.tagPattern) : null;
  const out: Candidate[] = [];
  for (const r of releases) {
    if (r.draft || (tagRe && !tagRe.test(r.tag_name))) continue;
    const version = versionFromTag(r.tag_name);
    if (!version || !parseSemver(version)) continue;
    if (!e.includePrerelease && isPrerelease(r, version)) continue;
    out.push({ tag: r.tag_name, version, url: r.html_url, body: r.body ?? "", publishedAt: r.published_at ?? "", prerelease: isPrerelease(r, version) });
  }
  return out.sort((a, b) => compareSemver(b.version, a.version));
}

// ── conditions ──────────────────────────────────────────────────────────────────────────────────
export type FileFetcher = (repo: string, ref: string, path: string) => Promise<string | null>;

export async function evalCondition(
  cond: Condition, c: Candidate, e: WatchEntry, target: string, fetchFile: FileFetcher,
): Promise<ConditionResult> {
  const r = await evalConditionRaw(cond, c, e, target, fetchFile);
  return cond.info ? { ...r, info: true } : r;
}

async function evalConditionRaw(
  cond: Condition, c: Candidate, e: WatchEntry, target: string, fetchFile: FileFetcher,
): Promise<ConditionResult> {
  const vars = varsFor(c, target, e.name);
  if (cond.minVersion !== undefined) {
    const met = compareSemver(c.version, String(cond.minVersion)) >= 0;
    return { kind: "minVersion", met, detail: `${c.version} ${met ? "≥" : "<"} ${cond.minVersion}` };
  }
  if (cond.notesMatch !== undefined) {
    const re = new RegExp(fill(cond.notesMatch, vars, true), "im");
    const met = re.test(c.body);
    return { kind: "notesMatch", met, detail: `notes ${met ? "match" : "do not match"} /${re.source}/` };
  }
  if (cond.fileMatch) {
    const f = cond.fileMatch;
    const repo = f.repo || e.repo;
    const ref = fill(f.ref || "{tag}", vars, false);
    const re = new RegExp(fill(f.pattern, vars, true), "m");
    const where = `${repo}@${ref}:${f.path}`;
    const text = await fetchFile(repo, ref, f.path);
    if (text === null) return { kind: "fileMatch", met: false, detail: `${where} not found` };
    const met = re.test(text);
    return { kind: "fileMatch", met, detail: `${where} ${met ? "matches" : "does not match"} /${re.source}/` };
  }
  throw new Error(`entry ${e.name}: a condition needs one of minVersion | notesMatch | fileMatch`);
}

// `info` results never gate. With no gating condition left (a `newerOnly` entry), the candidate's
// existence is the signal — but an empty result list (nothing evaluated) is never met.
export function combine(results: ConditionResult[], match: "all" | "any" = "all"): boolean {
  if (!results.length) return false;
  const gating = results.filter((r) => !r.info);
  if (!gating.length) return true;
  return match === "any" ? gating.some((r) => r.met) : gating.every((r) => r.met);
}

// ── extracts ────────────────────────────────────────────────────────────────────────────────────
export function formatMatch(m: RegExpMatchArray, format?: string): string {
  if (format) return format.replace(/\{(\d+)\}/g, (_, i: string) => m[+i] ?? "");
  return m[1] ?? m[0];
}

export async function evalExtract(x: Extract, c: Candidate, e: WatchEntry, target: string, fetchFile: FileFetcher): Promise<Extracted> {
  const vars = varsFor(c, target, e.name);
  const re = new RegExp(fill(x.pattern, vars, true), "m");
  let text: string | null = c.body;
  let source = `release notes of ${c.tag}`;
  if (x.path) {
    const repo = x.repo || e.repo;
    const ref = fill(x.ref || "{tag}", vars, false);
    source = `${repo}@${ref}:${x.path}`;
    text = await fetchFile(repo, ref, x.path);
  }
  const m = text === null ? null : text.match(re);
  return { label: x.label, value: m ? formatMatch(m, x.format) : "", source };
}

export async function evaluateEntry(
  e: WatchEntry, releases: Release[], target: string, fetchFile: FileFetcher,
): Promise<EntryResult> {
  const base: EntryResult = {
    name: e.name, repo: e.repo, current: e.current ?? "", latest: "", latestUrl: "", status: "waiting",
    metVersion: "", metUrl: "", conditions: [], note: e.note ?? "", error: "",
  };
  if (e.issuePer) base.issuePer = e.issuePer;
  const kind = e.includePrerelease ? "release" : "GA release";
  const cands = candidates(releases, e);
  if (!cands.length) return { ...base, conditions: [{ kind: "minVersion", met: false, detail: `no ${kind} matches` }] };
  base.latest = cands[0].version;
  base.latestUrl = cands[0].url;
  // only releases newer than what we run can unblock us (a pin that already satisfies it is not news)
  const pin = e.current ? versionFromTag(e.current) || e.current : "";
  const fresh = pin && parseSemver(pin) ? cands.filter((c) => compareSemver(c.version, pin) > 0) : cands;
  if (e.newerOnly && !fresh.length) {
    return { ...base, conditions: [{ kind: "newer", met: false, detail: `no ${kind} newer than ${e.current} (latest ${cands[0].version})` }] };
  }
  const pool = (fresh.length ? fresh : cands).slice(0, Math.max(1, e.maxCandidates ?? 3));
  let firstEval: ConditionResult[] = [];
  for (const c of pool) {
    const res: ConditionResult[] = e.newerOnly ? [{ kind: "newer", met: true, detail: `${c.version} > ${e.current}` }] : [];
    for (const cond of e.conditions ?? []) res.push(await evalCondition(cond, c, e, target, fetchFile));
    if (!firstEval.length) firstEval = res;
    if (combine(res, e.match)) {
      const extracts: Extracted[] = [];
      for (const x of e.extract ?? []) extracts.push(await evalExtract(x, c, e, target, fetchFile));
      return {
        ...base, status: "met", metVersion: c.version, metUrl: c.url, metTag: c.tag, metPublishedAt: c.publishedAt,
        metPrerelease: !!c.prerelease, conditions: res, ...(extracts.length ? { extracts } : {}),
      };
    }
  }
  return { ...base, conditions: firstEval };
}

// ── list parsing / validation ───────────────────────────────────────────────────────────────────
export function validateList(raw: unknown): WatchList {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const l = raw as any;
  if (!l || !Array.isArray(l.entries) || !l.entries.length) throw new Error("watch list: `entries` must be a non-empty list");
  const seen = new Set<string>();
  for (const [i, e] of l.entries.entries()) {
    const at = `entries[${i}]${e?.name ? ` (${e.name})` : ""}`;
    if (!e?.name || typeof e.name !== "string") throw new Error(`${at}: name is required`);
    if (seen.has(e.name)) throw new Error(`${at}: duplicate name`);
    seen.add(e.name);
    if (!/^[\w.-]+\/[\w.-]+$/.test(e.repo ?? "")) throw new Error(`${at}: repo must be owner/name`);
    if (e.newerOnly && (e.current === undefined || !parseSemver(versionFromTag(String(e.current)) || String(e.current)))) throw new Error(`${at}: newerOnly needs a semver \`current\``);
    if (e.conditions === undefined && e.newerOnly) e.conditions = [];
    if (!Array.isArray(e.conditions) || (!e.conditions.length && !e.newerOnly)) throw new Error(`${at}: conditions must be a non-empty list (or set newerOnly)`);
    if (!e.newerOnly && e.conditions.length && e.conditions.every((c: Condition) => c?.info)) throw new Error(`${at}: every condition is info-only — add a gating condition or set newerOnly`);
    if (e.match && !["all", "any"].includes(e.match)) throw new Error(`${at}: match must be all|any`);
    if (e.issuePer && !["entry", "version"].includes(e.issuePer)) throw new Error(`${at}: issuePer must be entry|version`);
    if (e.extract !== undefined) {
      if (!Array.isArray(e.extract)) throw new Error(`${at}: extract must be a list`);
      for (const x of e.extract) {
        if (!x?.label || !x?.pattern) throw new Error(`${at}: each extract needs label + pattern`);
        new RegExp(x.pattern);
      }
    }
    for (const c of e.conditions) {
      const kinds = ["minVersion", "notesMatch", "fileMatch"].filter((k) => c?.[k] !== undefined);
      if (kinds.length !== 1) throw new Error(`${at}: each condition needs exactly one of minVersion | notesMatch | fileMatch`);
      if (c.minVersion !== undefined && !parseSemver(String(c.minVersion))) throw new Error(`${at}: minVersion ${c.minVersion} is not semver`);
      if (c.fileMatch && (!c.fileMatch.path || !c.fileMatch.pattern)) throw new Error(`${at}: fileMatch needs path + pattern`);
    }
    if (e.tagPattern) new RegExp(e.tagPattern);
    if (e.current !== undefined) e.current = String(e.current);
  }
  return l as WatchList;
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────
const ICON = { met: "✅", waiting: "⏳", error: "❌" } as const;
const cell = (s: string): string => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderSummary(results: EntryResult[], list: WatchList, file: string): string {
  const met = results.filter((r) => r.status === "met").length;
  const err = results.filter((r) => r.status === "error").length;
  const md = [
    `## 🔭 upstream release watch${list.target ? ` — Kubernetes ${list.target}` : ""}`, "",
    `\`${file}\` · ${results.length} watched · **${met} ✅ met** · ${results.length - met - err} ⏳ waiting${err ? ` · ${err} ❌ error` : ""}`, "",
    "| | Name | Current | Latest | Met by | Evidence | Issue |", "|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const latest = r.latest ? `[${r.latest}](${r.latestUrl})` : "—";
    const metBy = r.metVersion ? `[${r.metVersion}](${r.metUrl})${r.metPrerelease ? " (pre-release)" : ""}${r.metPublishedAt ? ` · ${r.metPublishedAt.slice(0, 10)}` : ""}` : "—";
    const evidence = r.error ? `error: ${r.error}` : [
      ...r.conditions.map((c) => `${conditionIcon(c)} ${c.detail}`),
      ...(r.extracts ?? []).map((x) => `📦 ${x.label}: ${x.value ? `\`${x.value}\`` : "— (not found)"}`),
    ].join("<br>");
    md.push(`| ${ICON[r.status]} | **${cell(r.name)}** ([${r.repo}](https://github.com/${r.repo}/releases)) | ${cell(r.current || "—")} | ${latest} | ${metBy} | ${cell(evidence)}${r.note ? `<br>_${cell(r.note)}_` : ""} | ${cell(r.issue || "—")} |`);
  }
  md.push("");
  return md.join("\n");
}

// ✅/⏳ for a gating condition; ℹ️ yes/no for an info-only one (it is a fact, not a wait)
export function conditionIcon(c: { met: boolean; info?: boolean }): string {
  return c.info ? (c.met ? "ℹ️ yes —" : "ℹ️ no —") : c.met ? "✅" : "⏳";
}

// The dedupe key: the entry name, or `name@version` with issuePer: version (one issue per new release).
export function issueKey(r: Pick<EntryResult, "name" | "metVersion" | "issuePer">): string {
  return r.issuePer === "version" ? `${r.name}@${r.metVersion}` : r.name;
}

export function marker(key: string): string {
  return `<!-- ${MARKER_PREFIX}:${key} -->`;
}

export function issueTitle(r: EntryResult, list: WatchList, entryTemplate = ""): string {
  const s = parseSemver(r.metVersion);
  return fill(entryTemplate || list.titleTemplate || DEFAULT_TITLE, {
    name: r.name, version: r.metVersion, target: list.target ?? "", tag: r.metTag ?? "", minor: s ? `${s.major}.${s.minor}` : "",
  }, false);
}

// Stable across runs (no run URL / timestamp) so an unchanged finding does not churn the open issue.
export function issueBody(r: EntryResult, list: WatchList, source = "the upstream release watcher"): string {
  const extracts = r.extracts ?? [];
  return [
    marker(issueKey(r)), "",
    `**${r.name}** (\`${r.repo}\`) shipped **[${r.metVersion}](${r.metUrl})**${r.metPrerelease ? " (pre-release)" : ""}, which meets the watch condition${list.target ? ` for Kubernetes ${list.target}` : ""}.`, "",
    ...(r.metTag ? [`- tag: \`${r.metTag}\``] : []),
    ...(r.metPublishedAt ? [`- released: ${r.metPublishedAt.slice(0, 10)}`] : []),
    `- release notes: ${r.metUrl}`,
    `- current pin: \`${r.current || "—"}\``,
    `- latest: [${r.latest}](${r.latestUrl})`,
    ...(r.note ? [`- note: ${r.note}`] : []), "",
    "**Evidence**", "",
    ...r.conditions.map((c) => `- ${conditionIcon(c)} \`${c.kind}\` — ${c.detail}`), "",
    ...(extracts.length ? [
      "**Extracted**", "",
      ...extracts.map((x) => `- ${x.label}: ${x.value ? `\`${x.value}\`` : "— not found"} _(from ${x.source})_`), "",
    ] : []),
    `Detected by ${source}. This issue is updated while it stays open; close it once the bump is planned — a closed issue is never reopened.`,
  ].join("\n");
}

// ── issues ──────────────────────────────────────────────────────────────────────────────────────
interface Issue { number: number; state: string; title: string; body?: string | null; html_url: string; pull_request?: unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listMarkedIssues(github: any, owner: string, repo: string, label: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await github.rest.issues.listForRepo({ owner, repo, state: "all", labels: label, per_page: 100, page });
    issues.push(...(data as Issue[]).filter((i) => !i.pull_request));
    if (data.length < 100) break;
  }
  return issues.filter((i) => (i.body ?? "").includes(`<!-- ${MARKER_PREFIX}:`));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureLabel(github: any, owner: string, repo: string, label: string): Promise<void> {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: label });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((err as any)?.status !== 404) throw err;
    await github.rest.issues.createLabel({ owner, repo, name: label, color: "0e8a16", description: "Upstream release watcher: a blocker shipped" });
  }
}

export type IssueAction = { action: "create" } | { action: "update"; number: number } | { action: "skip"; number: number; reason: string };

// Pure decision: one issue per key (entry name, or name@version), ever. Open → update (if changed); closed → leave alone.
export function decideIssue(existing: Issue[], key: string, title: string, body: string): IssueAction {
  const mine = existing.filter((i) => (i.body ?? "").includes(marker(key)));
  const open = mine.find((i) => i.state === "open");
  if (open) return open.title === title && (open.body ?? "") === body ? { action: "skip", number: open.number, reason: "up to date" } : { action: "update", number: open.number };
  const closed = mine[0];
  if (closed) return { action: "skip", number: closed.number, reason: "closed (acknowledged) — not reopened" };
  return { action: "create" };
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────
export function loadList(file: string, text: string, yqJson?: string): WatchList {
  return validateList(/\.json$/i.test(file) ? JSON.parse(text) : JSON.parse(yqJson ?? "null"));
}

export default async function run({ core, exec, github, context }: Ctx): Promise<EntryResult[]> {
  const env = process.env;
  const file = env.WATCH_FILE || ".github/upstream-watch.yaml";
  const createIssues = (env.CREATE_ISSUES ?? "true") === "true";
  const failOnError = (env.FAIL_ON_ERROR ?? "true") === "true";
  const [owner, repo] = (env.ISSUE_REPO || `${context.repo.owner}/${context.repo.repo}`).split("/");
  const source = context.workflow ? `the \`${context.workflow}\` workflow (upstream release watcher)` : "the upstream release watcher";

  let list: WatchList;
  try {
    const text = readFileSync(file, "utf8");
    let yq: string | undefined;
    if (!/\.json$/i.test(file)) {
      const r = await exec.getExecOutput("yq", ["-o=json", ".", file], { silent: true, ignoreReturnCode: true });
      if (r.exitCode !== 0) throw new Error(`yq could not parse ${file}: ${r.stderr.trim()}`);
      yq = r.stdout;
    }
    list = loadList(file, text, yq);
  } catch (err) {
    const msg = (err as Error).message;
    await core.summary.addRaw(`## 🔭 upstream release watch — ❌ invalid watch list\n\n\`${file}\`: ${msg}\n`, true).write();
    core.setOutput("results", "[]");
    core.setOutput("met", "[]");
    core.setFailed(`watch list ${file}: ${msg}`);
    return [];
  }
  const target = String(list.target ?? "");
  const label = list.label || "upstream-watch";

  const fileCache = new Map<string, string | null>();
  const fetchFile: FileFetcher = async (r, ref, path) => {
    const key = `${r}@${ref}:${path}`;
    if (!fileCache.has(key)) {
      const [o, n] = r.split("/");
      try {
        const { data } = await github.rest.repos.getContent({ owner: o, repo: n, ref, path });
        const text = typeof data === "string" ? data : Array.isArray(data) ? null : Buffer.from(data.content ?? "", data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
        fileCache.set(key, text);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any)?.status === 404) fileCache.set(key, null);
        else throw err;
      }
    }
    return fileCache.get(key) as string | null;
  };

  const results: EntryResult[] = [];
  for (const e of list.entries) {
    try {
      const [o, n] = e.repo.split("/");
      const releases: Release[] = [];
      for (let page = 1; page <= 3; page++) {
        const { data } = await github.rest.repos.listReleases({ owner: o, repo: n, per_page: 100, page });
        releases.push(...data);
        if (data.length < 100) break;
      }
      const r = await evaluateEntry(e, releases, target, fetchFile);
      results.push(r);
      core.info(`${r.status === "met" ? "✅" : "⏳"} ${e.name}: latest ${r.latest || "—"}${r.metVersion ? `, met by ${r.metVersion}` : ""}`);
    } catch (err) {
      const msg = (err as Error).message;
      core.warning(`${e.name}: ${msg}`);
      results.push({ name: e.name, repo: e.repo, current: e.current ?? "", latest: "", latestUrl: "", status: "error", metVersion: "", metUrl: "", conditions: [], note: e.note ?? "", error: msg });
    }
  }

  const met = results.filter((r) => r.status === "met");
  if (createIssues && met.length) {
    try {
      const existing = await listMarkedIssues(github, owner, repo, label);
      let labelReady = false;
      for (const r of met) {
        const title = issueTitle(r, list, list.entries.find((x) => x.name === r.name)?.titleTemplate);
        const body = issueBody(r, list, source);
        const a = decideIssue(existing, issueKey(r), title, body);
        if (a.action === "create") {
          if (!labelReady) { await ensureLabel(github, owner, repo, label); labelReady = true; }
          const { data } = await github.rest.issues.create({ owner, repo, title, body, labels: [label] });
          r.issue = `[#${data.number}](${data.html_url}) opened`;
        } else if (a.action === "update") {
          const { data } = await github.rest.issues.update({ owner, repo, issue_number: a.number, title, body });
          r.issue = `[#${data.number}](${data.html_url}) updated`;
        } else {
          r.issue = `#${a.number} ${a.reason}`;
        }
      }
    } catch (err) {
      const msg = `issues: ${(err as Error).message}`;
      core.warning(msg);
      for (const r of met) if (!r.issue) r.issue = `❌ ${msg}`;
      results.push({ name: "(issues)", repo: `${owner}/${repo}`, current: "", latest: "", latestUrl: "", status: "error", metVersion: "", metUrl: "", conditions: [], note: "", error: msg });
    }
  } else if (met.length) {
    for (const r of met) r.issue = "issues disabled (create-issues=false)";
  }

  await core.summary.addRaw(renderSummary(results, list, file), true).write();
  core.setOutput("results", JSON.stringify(results));
  core.setOutput("met", JSON.stringify(met.map((r) => ({ name: r.name, version: r.metVersion, url: r.metUrl }))));
  const errors = results.filter((r) => r.status === "error");
  if (errors.length && failOnError) core.setFailed(`${errors.length} watch entr${errors.length === 1 ? "y" : "ies"} failed: ${errors.map((r) => `${r.name} (${r.error})`).join("; ")}`);
  return results;
}
