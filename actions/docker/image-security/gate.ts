// The POLICY GATE — the job fails here, inside the reusable, when findings at or above the threshold
// exist. Callers never parse the status.
import type { Ctx } from "./types.ts";

export default async function run({ core }: Ctx): Promise<void> {
  const status = process.env.STATUS || "";
  if (status === "policy-fail") {
    return core.setFailed(`Image security policy: ${process.env.BLOCKING} finding(s) at or above ${process.env.THRESHOLD} in ${process.env.IMAGE_IN} — see the job summary`);
  }
  if (status !== "pass") return core.setFailed(`image security: unexpected status '${status || "missing"}'`);
  core.info(`✅ image security: ${status}`);
}
