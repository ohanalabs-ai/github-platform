// 🔑 config-stream — the vionix-cicd CONFIG_STREAM_KEY in Vault (the system of record), at a path
// derived from WHERE the workflow runs, so no caller ever passes it:
//
//   <kv-mount>/global/<github-host>/<github-org>/platform/vionix/config-stream   field CONFIG_STREAM_KEY
//   e.g. planeo/global/github.com/planeodev/platform/vionix/config-stream
//
// Modes (env MODE):
//   setup   generate a random 32-byte key and write it (KV v2, `cas: 0` = create-only, atomic). An
//           existing key is never replaced unless ROTATE=true (then `cas: <current version>`).
//           Optionally push the same value as the ORGANIZATION secret CONFIG_STREAM_KEY (visibility
//           private) with `gh secret set` — GitHub requires a libsodium sealed box for the REST API and
//           there are no npm dependencies here; `gh` is on every GitHub-hosted runner. Needs an org-admin
//           token (ORG_ADMIN_TOKEN). The org secret is the copy the CONSUMING jobs decrypt with, so they
//           never reach Vault.
//   get     read the key, mask it, export env CONFIG_STREAM_KEY. If CONFIG_STREAM_KEY is already set
//           (e.g. from the org secret) and PREFER_EXISTING=true, Vault is not called.
//   revoke  POST auth/token/revoke-self — end the job's Vault token.
//
// Vault access: VAULT_TOKEN from hashicorp/vault-action (exportToken: true — it does NOT export VAULT_ADDR)
// + VAULT_ADDR set by the calling workflow (job env from its `vault-url` input), optional
// VAULT_NAMESPACE. TLS: public CAs only (Node's fetch takes no per-request CA without npm undici).
import type { Ctx } from "./types.ts";
import { randomBytes } from "node:crypto";

export const FIELD = "CONFIG_STREAM_KEY";

export function hostFromServerUrl(url: string): string {
  try { return new URL(url || "https://github.com").host; } catch { return "github.com"; }
}

const SEG = /^[A-Za-z0-9._-]+$/;
export function logicalPath(host: string, org: string): string {
  for (const [n, v] of [["github host", host], ["github org", org]]) {
    if (!v || !SEG.test(v)) throw new Error(`invalid ${n} "${v}"`);
  }
  return `global/${host}/${org}/platform/vionix/config-stream`;
}

export function kvDataUrl(addr: string, mount: string, path: string): string {
  if (!/^https?:\/\//.test(addr || "")) throw new Error("VAULT_ADDR must be an http(s) URL");
  if (!mount || !/^[A-Za-z0-9._/-]+$/.test(mount)) throw new Error(`invalid KV mount "${mount}"`);
  return `${addr.replace(/\/+$/, "")}/v1/${mount.replace(/^\/+|\/+$/g, "")}/data/${path}`;
}

export interface KvRead { found: boolean; value?: string; version?: number }
// KV v2 read response → the field + the current version. A missing secret (404) or a deleted latest
// version (data: null) is "not found".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseKvRead(status: number, body: any): KvRead {
  if (status === 404) return { found: false };
  if (status !== 200) throw new Error(`Vault KV read failed: HTTP ${status}`);
  const data = body?.data?.data;
  const version = body?.data?.metadata?.version;
  if (!data || typeof data[FIELD] !== "string" || !data[FIELD]) return { found: false, version };
  return { found: true, value: data[FIELD], version };
}

export function writeBody(key: string, rotate: boolean, currentVersion?: number): Record<string, unknown> {
  // cas 0 = only if the secret does not exist; on rotate, only if nobody rotated in between.
  return { data: { [FIELD]: key }, options: { cas: rotate ? (currentVersion ?? 0) : 0 } };
}

function headers(): Record<string, string> {
  const t = process.env.VAULT_TOKEN || "";
  if (!t) throw new Error("no VAULT_TOKEN — log in first (hashicorp/vault-action with exportToken: true)");
  const h: Record<string, string> = { "X-Vault-Token": t, "Content-Type": "application/json" };
  if (process.env.VAULT_NAMESPACE) h["X-Vault-Namespace"] = process.env.VAULT_NAMESPACE;
  return h;
}

// What happened, for the run summary — never a key value. Every mode and every outcome (including a
// failure) ends with a summary (owner rule 2026-10-13: every workflow publishes what it did).
export interface Facts {
  mode: string;
  outcome?: "created" | "rotated" | "kept" | "read" | "provided" | "revoked" | "no-token" | "failed";
  path?: string; org?: string; host?: string; version?: number | string; rotate?: boolean;
  orgSecret?: "pushed" | "not-requested" | "failed"; source?: "env" | "vault"; httpStatus?: number; error?: string;
}

const OUTCOME: Record<string, string> = {
  created: "✅ created", rotated: "🔄 rotated", kept: "🟰 kept (unchanged)", read: "📥 read from Vault",
  provided: "📥 provided by the org secret (Vault not called)", revoked: "🔒 revoked", "no-token": "⏭️ no Vault token to revoke",
  failed: "❌ failed",
};

export function summaryMarkdown(f: Facts): string {
  const title = f.mode === "revoke" ? "🔒 Vault token" : `🔑 vionix config-stream key — ${f.mode}`;
  const rows: [string, string][] = [["Outcome", OUTCOME[f.outcome || "failed"] || String(f.outcome)]];
  if (f.path) rows.push(["Vault path", `\`${f.path}\` (field \`${FIELD}\`)`]);
  if (f.org) rows.push(["GitHub org", `${f.org}${f.host ? ` @ ${f.host}` : ""}`]);
  if (f.version !== undefined && f.version !== "") rows.push(["KV version", `v${f.version}`]);
  if (f.rotate !== undefined) rows.push(["Rotate requested", f.rotate ? "yes" : "no — create-only (an existing key is never replaced)"]);
  if (f.orgSecret) rows.push(["Org secret copy", f.orgSecret === "pushed" ? `pushed to **${f.org}** (visibility private)` : f.orgSecret === "failed" ? "❌ push failed" : "not requested (push-org-secret off)"]);
  if (f.source) rows.push(["Key source", f.source === "env" ? "org secret CONFIG_STREAM_KEY" : "Vault"]);
  if (f.httpStatus !== undefined) rows.push(["Vault HTTP", String(f.httpStatus)]);
  if (f.error) rows.push(["Error", f.error.replace(/\|/g, "\\|")]);
  return [`## ${title}`, "", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), "", "_The key value is never printed._", ""].join("\n");
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const env = process.env;
  const mode = env.MODE || "get";
  const f: Facts = { mode };
  try {
    if (mode === "revoke") {
      if (!env.VAULT_ADDR || !env.VAULT_TOKEN) { f.outcome = "no-token"; core.info("no Vault token to revoke"); return; }
      const r = await fetch(`${env.VAULT_ADDR.replace(/\/+$/, "")}/v1/auth/token/revoke-self`, { method: "POST", headers: headers() });
      f.httpStatus = r.status; f.outcome = r.ok ? "revoked" : "failed";
      if (!r.ok) f.error = `revoke-self returned HTTP ${r.status}`;
      core.info(`🔒 Vault token revoke-self: HTTP ${r.status}`);
      return;
    }
    const host = env.GITHUB_HOST_OVERRIDE || hostFromServerUrl(env.GITHUB_SERVER_URL || "");
    const org = env.GITHUB_ORG_OVERRIDE || env.GITHUB_REPOSITORY_OWNER || "";
    f.host = host; f.org = org;
    const path = logicalPath(host, org);
    const mount = env.KV_MOUNT || "planeo";
    f.path = `${mount}/${path}`;
    core.setOutput("path", `${mount}/${path}`);

    if (mode === "get") {
      const existing = (env.CONFIG_STREAM_KEY || "").trim();
      if (existing && (env.PREFER_EXISTING || "true") === "true") {
        core.setSecret(existing);
        core.setOutput("source", "env");
        f.source = "env"; f.outcome = "provided";
        core.info("🔑 CONFIG_STREAM_KEY already provided (org secret) — Vault not called");
        return;
      }
      const url = kvDataUrl(env.VAULT_ADDR || "", mount, path);
      const r = await fetch(url, { headers: headers() });
      const kv = parseKvRead(r.status, r.status === 404 ? null : await r.json());
      if (!kv.found || !kv.value) throw new Error(`no ${FIELD} at ${mount}/${path} — run the vionix-config-stream-setup workflow first`);
      core.setSecret(kv.value);
      core.exportVariable(FIELD, kv.value);
      core.setOutput("source", "vault");
      core.setOutput("version", kv.version ?? 0);
      f.source = "vault"; f.version = kv.version ?? 0; f.outcome = "read";
      core.info(`🔑 CONFIG_STREAM_KEY read from ${mount}/${path} (v${kv.version}) — masked, exported`);
      return;
    }

    if (mode === "setup") {
      const rotate = (env.ROTATE || "false") === "true";
      const push = (env.PUSH_ORG_SECRET || "false") === "true";
      f.rotate = rotate; f.orgSecret = push ? undefined : "not-requested";
      const url = kvDataUrl(env.VAULT_ADDR || "", mount, path);
      const cur = await fetch(url, { headers: headers() });
      const kv = parseKvRead(cur.status, cur.status === 404 ? null : await cur.json());
      if (kv.found && !rotate) {
        core.setOutput("created", "false");
        core.setOutput("version", kv.version ?? 0);
        f.outcome = "kept"; f.version = kv.version ?? 0;
        core.info(`🔑 ${mount}/${path} already holds ${FIELD} (v${kv.version}) — unchanged (set rotate: true to replace it)`);
        if (kv.value) core.setSecret(kv.value);
        if (push && kv.value) { f.orgSecret = "failed"; await pushOrgSecret(core, exec, org, kv.value); f.orgSecret = "pushed"; }
        return;
      }
      const key = randomBytes(32).toString("base64");
      core.setSecret(key);
      const w = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(writeBody(key, rotate, kv.version)) });
      if (w.status !== 200 && w.status !== 204) throw new Error(`Vault KV write failed: HTTP ${w.status} (a cas conflict means another run rotated it)`);
      const wb = w.status === 200 ? await w.json() : {};
      core.setOutput("created", "true");
      core.setOutput("version", wb?.data?.version ?? 0);
      f.outcome = rotate ? "rotated" : "created"; f.version = wb?.data?.version ?? "?";
      core.info(`🔑 ${rotate ? "rotated" : "created"} ${FIELD} at ${mount}/${path} (v${wb?.data?.version ?? "?"})`);
      if (push) { f.orgSecret = "failed"; await pushOrgSecret(core, exec, org, key); f.orgSecret = "pushed"; }
      return;
    }
    f.outcome = "failed"; f.error = `unknown mode "${mode}" (setup | get | revoke)`;
    core.setFailed(f.error);
  } catch (err) {
    // keep a created/kept outcome when only the org-secret push failed afterwards
    if (!f.outcome || f.orgSecret !== "failed") f.outcome = "failed";
    f.error = (err as Error).message;
    core.setFailed(`config-stream ${mode}: ${f.error}`);
  } finally {
    await core.summary.addRaw(summaryMarkdown(f), true).write();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pushOrgSecret(core: Ctx["core"], exec: Ctx["exec"], org: string, value: string): Promise<void> {
  const token = process.env.ORG_ADMIN_TOKEN || "";
  if (!token) throw new Error("push-org-secret needs org-admin-token (a token with admin:org on the org)");
  const code = await exec.exec("gh", ["secret", "set", FIELD, "--org", org, "--visibility", "private"], {
    input: Buffer.from(value), silent: true, ignoreReturnCode: true,
    env: { ...(process.env as Record<string, string>), GH_TOKEN: token, GH_HOST: process.env.GITHUB_HOST_OVERRIDE || hostFromServerUrl(process.env.GITHUB_SERVER_URL || "") },
  });
  if (code !== 0) throw new Error(`gh secret set ${FIELD} --org ${org} failed (exit ${code})`);
  core.info(`🔑 org secret ${FIELD} set on ${org} (visibility private)`);
}
