// 📐 devsecops-openapi — pure helpers (no I/O): input parsing, tool-output parsing, gate logic and the
// markdown the jobs, the step summary and the sticky PR comment share. Erasable TypeScript, no npm deps.
// Tested by lib.test.ts (node:test).

export const HELPERS_DIR = ".openapi-platform"; // where the reusable checks out its own helpers (excluded from drift)
export const COMMENT_MARKER = (key: string): string => `<!-- github-platform/devsecops-openapi:${key} -->`;

export type Mode = "advisory" | "enforce";

/** Newline-separated spec paths → clean, de-duplicated, repo-relative paths. Throws on anything unsafe. */
export function parseSpecPaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || "").split("\n")) {
    const p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    if (p.startsWith("/") || p.split("/").includes("..") || !/^[A-Za-z0-9._\-/@+]+$/.test(p)) {
      throw new Error(`unsafe spec path ${JSON.stringify(p)} — use repo-relative paths made of [A-Za-z0-9._-/@+]`);
    }
    if (!out.includes(p)) out.push(p);
  }
  if (!out.length) throw new Error("spec-paths is empty — list at least one OpenAPI file");
  return out;
}

export function parseMode(v: string | undefined, name: string): Mode {
  const m = (v || "advisory").trim();
  if (m !== "advisory" && m !== "enforce") throw new Error(`${name} must be advisory or enforce (got ${JSON.stringify(m)})`);
  return m;
}

/** A path with the working directory resolved (`.` or empty = the repo root); rejects escapes. */
export function safeWorkdir(v: string | undefined): string {
  const w = (v || ".").trim() || ".";
  if (w.startsWith("/") || w.split("/").includes("..")) throw new Error(`working-directory must stay inside the repository (got ${JSON.stringify(w)})`);
  return w;
}

// ---- vacuum -------------------------------------------------------------------------------------------

export interface LintSpec { path: string; ok: boolean; errors: number; warnings: number; infos: number; detail: string }
export interface LintResult { specs: LintSpec[]; failed: boolean }

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** vacuum's closing line: `✗ Failed with 3 errors, 4 warnings and 0 informs.` / `▲ Passed with 0 errors, …`. */
export function parseVacuum(path: string, stdout: string, exitCode: number): LintSpec {
  const clean = stdout.replace(ANSI, "");
  const m = clean.match(/(?:Passed|Failed) with (\d+) errors?, (\d+) warnings? and (\d+) informs?/);
  const [errors, warnings, infos] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  // The exit code is the truth (a crash or an unreadable spec has no summary line); an unparsable run counts as an error.
  const ok = exitCode === 0 && errors === 0;
  return { path, ok, errors: ok || errors ? errors : 1, warnings, infos, detail: tail(clean, 60) };
}

export function tail(text: string, lines: number): string {
  const l = text.trimEnd().split("\n");
  return (l.length > lines ? ["…", ...l.slice(-lines)] : l).join("\n");
}

// ---- oasdiff ------------------------------------------------------------------------------------------

export interface Change { id: string; text: string; level: number; operation?: string; path?: string }
export type BreakingStatus = "compared" | "new-file" | "removed-in-head" | "error";
/** A breaking change the caller's ignore file accepted, with the entry's human reason. */
export interface AcceptedChange { change: Change; reason: string; entry?: number }
/** `changes` is what is STILL reported after the ignore file was applied; `accepted` is what it waved through. */
export interface BreakingSpec { path: string; status: BreakingStatus; changes: Change[]; note?: string; accepted?: AcceptedChange[] }
export interface BreakingResult {
  mode: Mode; skipped?: string; specs: BreakingSpec[]; breaking: boolean;
  /** breaking-ignore-file: the path asked for, what became of it, and the entries that matched nothing. */
  ignoreFile?: string; ignoreNote?: string; entries?: IgnoreEntry[]; stale?: IgnoreEntry[];
}

/** oasdiff `breaking -f json`: an array of changes, level 1 info · 2 warning · 3 error. Only level 3 is breaking. */
export function parseOasdiff(json: string): Change[] {
  const t = json.trim();
  if (!t || t === "null") return [];
  const data = JSON.parse(t);
  if (!Array.isArray(data)) throw new Error("oasdiff output is not a JSON array");
  return data.map((c) => ({ id: String(c.id ?? ""), text: String(c.text ?? ""), level: Number(c.level ?? 0), operation: c.operation, path: c.path }));
}

export const isBreaking = (c: Change): boolean => c.level >= 3;
export const breakingCount = (specs: BreakingSpec[]): number => specs.reduce((n, s) => n + s.changes.filter(isBreaking).length, 0);

export const acceptedCount = (specs: BreakingSpec[]): number => specs.reduce((n, s) => n + (s.accepted?.length ?? 0), 0);

// ---- breaking-ignore-file (intentional breaking changes) ----------------------------------------------
//
// The file is oasdiff's NATIVE `--err-ignore` format: one line per accepted change, written exactly as
// `oasdiff breaking` names it — `<METHOD> <path> <text>` (matched case-insensitively). We add one rule on
// top: every entry ends with ` # <reason>` (oasdiff matches by containment, so the trailing comment is
// harmless to it). Blank lines and lines that start with `#` are ignored.

export interface IgnoreEntry { line: number; entry: string; reason: string }

/** Repo-relative file path (same safety rules as a spec path). */
export function safeRepoFile(v: string | undefined, name: string): string {
  const p = (v || "").trim();
  if (p.startsWith("/") || p.split("/").includes("..") || !/^[A-Za-z0-9._\-/@+]+$/.test(p)) {
    throw new Error(`${name} must be a repo-relative path made of [A-Za-z0-9._-/@+] (got ${JSON.stringify(p)})`);
  }
  return p;
}

/** Parse the ignore file. Throws when an entry has no reason — an unexplained exception is not accepted. */
export function parseIgnoreFile(text: string): IgnoreEntry[] {
  const out: IgnoreEntry[] = [];
  (text || "").split("\n").forEach((raw, i) => {
    const l = raw.replace(/\r$/, "").trim();
    if (!l || l.startsWith("#")) return;
    const at = l.indexOf(" # ");
    const entry = (at < 0 ? l : l.slice(0, at)).trim();
    const reason = at < 0 ? "" : l.slice(at + 3).trim();
    if (!reason) throw new Error(`ignore file line ${i + 1}: entry has no reason — write "<METHOD> <path> <oasdiff text> # <why this breaking change is intentional>"`);
    if (!entry) throw new Error(`ignore file line ${i + 1}: empty entry before the "# reason"`);
    out.push({ line: i + 1, entry, reason });
  });
  return out;
}

/** What `oasdiff breaking` calls a change, and what an ignore entry must contain: `<METHOD> <path> <text>`. */
export const changeKey = (c: Change): string => [c.operation, c.path, c.text].filter((x) => x).join(" ");
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
export const entryMatches = (entry: string, c: Change): boolean => norm(entry).includes(norm(changeKey(c)));

/** Entries only (no reasons), one per line — what is handed to `oasdiff --err-ignore`. */
export const toOasdiffIgnore = (entries: IgnoreEntry[]): string => entries.map((e) => e.entry).join("\n") + "\n";

const sig = (c: Change): string => `${c.id}\u0000${changeKey(c)}`;

/** The breaking (level 3) changes in `all` that oasdiff no longer reports in `remaining` (multiset difference),
 *  each attributed to the first entry that names it. */
export function acceptedChanges(all: Change[], remaining: Change[], entries: IgnoreEntry[]): AcceptedChange[] {
  const left = new Map<string, number>();
  for (const c of remaining.filter(isBreaking)) left.set(sig(c), (left.get(sig(c)) ?? 0) + 1);
  const out: AcceptedChange[] = [];
  for (const c of all.filter(isBreaking)) {
    const n = left.get(sig(c)) ?? 0;
    if (n > 0) { left.set(sig(c), n - 1); continue; }
    const e = entries.find((x) => entryMatches(x.entry, c));
    out.push({ change: c, reason: e?.reason ?? "(accepted by oasdiff's ignore matching)", entry: e?.line });
  }
  return out;
}

/** Entries that name none of the breaking changes seen across ALL specs — the change is gone (merged into the
 *  base, reverted) or the text drifted; either way the entry accepts nothing and should be deleted. */
export function staleEntries(entries: IgnoreEntry[], seen: Change[]): IgnoreEntry[] {
  const br = seen.filter(isBreaking);
  return entries.filter((e) => !br.some((c) => entryMatches(e.entry, c)));
}

// ---- drift --------------------------------------------------------------------------------------------

export interface DriftResult { skipped?: string; command: string; generateExit: number; files: string[]; drift: boolean }

/** `git status --porcelain` lines → paths (renames keep the new name), minus the reusable's own helper checkout. */
export function parsePorcelain(text: string, ignore: string[] = [HELPERS_DIR]): string[] {
  const files: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.replace(/^"|"$/g, "");
    if (ignore.some((i) => p === i || p.startsWith(`${i}/`))) continue;
    files.push(p);
  }
  return files;
}

// ---- gate ---------------------------------------------------------------------------------------------

export interface Verdict { lint: boolean; drift: boolean; breaking: boolean; failed: boolean }

/** Which findings block: lint errors and drift always; breaking changes only when mode=enforce. */
export function gate(lint: LintResult | undefined, drift: DriftResult | undefined, breaking: BreakingResult | undefined): Verdict {
  const l = !!lint?.failed;
  const d = !!drift && (drift.drift || drift.generateExit !== 0);
  const b = !!breaking && breaking.breaking && breaking.mode === "enforce";
  return { lint: l, drift: d, breaking: b, failed: l || d || b };
}

// ---- markdown -----------------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderLint(r: LintResult): string {
  const md = ["### 🔎 Lint (vacuum)", "", "| Spec | Result | Errors | Warnings |", "|---|---|---|---|"];
  for (const s of r.specs) md.push(`| \`${s.path}\` | ${s.ok ? "✅ pass" : "❌ fail"} | ${s.errors} | ${s.warnings} |`);
  return md.join("\n") + "\n";
}

export function renderDrift(r: DriftResult): string {
  const md = ["### 🔁 Codegen drift", ""];
  if (r.skipped) return md.concat(`⏭️ skipped — ${r.skipped}`, "").join("\n");
  md.push(`Command: \`${r.command}\``, "");
  if (r.generateExit !== 0) md.push(`❌ the generate command exited ${r.generateExit}`, "");
  if (r.drift) {
    md.push(`❌ **drift** — the committed code is stale; run the generate command and commit ${r.files.length} file(s):`, "");
    for (const f of r.files.slice(0, 50)) md.push(`- \`${f}\``);
    if (r.files.length > 50) md.push(`- … and ${r.files.length - 50} more`);
  } else if (r.generateExit === 0) md.push("✅ no drift — regenerating changes nothing");
  return md.join("\n") + "\n";
}

export function renderBreaking(r: BreakingResult): string {
  const md = [`### 💥 Breaking changes (oasdiff · mode \`${r.mode}\`)`, ""];
  if (r.skipped) return md.concat(`⏭️ skipped — ${r.skipped}`, "").join("\n");
  md.push("| Spec | Status | Breaking | Other |", "|---|---|---|---|");
  for (const s of r.specs) {
    const b = s.changes.filter(isBreaking).length;
    md.push(`| \`${s.path}\` | ${s.status === "compared" ? (b ? "💥 breaking" : "✅ compatible") : s.status === "error" ? "❌ error" : `⏭️ ${s.status}`} | ${b} | ${s.changes.length - b} |`);
  }
  md.push("");
  for (const s of r.specs) {
    const list = s.changes.filter(isBreaking);
    if (s.note) md.push(`- \`${s.path}\`: ${esc(s.note)}`);
    for (const c of list.slice(0, 30)) md.push(`- 💥 \`${s.path}\` ${c.operation ?? ""} ${c.path ?? ""} — ${esc(c.text)} (\`${c.id}\`)`);
    if (list.length > 30) md.push(`- … and ${list.length - 30} more in \`${s.path}\``);
  }
  const acc = r.specs.flatMap((x) => (x.accepted ?? []).map((a) => ({ spec: x.path, ...a })));
  if (acc.length || r.stale?.length || r.ignoreNote) {
    md.push("", `#### 🤝 Intentional breaking changes (\`${r.ignoreFile}\`)`, "");
    if (r.ignoreNote) md.push(`- ${esc(r.ignoreNote)}`, "");
    if (acc.length) md.push(`✅ **${acc.length} accepted** — listed in the ignore file, each with its reason:`, "", "| Spec | Change | Reason |", "|---|---|---|");
    for (const a of acc.slice(0, 60)) md.push(`| \`${a.spec}\` | ${esc(`${a.change.operation ?? ""} ${a.change.path ?? ""} — ${a.change.text}`)} | ${esc(a.reason)} |`);
    if (acc.length > 60) md.push(`| … | and ${acc.length - 60} more | |`);
    if (r.stale?.length) {
      md.push("", `⚠️ **${r.stale.length} stale entr${r.stale.length === 1 ? "y" : "ies"}** — matches no breaking change any more (merged into the base, reverted or reworded). It accepts nothing; delete it:`, "");
      for (const e of r.stale.slice(0, 30)) md.push(`- line ${e.line}: \`\` ${esc(e.entry)} \`\` — _${esc(e.reason)}_`);
    }
  }
  const open = r.specs.flatMap((x) => x.changes.filter(isBreaking));
  if (open.length && r.ignoreFile) {
    md.push("", "<details><summary>To accept the remaining change(s) as intentional, add to the ignore file</summary>", "", "```");
    for (const c of open.slice(0, 30)) md.push(`${changeKey(c)} # <why this breaking change is intentional>`);
    md.push("```", "", "</details>");
  }
  if (r.breaking) md.push("", r.mode === "enforce" ? "**Blocking** — `breaking-change-mode: enforce`." : "_Advisory — not blocking (`breaking-change-mode: advisory`)._");
  return md.join("\n") + "\n";
}

export function renderComment(title: string, lint?: LintResult, drift?: DriftResult, breaking?: BreakingResult, v?: Verdict): string {
  const head = v ? (v.failed ? "❌ **blocked**" : breaking?.breaking ? "⚠️ **passes, with breaking changes (advisory)**" : "✅ **passes**") : "";
  return [
    `## 🧭 ${title} ${head}`, "",
    lint ? renderLint(lint) : "### 🔎 Lint\n\n⏭️ did not run\n",
    drift ? renderDrift(drift) : "### 🔁 Codegen drift\n\n⏭️ did not run\n",
    breaking ? renderBreaking(breaking) : "### 💥 Breaking changes\n\n⏭️ did not run\n",
  ].join("\n");
}

export function safeJson<T>(text: string | undefined): T | undefined {
  if (!text || !text.trim()) return undefined;
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

/** The sticky-comment key: caller-chosen text made safe inside an HTML comment (no `--`, no `>`). */
export function commentKey(v: string | undefined): string {
  const k = (v || "openapi").replace(/[^A-Za-z0-9._/|]+/g, "_").slice(0, 120);
  return k || "openapi";
}
