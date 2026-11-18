// 👀 visual review — runs only AFTER a required reviewer approved the Environment (GitHub's "Review deployments" dialog cannot show
// custom text, so the checklist is re-printed here, next to the approval, and in the run summary by the job before).
// Env: CHECKLIST (markdown from the prepare job), URL.
import type { Ctx } from "./types.ts";

export default async function run({ core, context }: Ctx): Promise<void> {
  const md = process.env.CHECKLIST || "";
  const who = context.actor || "a reviewer";
  await core.summary.addRaw(`${md}\n\n---\n✅ **Visual LGTM** of ${process.env.URL} — approved through the Environment by **${who}**.\n`, true).write();
  core.notice(`visual review approved: ${process.env.URL}`);
}
