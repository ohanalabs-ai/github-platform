// 💥 devsecops-openapi · breaking — oasdiff (pinned, checksummed) compares each spec at the PR BASE with the
// PR HEAD. The base is a second checkout (git worktree) so relative $refs resolve in both trees. Skipped on
// anything but a pull request (unless BASE_REF is set), and per spec when the file is new in the PR.
// Only oasdiff level 3 (error) counts as breaking. It fails ONLY when BREAKING_MODE=enforce.
// env: SPEC_PATHS, BREAKING_MODE (advisory|enforce), BASE_REF (optional override of the PR base — a SHA/ref),
//      FAIL_ON_FINDINGS ("false" → report only). Output: data (BreakingResult JSON), breaking (true|false).
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseSpecPaths, parseMode, parseOasdiff, breakingCount, renderBreaking, type BreakingResult, type BreakingSpec, type Mode } from "./lib.ts";
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
    const base = (process.env.BASE_REF || "").trim() || context?.payload?.pull_request?.base?.sha || "";
    if (!base) {
      result.skipped = `${context?.eventName || "this event"} is not a pull request — there is no base to compare with`;
    } else {
      await install(OASDIFF, { core, exec });
      const wt = join(process.env.RUNNER_TEMP || "/tmp", "openapi-base");
      const add = await exec.exec("git", ["worktree", "add", "--detach", wt, base], { ignoreReturnCode: true });
      if (add !== 0) throw new Error(`cannot check out the base ${base} (fetch-depth: 0 needed)`);
      for (const path of specs) {
        const s: BreakingSpec = { path, status: "compared", changes: [] };
        if (!existsSync(join(wt, path))) { s.status = "new-file"; s.note = "new in this PR — nothing to compare"; }
        else if (!existsSync(path)) { s.status = "removed-in-head"; s.note = "deleted in this PR — removing a whole API is breaking by definition; review by hand"; }
        else {
          const r = await exec.getExecOutput("oasdiff", ["breaking", join(wt, path), path, "-f", "json"], { ignoreReturnCode: true, silent: true });
          if (r.exitCode !== 0) { s.status = "error"; s.note = `oasdiff exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`; }
          else s.changes = parseOasdiff(r.stdout);
        }
        core.info(`${s.path}: ${s.status}, ${s.changes.length} change(s)`);
        result.specs.push(s);
      }
      result.breaking = breakingCount(result.specs) > 0;
      await exec.exec("git", ["worktree", "remove", "--force", wt], { ignoreReturnCode: true, silent: true });
    }
    core.setOutput("breaking", String(result.breaking));
    core.setOutput("data", JSON.stringify(result));
  } catch (e: any) {
    failure = String(e?.message || e);
    core.setOutput("breaking", "false");
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
