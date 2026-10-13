// 🔐 Decide whether THIS run may sign with the org's Vault Transit key (pure decision in policy.ts)
// and stage the optional private-CA bundle for Vault. Runs before the tailnet join and the Vault
// login, so a run that must not sign never touches either.
//
// env: EVENT_NAME, REF, SIGNING_REFS, VAULT_URL, VAULT_ROLE, TRANSIT_KEY, VAULT_CA_CERT (base64 PEM, optional)
// outputs: sign (true|false), reason, ca-file (path of the decoded PEM, or empty)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "./policy.ts";
import type { Ctx } from "./types.ts";

export default async function run({ core }: Ctx): Promise<void> {
  const e = process.env;
  let d;
  try {
    d = decide({
      eventName: e.EVENT_NAME || "", ref: e.REF || "", signingRefs: e.SIGNING_REFS || "",
      vaultUrl: e.VAULT_URL || "", vaultRole: e.VAULT_ROLE || "", transitKey: e.TRANSIT_KEY || "",
    });
  } catch (err) {
    core.setFailed((err as Error).message);
    return;
  }
  let caFile = "";
  const ca = (e.VAULT_CA_CERT || "").trim();
  if (d.sign && ca) {
    const pem = Buffer.from(ca, "base64").toString("utf8");
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      core.setFailed("vault-ca-cert must be a base64-encoded PEM certificate bundle");
      return;
    }
    caFile = join(e.RUNNER_TEMP || "/tmp", "vault-ca.pem");
    writeFileSync(caFile, pem);
  }
  core.setOutput("sign", String(d.sign));
  core.setOutput("reason", d.reason);
  core.setOutput("ca-file", caFile);
  if (d.sign) core.info(`🔐 will sign with transit key ${e.TRANSIT_KEY} (${d.reason})`);
  else core.notice(`🔐 not signing: ${d.reason}`);
}
