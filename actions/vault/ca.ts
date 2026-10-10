// Write an optional custom Vault CA (base64 PEM, the vionix `caCertificate` shape) to CA_FILE and export
// VAULT_CACERT for the later steps (cosign's hashivault client reads it). The github-script steps that
// talk to Vault set NODE_EXTRA_CA_CERTS to the same file on their own `env:` (Node reads it at start-up).
// With a publicly trusted Vault (ACM / Let's Encrypt) CA_B64 is empty and this writes nothing.
import { writeFileSync } from "node:fs";
import type { Ctx } from "./types.ts";

export function decodeCa(b64: string): string {
  const pem = Buffer.from((b64 || "").replace(/\s+/g, ""), "base64").toString("utf8");
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) throw new Error("ca-certificate is not a base64-encoded PEM certificate");
  return pem;
}

export default async function run({ core }: Ctx): Promise<void> {
  const b64 = process.env.CA_B64 || "";
  const file = process.env.CA_FILE || "";
  if (!b64) {
    core.info("no custom CA — the Vault endpoint must present a publicly trusted certificate");
    return;
  }
  writeFileSync(file, decodeCa(b64), { mode: 0o644 });
  core.exportVariable("VAULT_CACERT", file);
  core.info(`custom Vault CA written to ${file}`);
}
