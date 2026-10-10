// 🔏 vault-sign — "sign digest D with key K at Vault V", run by actions/github-script@v8:
//   const { default: run } = await import(`${dir}/sign.ts`); await run({ core, exec, github, context });
//
// Logs in to Vault with the job's GitHub OIDC token (JWT auth), then:
//   MODE=digest  Transit-signs a SHA-256 digest (DIGEST) in pure TypeScript → output `signature`
//               (`vault:vN:<b64 ASN.1 ECDSA>`), self-verifies it with transit/verify.
//   MODE=cosign  `cosign sign --key hashivault://<KEY>` the image IMAGE (must be pinned by digest) with no
//               transparency-log upload (a private key in a private Vault has no public log to belong to),
//               then `cosign verify` with the same key.
// Both modes read the key first and REFUSE a key that is exportable or allows plaintext backup
// (REQUIRE_NON_EXPORTABLE=true, the default) — a signing key that can leave Vault is not a Vault key.
// The Vault token is masked, used only inside this process, and revoked before the step ends.
//
// Env: VAULT_URL VAULT_AUTH_PATH VAULT_ROLE VAULT_AUDIENCE TRANSIT_PATH KEY MODE DIGEST IMAGE
//      REQUIRE_NON_EXPORTABLE VERIFY REGISTRY REGISTRY_USERNAME REGISTRY_PASSWORD
// Outputs: signature, key-version, public-key (PEM, base64), signed-ref, meter-event (CloudEvents JSON).
import type { Ctx } from "./types.ts";
import { loginFromEnv, type Fetch } from "./client.ts";

export function imageDigest(image: string): string {
  const m = /@(sha256:[0-9a-f]{64})$/.exec((image || "").trim());
  if (!m) throw new Error("IMAGE must be pinned by digest: <registry>/<repo>@sha256:<64 hex> (a tag can move after signing)");
  return m[1];
}

/** The usage record a metering pipeline (OpenMeter) would ingest — emitted as an output only. */
export function meterEvent(kind: "sign" | "rotate", env: NodeJS.ProcessEnv, data: Record<string, unknown>): string {
  return JSON.stringify({
    specversion: "1.0",
    type: `dev.planeo.vault.${kind}`,
    id: `${env.GITHUB_RUN_ID || "local"}-${env.GITHUB_RUN_ATTEMPT || "1"}-${env.GITHUB_JOB || "job"}-${kind}`,
    source: `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY || ""}`,
    subject: env.VAULT_ROLE || "",
    time: new Date().toISOString(),
    data,
  });
}

export function cosignSignArgs(key: string, image: string): string[] {
  return ["sign", "--yes", "--key", `hashivault://${key}`, "--use-signing-config=false", "--tlog-upload=false", image];
}

export function cosignVerifyArgs(key: string, image: string): string[] {
  return ["verify", "--key", `hashivault://${key}`, "--insecure-ignore-tlog=true", image];
}

export default async function run({ core, exec }: Ctx, f?: Fetch): Promise<void> {
  const env = process.env;
  const mode = (env.MODE || "digest").trim();
  const transit = env.TRANSIT_PATH || "transit";
  const key = (env.KEY || "").trim();
  if (!key) return core.setFailed("key is required");
  if (mode !== "digest" && mode !== "cosign") return core.setFailed(`mode must be digest|cosign (got ${mode})`);

  const vault = await loginFromEnv(core, env, f);
  try {
    const pk = await vault.publicKey(transit, key);
    if (env.REQUIRE_NON_EXPORTABLE !== "false" && (pk.exportable || pk.allowPlaintextBackup)) {
      throw new Error(`transit key ${key} is exportable=${pk.exportable} allow_plaintext_backup=${pk.allowPlaintextBackup} — refusing to sign with a key that can leave Vault`);
    }
    core.setOutput("public-key", Buffer.from(pk.pem).toString("base64"));
    core.setOutput("key-version", String(pk.version));

    let summary = "";
    if (mode === "digest") {
      const digest = (env.DIGEST || "").trim();
      const { signature, keyVersion } = await vault.signDigest(transit, key, digest);
      if (env.VERIFY !== "false" && !(await vault.verifyDigest(transit, key, digest, signature))) throw new Error("transit verify returned valid=false for the signature just produced");
      core.setOutput("signature", signature);
      core.setOutput("key-version", String(keyVersion));
      core.setOutput("signed-ref", digest.startsWith("sha256:") ? digest : `sha256:${digest}`);
      summary = `| digest | \`${digest}\` |\n| signature | \`${signature.slice(0, 24)}…\` (key v${keyVersion}) |`;
      core.setOutput("meter-event", meterEvent("sign", env, { mode, key, keyVersion, transit }));
    } else {
      const image = (env.IMAGE || "").trim();
      imageDigest(image);
      const childEnv: Record<string, string> = {
        ...(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>),
        VAULT_ADDR: vault.url,
        VAULT_TOKEN: vault.token,
        TRANSIT_SECRET_ENGINE_PATH: transit,
        COSIGN_YES: "true",
      };
      delete childEnv.REGISTRY_PASSWORD;
      if (env.REGISTRY && env.REGISTRY_PASSWORD) {
        await exec.exec("cosign", ["login", env.REGISTRY, "-u", env.REGISTRY_USERNAME || "x-access-token", "--password-stdin"], { input: Buffer.from(env.REGISTRY_PASSWORD), env: childEnv });
      }
      await exec.exec("cosign", cosignSignArgs(key, image), { env: childEnv });
      if (env.VERIFY !== "false") await exec.exec("cosign", cosignVerifyArgs(key, image), { env: childEnv });
      core.setOutput("signed-ref", image);
      core.setOutput("signature", "");
      summary = `| image | \`${image}\` |\n| signature | cosign, key \`hashivault://${key}\` v${pk.version}, no tlog |`;
      core.setOutput("meter-event", meterEvent("sign", env, { mode, key, keyVersion: pk.version, transit, image }));
    }
    await core.summary.addRaw(`### 🔏 vault-sign\n\n| | |\n|---|---|\n| vault | \`${vault.url}\` |\n| role | \`${env.VAULT_ROLE}\` |\n| key | \`${transit}/keys/${key}\` |\n${summary}\n`).write();
  } finally {
    await vault.revokeSelf().catch((e) => core.warning(`token revoke-self failed (it still expires with its TTL): ${e instanceof Error ? e.message : e}`));
  }
}
