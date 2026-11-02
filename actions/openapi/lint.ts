// 🔎 devsecops-openapi · lint — vacuum (pinned, checksummed) over every spec in SPEC_PATHS; any error fails.
// env: SPEC_PATHS (newline list), FAIL_ON_FINDINGS ("false" → report only). Output: data (LintResult JSON).
// Writes its own step summary in a `finally`, so a crash still summarizes. No secrets are read or printed.
import { parseSpecPaths, parseVacuum, renderLint, gate, type LintResult } from "./lib.ts";
import { install, VACUUM } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function run({ core, exec }: { core: any; exec: any; github?: any; context?: any }): Promise<void> {
  let result: LintResult | undefined;
  let failure = "";
  try {
    const specs = parseSpecPaths(process.env.SPEC_PATHS || "");
    await install(VACUUM, { core, exec });
    result = { specs: [], failed: false };
    for (const path of specs) {
      const r = await exec.getExecOutput("vacuum", ["lint", "-d", "-q", "-b", "--min-score", "0", path], { ignoreReturnCode: true, silent: true });
      const spec = parseVacuum(path, r.stdout + (r.stderr || ""), r.exitCode);
      core.startGroup(`${spec.ok ? "✅" : "❌"} ${path}`);
      core.info(spec.detail);
      core.endGroup();
      result.specs.push(spec);
    }
    result.failed = result.specs.some((s) => !s.ok);
    core.setOutput("data", JSON.stringify({ specs: result.specs.map((s) => ({ ...s, detail: "" })), failed: result.failed }));
  } catch (e: any) {
    failure = String(e?.message || e);
    core.setOutput("data", JSON.stringify({ specs: [], failed: true }));
    core.setFailed(failure);
  } finally {
    const md = failure ? `### 🔎 Lint (vacuum)\n\n❌ ${failure}\n` : result ? renderLint(result) : "### 🔎 Lint (vacuum)\n\n⏭️ nothing ran\n";
    await core.summary.addRaw(md, true).write();
  }
  if (result && gate(result, undefined, undefined).failed && process.env.FAIL_ON_FINDINGS !== "false") {
    core.setFailed(`vacuum: ${result.specs.filter((s) => !s.ok).map((s) => `${s.path} (${s.errors} error(s))`).join(", ")}`);
  }
}
