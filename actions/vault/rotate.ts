// 🔄 vault-rotate-secret — the generalized vionix "rotate a key in Vault" flow, run by actions/github-script@v8:
//   login (GitHub OIDC → JWT auth) → read the current KV v2 record (its version) → obtain the new value
//   (generate N random bytes, or take NEW_VALUE from a caller secret) → write it with check-and-set on the
//   version just read (a concurrent rotation fails instead of being silently overwritten) → optionally fire a
//   repository_dispatch so the downstream system reloads → revoke the Vault token.
// Differences from the vionix workflow it generalizes, on purpose: the value is NEVER echoed (the vionix
// job printed old and new values to the log), the token never crosses a step boundary, the previous value
// stays in KV v2's version history (rollback = `vault kv rollback -version=<previous-version>`), and other
// fields of the record are preserved (KEEP_FIELDS).
//
// Env: VAULT_URL VAULT_AUTH_PATH VAULT_ROLE VAULT_AUDIENCE KV_MOUNT SECRET_PATH FIELD SOURCE LENGTH ENCODING
//      NEW_VALUE KEEP_FIELDS OUTPUT_VALUE DISPATCH_REPOSITORY DISPATCH_EVENT
// Outputs: version, previous-version, value (only when OUTPUT_VALUE=true; masked), meter-event.
import { randomBytes } from "node:crypto";
import type { Ctx } from "./types.ts";
import { loginFromEnv, safePath, type Fetch } from "./client.ts";
import { meterEvent } from "./sign.ts";

export function generate(length: number, encoding: string): string {
  if (!Number.isInteger(length) || length < 16 || length > 1024) throw new Error("length must be an integer number of random BYTES in [16, 1024]");
  const b = randomBytes(length);
  switch (encoding) {
    case "base64": return b.toString("base64");
    case "base64url": return b.toString("base64url");
    case "hex": return b.toString("hex");
    default: throw new Error(`encoding must be base64|base64url|hex (got ${encoding})`);
  }
}

/** The record to write: the old record's other fields (keepFields) + the rotated field. */
export function nextRecord(current: Record<string, string> | undefined, field: string, value: string, keepFields: boolean): Record<string, string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(field)) throw new Error(`field must match [A-Za-z0-9_.-]+ (got ${JSON.stringify(field)})`);
  return { ...(keepFields ? current ?? {} : {}), [field]: value };
}

export default async function run({ core, github }: Ctx, f?: Fetch): Promise<void> {
  const env = process.env;
  const mount = safePath(env.KV_MOUNT || "", "kv-mount");
  const path = safePath(env.SECRET_PATH || "", "secret-path");
  const field = (env.FIELD || "value").trim();
  const source = (env.SOURCE || "generate").trim();

  let value: string;
  if (source === "generate") value = generate(Number(env.LENGTH || "32"), (env.ENCODING || "base64").trim());
  else if (source === "input") {
    value = env.NEW_VALUE || "";
    if (!value) return core.setFailed("source=input needs the new-value secret");
  } else return core.setFailed(`source must be generate|input (got ${source})`);
  core.setSecret(value);

  const vault = await loginFromEnv(core, env, f);
  try {
    const current = await vault.kvRead(mount, path);
    const cas = current?.version ?? 0;
    if (current && current.data[field] === value) throw new Error("the new value equals the current one — nothing rotated");
    const version = await vault.kvWrite(mount, path, nextRecord(current?.data, field, value, env.KEEP_FIELDS !== "false"), cas);
    core.setOutput("version", String(version));
    core.setOutput("previous-version", String(cas));
    if (env.OUTPUT_VALUE === "true") core.setOutput("value", value);
    core.setOutput("meter-event", meterEvent("rotate", env, { mount, path, field, version }));
    core.info(`🔄 ${mount}/${path} field ${field}: v${cas} → v${version} (cas ${cas})`);

    const repo = (env.DISPATCH_REPOSITORY || "").trim();
    if (repo) {
      const [owner, name] = repo.split("/");
      if (!owner || !name) throw new Error("dispatch-repository must be owner/name");
      await github.rest.repos.createDispatchEvent({
        owner,
        repo: name,
        event_type: (env.DISPATCH_EVENT || "vault-secret-rotated").trim(),
        // never the value — the receiver reads it from Vault with its own role
        client_payload: { vault: vault.url, mount, path, field, version, previous_version: cas, run: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` },
      });
      core.info(`📣 repository_dispatch ${env.DISPATCH_EVENT || "vault-secret-rotated"} → ${repo}`);
    }
    await core.summary.addRaw(`### 🔄 vault-rotate-secret\n\n| | |\n|---|---|\n| vault | \`${vault.url}\` |\n| role | \`${env.VAULT_ROLE}\` |\n| record | \`${mount}/${path}\` field \`${field}\` |\n| version | v${cas} → **v${version}** (previous kept in KV history) |\n| value | ${source === "generate" ? "generated, " : "from the caller's secret, "}never logged |\n${repo ? `| dispatch | \`${repo}\` |\n` : ""}`).write();
  } finally {
    await vault.revokeSelf().catch((e) => core.warning(`token revoke-self failed (it still expires with its TTL): ${e instanceof Error ? e.message : e}`));
  }
}
