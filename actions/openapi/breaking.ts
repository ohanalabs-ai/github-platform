// 💥 devsecops-openapi · breaking — oasdiff (pinned, checksummed) compares each spec at the PR BASE with the
// PR HEAD. The base is a second checkout (git worktree) so relative $refs resolve in both trees. Skipped on
// anything but a pull request (unless BASE_REF is set), and per spec when the file is new in the PR.
// Only oasdiff level 3 (error) counts as breaking. It fails ONLY when BREAKING_MODE=enforce.
// Intentional breaking changes: BREAKING_IGNORE_FILE names a file in the CALLER repo (oasdiff's native
// `--err-ignore` format, plus a mandatory ` # reason` per entry — see lib.ts). Each spec is diffed twice: plain
// (everything) and with the file (what is STILL breaking — the only thing the gate counts). The difference is
// "accepted" (listed with its reason); entries that name no breaking change are "stale" (a summary warning —
// they accept nothing, and failing on them would break every unrelated PR once a change lands in the base).
// An empty input, a missing file or a file with no entries behaves exactly as without the input.
// env: SPEC_PATHS, BREAKING_MODE (advisory|enforce), BASE_REF (optional override of the PR base — a SHA/ref),
//      BREAKING_IGNORE_FILE (optional), FAIL_ON_FINDINGS ("false" → report only).
// Output: data (BreakingResult JSON), breaking (true|false — AFTER the ignore file), accepted, stale (counts).
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  parseSpecPaths, parseMode, parseOasdiff, breakingCount, renderBreaking, safeRepoFile, parseIgnoreFile, toOasdiffIgnore,
  acceptedChanges, acceptedCount, staleEntries, type BreakingResult, type BreakingSpec, type Change, type IgnoreEntry, type Mode,
} from "./lib.ts";
import { install, OASDIFF } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function run({ core, exec, context }: { core: any; exec: any; github?: any; context: any }): Promise<void> {
  let mode: Mode = "advisory";
  let result: BreakingResult = { mode, specs: [], breaking: false };
  let failure = "";
  try {
    mode = parseMode(process.env.BREAKING_MODE, "breaking-change-mode");
    result = { mode, specs: [], breaking: false };
    const specs = parseSpecPaths(process.env.SPEC_PATHS || "");
    let entries: IgnoreEntry[] = [];
    if ((process.env.BREAKING_IGNORE_FILE || "").trim()) {
      const file = safeRepoFile(process.env.BREAKING_IGNORE_FILE, "breaking-ignore-file");
      result.ignoreFile = file;
      if (!existsSync(file)) {
        result.ignoreNote = `\`${file}\` does not exist in this checkout — no change is accepted (same as not setting the input)`;
        core.warning(result.ignoreNote);
      } else {
        entries = parseIgnoreFile(readFileSync(file, "utf8"));
        result.entries = entries;
        if (!entries.length) result.ignoreNote = `\`${file}\` has no entries — no change is accepted`;
      }
    }
    const base = (process.env.BASE_REF || "").trim() || context?.payload?.pull_request?.base?.sha || "";
    if (!base) {
      result.skipped = `${context?.eventName || "this event"} is not a pull request — there is no base to compare with`;
    } else {
      await install(OASDIFF, { core, exec });
      const tmp = process.env.RUNNER_TEMP || "/tmp";
      const wt = join(tmp, "openapi-base");
      const seen: Change[] = [];
      const ignoreCopy = join(tmp, "openapi-err-ignore.txt"); // entries only — the reasons stay in the caller's file
      if (entries.length) writeFileSync(ignoreCopy, toOasdiffIgnore(entries));
      const add = await exec.exec("git", ["worktree", "add", "--detach", wt, base], { ignoreReturnCode: true });
      if (add !== 0) throw new Error(`cannot check out the base ${base} (fetch-depth: 0 needed)`);
      for (const path of specs) {
        const s: BreakingSpec = { path, status: "compared", changes: [] };
        if (!existsSync(join(wt, path))) { s.status = "new-file"; s.note = "new in this PR — nothing to compare"; }
        else if (!existsSync(path)) { s.status = "removed-in-head"; s.note = "deleted in this PR — removing a whole API is breaking by definition; review by hand"; }
        else {
          const diff = (extra: string[]) => exec.getExecOutput("oasdiff", ["breaking", join(wt, path), path, "-f", "json", ...extra], { ignoreReturnCode: true, silent: true });
          const r = await diff([]);
          if (r.exitCode !== 0) { s.status = "error"; s.note = `oasdiff exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`; }
          else {
            const all = parseOasdiff(r.stdout);
            seen.push(...all);
            s.changes = all;
            if (entries.length) {
              const r2 = await diff(["--err-ignore", ignoreCopy]);
              if (r2.exitCode !== 0) { s.status = "error"; s.note = `oasdiff --err-ignore exited ${r2.exitCode}: ${(r2.stderr || r2.stdout).trim().slice(0, 300)}`; }
              else {
                s.changes = parseOasdiff(r2.stdout);
                s.accepted = acceptedChanges(all, s.changes, entries);
              }
            }
          }
        }
        core.info(`${s.path}: ${s.status}, ${s.changes.length} change(s)`);
        result.specs.push(s);
      }
      result.breaking = breakingCount(result.specs) > 0;
      if (entries.length) {
        result.stale = staleEntries(entries, seen);
        if (result.stale.length) core.warning(`${result.stale.length} stale entr${result.stale.length === 1 ? "y" : "ies"} in ${result.ignoreFile}: ${result.stale.map((e) => `line ${e.line}`).join(", ")} — delete them`);
      }
      await exec.exec("git", ["worktree", "remove", "--force", wt], { ignoreReturnCode: true, silent: true });
    }
    core.setOutput("breaking", String(result.breaking));
    core.setOutput("accepted", String(acceptedCount(result.specs)));
    core.setOutput("stale", String(result.stale?.length ?? 0));
    core.setOutput("data", JSON.stringify(result));
  } catch (e: any) {
    failure = String(e?.message || e);
    core.setOutput("breaking", "false");
    core.setOutput("accepted", "0");
    core.setOutput("stale", "0");
    core.setOutput("data", JSON.stringify({ ...result, skipped: `error: ${failure}` }));
    core.setFailed(failure);
  } finally {
    await core.summary.addRaw(failure ? `### 💥 Breaking changes (oasdiff)\n\n❌ ${failure}\n` : renderBreaking(result), true).write();
  }
  if (!failure && result.breaking && mode === "enforce" && process.env.FAIL_ON_FINDINGS !== "false") {
    core.setFailed(`${breakingCount(result.specs)} breaking change(s) and breaking-change-mode=enforce`);
  }
  if (!failure && result.specs.some((s) => s.status === "error")) core.setFailed("oasdiff could not compare every spec");
}
