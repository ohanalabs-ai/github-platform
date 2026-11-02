// 🔁 devsecops-openapi · drift — run the caller's generate command (setup-go already ran), then fail when
// `git status --porcelain` is non-empty: the committed generated code does not match the spec. The files
// are listed in the summary. The reusable's own helper checkout (.openapi-platform) is excluded.
// env: GENERATE_COMMAND, WORKING_DIRECTORY (cwd of the command), FAIL_ON_FINDINGS ("false" → report only).
// Output: data (DriftResult JSON), drift (true|false).
import { parsePorcelain, renderDrift, safeWorkdir, type DriftResult } from "./lib.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function run({ core, exec }: { core: any; exec: any; github?: any; context?: any }): Promise<void> {
  const command = (process.env.GENERATE_COMMAND || "").trim();
  let result: DriftResult = { command, generateExit: 0, files: [], drift: false };
  let failure = "";
  try {
    if (!command) {
      result = { ...result, skipped: "generate-command is empty" };
    } else {
      const cwd = safeWorkdir(process.env.WORKING_DIRECTORY);
      const before = await exec.getExecOutput("git", ["status", "--porcelain"], { silent: true });
      const dirty = parsePorcelain(before.stdout);
      if (dirty.length) core.warning(`the working tree was already dirty before generating: ${dirty.join(", ")}`);
      core.info(`$ ${command}   (cwd ${cwd})`);
      const code = await exec.exec("bash", ["-c", command], { cwd, ignoreReturnCode: true });
      const after = await exec.getExecOutput("git", ["status", "--porcelain"], { silent: true });
      const files = parsePorcelain(after.stdout);
      result = { command, generateExit: code, files, drift: files.length > 0 };
      if (files.length) {
        const diff = await exec.getExecOutput("git", ["--no-pager", "diff", "--stat", "--", ".", `:(exclude).openapi-platform`], { silent: true, ignoreReturnCode: true });
        core.info(diff.stdout);
      }
    }
    core.setOutput("drift", String(result.drift));
    core.setOutput("data", JSON.stringify(result));
  } catch (e: any) {
    failure = String(e?.message || e);
    core.setOutput("drift", "false");
    core.setOutput("data", JSON.stringify({ ...result, generateExit: 1 }));
    core.setFailed(failure);
  } finally {
    await core.summary.addRaw(failure ? `### 🔁 Codegen drift\n\n❌ ${failure}\n` : renderDrift(result), true).write();
  }
  if (!failure && process.env.FAIL_ON_FINDINGS !== "false") {
    if (result.generateExit !== 0) core.setFailed(`generate command exited ${result.generateExit}`);
    else if (result.drift) core.setFailed(`codegen drift: ${result.files.length} file(s) differ after \`${command}\``);
  }
}
