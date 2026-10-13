// "Sign anything" for an org: a Vault Transit signature over a canonical STATEMENT that names a
// subject digest (any sha256 — an image, a file, a release tarball), with the org's key
// (default <org>-ci-images, the same key image attestations use). Verified locally with the key's
// PUBLIC half (transit/keys/<key> read) — the signer policy ci-image-signer-<org> grants
// transit/sign + transit/keys read only, no transit/verify, by design.
//
//   statement = canonical JSON {_type, subject{name,digest}, signer{repository,ref,sha,run_id,workflow}, key, signed_at}
//   signature = Vault `vault:v<N>:<base64 ASN.1 DER ECDSA>` over SHA-256(statement)
//   verify    = node:crypto verify("sha256", statement, publicKeyPem, der) — anyone with the public key
//
// env: MODE=sign-digest, VAULT_ADDR, VAULT_TOKEN (hashicorp/vault-action exportToken), TRANSIT_PATH
// (default transit), TRANSIT_KEY, SUBJECT_DIGEST (sha256:<64 hex>), SUBJECT_NAME, and GitHub's own
// GITHUB_REPOSITORY / GITHUB_REF / GITHUB_SHA / GITHUB_RUN_ID / GITHUB_WORKFLOW_REF.
// Outputs: statement-b64, signature, key-version, public-key-b64, verified. Never prints the token.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { Ctx } from "./types.ts";

export const STATEMENT_TYPE = "https://vionix.dev/digest-signature/v1";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const KEY = /^[A-Za-z0-9._-]+$/;

export interface Signer { repository: string; ref: string; sha: string; run_id: string; workflow: string }

export function validateSubject(digest: string, name: string): void {
  if (!DIGEST.test(digest || "")) throw new Error(`subject-digest must be sha256:<64 lowercase hex> (got "${digest}")`);
  if (!NAME.test(name || "")) throw new Error(`subject-name must be 1-200 chars of [A-Za-z0-9._:/@+-] (got "${name}")`);
}

/** Canonical (sorted-key, no whitespace) JSON of the statement — what is hashed and signed. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function statement(digest: string, name: string, signer: Signer, key: string, signedAt: string): string {
  validateSubject(digest, name);
  return canonical({ _type: STATEMENT_TYPE, subject: { name, digest }, signer, key, signed_at: signedAt });
}

/** `vault:v3:MEUCIQ…` → { version: 3, der: Buffer }. */
export function parseVaultSignature(sig: string): { version: number; der: Buffer } {
  const m = /^vault:v(\d+):([A-Za-z0-9+/=]+)$/.exec(sig || "");
  if (!m) throw new Error("unexpected Transit signature format (want vault:v<N>:<base64>)");
  return { version: Number(m[1]), der: Buffer.from(m[2], "base64") };
}

/** Verify a Transit (ASN.1 DER ECDSA/RSA-PKCS1) signature over SHA-256(statement) with the public key. */
export function verifyStatement(stmt: string, sig: string, publicKeyPem: string): boolean {
  const { der } = parseVaultSignature(sig);
  return cryptoVerify("sha256", Buffer.from(stmt, "utf8"), createPublicKey(publicKeyPem), der);
}

export function transitUrl(addr: string, path: string, op: "sign" | "keys", key: string): string {
  if (!/^https?:\/\//.test(addr || "")) throw new Error("VAULT_ADDR must be an http(s) URL");
  if (!KEY.test(key || "")) throw new Error(`invalid transit key "${key}"`);
  const mount = (path || "transit").replace(/^\/+|\/+$/g, "");
  return `${addr.replace(/\/+$/, "")}/v1/${mount}/${op}/${key}${op === "sign" ? "/sha2-256" : ""}`;
}

export function summaryMarkdown(r: { name: string; digest: string; key: string; version?: number; verified?: boolean; signer: Signer; error?: string }): string {
  const rows = [
    `| subject | \`${r.name}\` |`,
    `| digest | \`${r.digest}\` |`,
    `| key | \`${r.key}\`${r.version ? ` v${r.version}` : ""} (Vault Transit, no transparency log) |`,
    `| signer | \`${r.signer.repository}\` @ \`${r.signer.ref}\` (${r.signer.sha.slice(0, 7)}), run ${r.signer.run_id} |`,
    `| verified with the public key | ${r.error ? "—" : r.verified ? "✅ yes" : "❌ NO"} |`,
  ];
  const head = r.error ? `## 🔏 digest signature — ❌ failed\n\n${r.error}\n\n` : `## 🔏 digest signature — ${r.verified ? "✅ signed + verified" : "❌ signature did not verify"}\n\n`;
  return `${head}| | |\n|---|---|\n${rows.join("\n")}\n`;
}

function headers(): Record<string, string> {
  const t = process.env.VAULT_TOKEN || "";
  if (!t) throw new Error("no VAULT_TOKEN — log in first (hashicorp/vault-action with exportToken: true)");
  const h: Record<string, string> = { "X-Vault-Token": t, "Content-Type": "application/json" };
  if (process.env.VAULT_NAMESPACE) h["X-Vault-Namespace"] = process.env.VAULT_NAMESPACE;
  return h;
}

export default async function run({ core }: Ctx): Promise<void> {
  const env = process.env;
  const signer: Signer = {
    repository: env.GITHUB_REPOSITORY || "", ref: env.GITHUB_REF || "", sha: env.GITHUB_SHA || "",
    run_id: env.GITHUB_RUN_ID || "", workflow: env.GITHUB_WORKFLOW_REF || "",
  };
  const digest = env.SUBJECT_DIGEST || "", name = env.SUBJECT_NAME || "", key = env.TRANSIT_KEY || "";
  try {
    const stmt = statement(digest, name, signer, key, new Date().toISOString());
    const addr = env.VAULT_ADDR || "";
    const s = await fetch(transitUrl(addr, env.TRANSIT_PATH || "transit", "sign", key), {
      method: "POST", headers: headers(), body: JSON.stringify({ input: Buffer.from(stmt, "utf8").toString("base64") }),
    });
    if (!s.ok) throw new Error(`Transit sign failed: HTTP ${s.status} (role must carry ci-image-signer-<org>; branch refs only)`);
    const signature: string = (await s.json())?.data?.signature || "";
    const { version } = parseVaultSignature(signature);
    const k = await fetch(transitUrl(addr, env.TRANSIT_PATH || "transit", "keys", key), { headers: headers() });
    if (!k.ok) throw new Error(`Transit key read failed: HTTP ${k.status}`);
    const pem: string = (await k.json())?.data?.keys?.[String(version)]?.public_key || "";
    if (!pem) throw new Error(`transit/keys/${key} v${version} has no public key (an asymmetric signing key is required)`);
    const verified = verifyStatement(stmt, signature, pem);
    core.setOutput("statement-b64", Buffer.from(stmt, "utf8").toString("base64"));
    core.setOutput("signature", signature);
    core.setOutput("key-version", version);
    core.setOutput("public-key-b64", Buffer.from(pem, "utf8").toString("base64"));
    core.setOutput("verified", String(verified));
    await core.summary.addRaw(summaryMarkdown({ name, digest, key, version, verified, signer }), true).write();
    if (!verified) core.setFailed("the Transit signature did not verify with the key's public half");
    else core.info(`🔏 signed ${name} ${digest} with ${key} v${version} — verified with the public key`);
  } catch (err) {
    const msg = (err as Error).message;
    await core.summary.addRaw(summaryMarkdown({ name, digest, key, signer, error: msg }), true).write();
    core.setFailed(`sign-digest: ${msg}`);
  }
}
