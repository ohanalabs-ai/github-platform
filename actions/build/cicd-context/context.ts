// 🧬 cicd-context — the vionix-cicd CONTEXT ENVELOPE: one versioned JSON document that a setup job
// resolves (tailnet, Vault, config) and every later job of a vionix-cicd pipeline consumes and enriches.
// It replaces "N inputs + M secrets per reusable workflow" with ONE input (`vionix-context`) + ONE secret
// (`CONFIG_STREAM_KEY`) — the owner's config-stream encoder/decoder design
// (ohanalabs-ai/ohana-github actions/build/config-stream-{encoder,decoder}), re-done ENCRYPTED.
//
//   { schema: "vionix.dev/cicd-context/v1", version, plain: {...}, sealed: "<b64>", trail: [...] }
//
// * plain  — readable by YAML expressions (`fromJSON(needs.setup.outputs.context).plain.image.digest`):
//            `if:`, matrices and `runs-on` can only read plaintext. Never put a secret here.
// * sealed — AES-256-GCM (node:crypto) of the canonical JSON of the secret sections; 12-byte random IV;
//            AAD = canonical {schema, version, plain, trail}, so a tampered or mismatched readable part
//            fails to open. Layout: base64(iv | tag | ciphertext).
// * trail  — who added which section (stage, job, run attempt): append-only provenance of the context.
// * Sections are APPEND-ONLY: enrich never overwrites an existing plain or sealed section.
// * Size: job outputs are capped at 1 MB per job; the serialized envelope must stay under 900 KB
//   (put reports/SBOMs in artifacts and reference them).
//
// Modes (env MODE): seal | open | enrich — see run() and action.yaml.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Ctx } from "./types.ts";

export const SCHEMA = "vionix.dev/cicd-context/v1";
export const MAX_BYTES = 900 * 1024;

export type Section = Record<string, unknown>;
export interface Plain { org: string; githubHost: string; [section: string]: unknown }
export type Secrets = Record<string, Record<string, string>>; // section → name → value
export interface TrailEntry { stage: string; job: string; runAttempt?: number; added: string[] }
export interface Envelope { schema: string; version: number; plain: Plain; sealed: string; trail: TrailEntry[] }

const RESERVED = new Set(["org", "githubHost"]);

// Stable JSON: keys sorted at every level, so the AAD is identical wherever it is recomputed.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

export function decodeKey(key: string): Buffer {
  const k = Buffer.from((key || "").trim(), "base64");
  if (k.length !== 32) throw new Error("CONFIG_STREAM_KEY must be 32 bytes, base64-encoded (got " + k.length + " bytes)");
  return k;
}

function aad(e: Pick<Envelope, "schema" | "version" | "plain" | "trail">): Buffer {
  return Buffer.from(canonical({ schema: e.schema, version: e.version, plain: e.plain, trail: e.trail }));
}

function validateSecrets(s: Secrets): void {
  for (const [sec, kv] of Object.entries(s)) {
    if (!kv || typeof kv !== "object" || Array.isArray(kv)) throw new Error(`sealed section "${sec}" must be an object of name → string`);
    for (const [n, v] of Object.entries(kv)) if (typeof v !== "string") throw new Error(`sealed value ${sec}.${n} must be a string`);
  }
}

function encrypt(e: Omit<Envelope, "sealed">, secrets: Secrets, key: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", decodeKey(key), iv);
  c.setAAD(aad(e));
  const ct = Buffer.concat([c.update(Buffer.from(canonical(secrets))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function checkSize(e: Envelope): Envelope {
  const n = Buffer.byteLength(JSON.stringify(e));
  if (n > MAX_BYTES) throw new Error(`context is ${n} bytes — over the ${MAX_BYTES}-byte budget (job outputs cap at 1 MB); move large data to an artifact and reference it`);
  return e;
}

export function seal(plain: Plain, secrets: Secrets, key: string, trail: TrailEntry[] = []): Envelope {
  if (!plain || typeof plain.org !== "string" || !plain.org || typeof plain.githubHost !== "string" || !plain.githubHost) {
    throw new Error("plain.org and plain.githubHost are required");
  }
  validateSecrets(secrets);
  const base = { schema: SCHEMA, version: 1, plain, trail };
  return checkSize({ ...base, sealed: encrypt(base, secrets, key) });
}

export function parse(text: string): Envelope {
  let e: Envelope;
  try { e = JSON.parse(text); } catch { throw new Error("context is not valid JSON"); }
  if (!e || e.schema !== SCHEMA) throw new Error(`unsupported context schema "${e?.schema}" (expected ${SCHEMA})`);
  if (!Number.isInteger(e.version) || e.version < 1 || typeof e.sealed !== "string" || !Array.isArray(e.trail) || !e.plain) {
    throw new Error("malformed context envelope");
  }
  return e;
}

export function open(e: Envelope, key: string): { plain: Plain; secrets: Secrets } {
  if (e.schema !== SCHEMA) throw new Error(`unsupported context schema "${e.schema}"`);
  const raw = Buffer.from(e.sealed, "base64");
  if (raw.length < 28) throw new Error("sealed part is truncated");
  const d = createDecipheriv("aes-256-gcm", decodeKey(key), raw.subarray(0, 12));
  d.setAAD(aad(e));
  d.setAuthTag(raw.subarray(12, 28));
  let pt: Buffer;
  try { pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]); } catch {
    throw new Error("context failed authentication — wrong CONFIG_STREAM_KEY, or the plain/sealed/trail parts were altered");
  }
  return { plain: e.plain, secrets: JSON.parse(pt.toString("utf8")) as Secrets };
}

export function enrich(
  e: Envelope, section: string, plainData: Section | undefined, secretData: Record<string, string> | undefined,
  entry: Omit<TrailEntry, "added">, key: string,
): Envelope {
  if (!/^[a-z][a-z0-9-]*$/.test(section)) throw new Error(`section name "${section}" must be lower-kebab-case`);
  if (RESERVED.has(section)) throw new Error(`"${section}" is reserved`);
  const { plain, secrets } = open(e, key);
  if (section in plain || section in secrets) throw new Error(`section "${section}" already exists — the context is append-only`);
  const nextPlain: Plain = plainData && Object.keys(plainData).length ? { ...plain, [section]: plainData } : plain;
  const nextSecrets: Secrets = secretData && Object.keys(secretData).length ? { ...secrets, [section]: secretData } : secrets;
  if (nextPlain === plain && nextSecrets === secrets) throw new Error(`enrich "${section}" adds nothing`);
  validateSecrets(nextSecrets);
  const base = { schema: SCHEMA, version: e.version + 1, plain: nextPlain, trail: [...e.trail, { ...entry, added: [section] }] };
  return checkSize({ ...base, sealed: encrypt(base, nextSecrets, key) });
}

// Flatten the sealed sections to NAME → value for env export; a name in two sections is an error.
export function flatten(secrets: Secrets): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [sec, kv] of Object.entries(secrets)) {
    for (const [n, v] of Object.entries(kv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`sealed name ${sec}.${n} is not a valid env var name`);
      if (n in out) throw new Error(`sealed name ${n} appears in more than one section`);
      out[n] = v;
    }
  }
  return out;
}

export function hostFromServerUrl(url: string): string {
  try { return new URL(url || "https://github.com").host; } catch { return "github.com"; }
}

// Collect the named env vars (e.g. exported by hashicorp/vault-action) into one sealed section.
export function fromEnv(names: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const v = env[n];
    if (v === undefined || v === "") throw new Error(`secret env var ${n} is not set`);
    out[n] = v;
  }
  return out;
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error(`${what} is not valid JSON`); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be a JSON object`);
  return v as Record<string, unknown>;
}

export default async function run({ core }: Ctx): Promise<void> {
  const env = process.env;
  const key = (env.CONTEXT_KEY || env.CONFIG_STREAM_KEY || "").trim();
  if (!key) { core.setFailed("no CONFIG_STREAM_KEY: pass config-stream-key, or run get-config-stream first"); return; }
  core.setSecret(key);
  const mode = env.MODE || "open";
  const entry = { stage: env.STAGE || mode, job: env.GITHUB_JOB || "", runAttempt: Number(env.GITHUB_RUN_ATTEMPT || 1) };
  try {
    if (mode === "seal") {
      const extra = parseJsonObject(env.PLAIN_JSON || "", "plain-json");
      const plain: Plain = { org: env.GITHUB_REPOSITORY_OWNER || "", githubHost: hostFromServerUrl(env.GITHUB_SERVER_URL || ""), ...extra } as Plain;
      const section = env.SECRET_SECTION || "setup";
      const sec = fromEnv(env.SECRET_ENV_NAMES || "", env);
      const secrets: Secrets = Object.keys(sec).length ? { [section]: sec } : {};
      const added = [...Object.keys(extra), ...Object.keys(secrets)];
      const e = seal(plain, secrets, key, [{ ...entry, added }]);
      core.setOutput("context", JSON.stringify(e));
      core.setOutput("version", e.version);
      core.info(`🧬 sealed context v${e.version}: plain sections [${Object.keys(extra).join(", ")}], sealed sections [${Object.keys(secrets).join(", ")}]`);
    } else if (mode === "open") {
      const e = parse(env.CONTEXT || "");
      const { plain, secrets } = open(e, key);
      const flat = flatten(secrets);
      for (const v of Object.values(flat)) core.setSecret(v);
      if ((env.EXPORT_ENV || "true") === "true") for (const [n, v] of Object.entries(flat)) core.exportVariable(n, v);
      if (env.DOTENV_PATH) writeFileSync(env.DOTENV_PATH, Object.entries(flat).map(([n, v]) => `${n}=${v}`).join("\n") + "\n", { mode: 0o600 });
      core.setOutput("plain", JSON.stringify(plain));
      core.setOutput("version", e.version);
      core.info(`🧬 opened context v${e.version}: ${Object.keys(flat).length} sealed value(s) masked${(env.EXPORT_ENV || "true") === "true" ? " and exported" : ""}`);
    } else if (mode === "enrich") {
      const e = parse(env.CONTEXT || "");
      const section = env.SECTION || "";
      const plainData = parseJsonObject(env.PLAIN_JSON || "", "plain-json");
      const sec = fromEnv(env.SECRET_ENV_NAMES || "", env);
      const next = enrich(e, section, plainData, sec, entry, key);
      core.setOutput("context", JSON.stringify(next));
      core.setOutput("version", next.version);
      core.info(`🧬 enriched context v${e.version} → v${next.version} with section "${section}"`);
    } else {
      core.setFailed(`unknown mode "${mode}" (seal | open | enrich)`);
    }
  } catch (err) {
    core.setFailed(`cicd-context ${mode}: ${(err as Error).message}`);
  }
}
