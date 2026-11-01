// A minimal Vault HTTP client for GitHub Actions — Node 24 built-ins only (global fetch), run by
// actions/github-script@v8. Covers exactly what the vault-sign / vault-rotate-secret reusables need:
//   * JWT login with the job's GitHub OIDC token  (POST /v1/auth/<mount>/login)
//   * Transit sign / verify of a SHA-256 digest   (POST /v1/<transit>/sign|verify/<key>/sha2-256)
//   * Transit public key read                     (GET  /v1/<transit>/keys/<key>)
//   * KV v2 read / CAS write                       (GET|POST /v1/<kv>/data/<path>)
//   * token self-revocation                        (POST /v1/auth/token/revoke-self)
// The token never leaves this process: callers log in, act, and revoke in the same module run.
// `fetch` is injectable so the self-tests (vault.test.ts) need no network and no Vault.
//
// A custom CA (the vionix-style `caCertificate` input) is honoured through NODE_EXTRA_CA_CERTS, which
// Node reads at process start — the reusable workflows write the PEM to a file in an earlier step and
// set the variable on the github-script step's `env:`. A publicly trusted Vault (ACM / Let's Encrypt)
// needs nothing.

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class VaultError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A path segment list that cannot escape its mount: no empty segments, no `.`/`..`, no leading `/`,
 *  only the characters Vault paths and our folder design use. */
export function safePath(p: string, what: string): string {
  const v = (p || "").trim().replace(/^\/+|\/+$/g, "");
  if (!v) throw new Error(`${what} is empty`);
  if (!/^[A-Za-z0-9._\-/@]+$/.test(v)) throw new Error(`${what} has characters outside [A-Za-z0-9._-/@]: ${JSON.stringify(v)}`);
  for (const seg of v.split("/")) {
    if (!seg || seg === "." || seg === "..") throw new Error(`${what} has an empty, '.' or '..' segment: ${JSON.stringify(v)}`);
  }
  return v;
}

/** https://vault.example.com/ → https://vault.example.com ; refuses plain http unless allowHttp (self-test). */
export function normalizeUrl(u: string, allowHttp = false): string {
  const url = new URL((u || "").trim());
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error(`vault-url must be https:// (got ${url.protocol}//${url.host})`);
  }
  if (url.search || url.hash) throw new Error("vault-url must not carry a query or fragment");
  return url.toString().replace(/\/+$/, "");
}

/** Vault's error body is {"errors":[...]} — surface it, never the request body. */
async function fail(res: { status: number; text(): Promise<string> }, what: string): Promise<never> {
  let detail = "";
  try {
    const j = JSON.parse(await res.text());
    if (Array.isArray(j?.errors)) detail = j.errors.join("; ");
  } catch {
    /* non-JSON body (a proxy's 404 page): status is enough */
  }
  const hint =
    res.status === 400 && /claim|audience|bound/i.test(detail) ? " — the token's claims do not match the role (repository/ref/event/audience)"
    : res.status === 403 ? " — the role's policies do not grant this path (or the token expired)"
    : res.status === 404 ? " — no such mount/path, or the edge does not expose it"
    : res.status === 429 ? " — rate-limited by a Vault quota or the edge"
    : "";
  throw new VaultError(`${what}: HTTP ${res.status}${detail ? ` (${detail})` : ""}${hint}`, res.status);
}

export interface LoginResult {
  token: string;
  ttl: number;
  policies: string[];
  accessor: string;
}

export class Vault {
  readonly url: string;
  private f: Fetch;
  token = "";

  constructor(url: string, f: Fetch = fetch as unknown as Fetch, allowHttp = false) {
    this.url = normalizeUrl(url, allowHttp);
    this.f = f;
  }

  private async call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { "content-type": "application/json", "x-vault-request": "true" };
    if (auth) {
      if (!this.token) throw new Error("not logged in");
      headers["x-vault-token"] = this.token;
    }
    const res = await this.f(`${this.url}/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) await fail(res, `${method} /v1/${path}`);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }

  /** JWT login on auth/<mount> with role; stores the client token. */
  async login(mount: string, role: string, jwt: string): Promise<LoginResult> {
    const m = safePath(mount, "vault-auth-path");
    const r = safePath(role, "vault-role");
    if (r.includes("/")) throw new Error("vault-role must be a single name");
    const { json } = await this.call("POST", `auth/${m}/login`, { role: r, jwt }, false);
    const a = json?.auth;
    if (!a?.client_token) throw new VaultError(`POST /v1/auth/${m}/login: no auth.client_token in the response`, 0);
    this.token = a.client_token;
    return { token: a.client_token, ttl: a.lease_duration ?? 0, policies: a.policies ?? [], accessor: a.accessor ?? "" };
  }

  async revokeSelf(): Promise<void> {
    if (!this.token) return;
    try {
      await this.call("POST", "auth/token/revoke-self", {});
    } finally {
      this.token = "";
    }
  }

  /** Transit sign of an already-computed SHA-256 digest (hex). Returns the `vault:vN:<b64>` signature. */
  async signDigest(transit: string, key: string, digestHex: string): Promise<{ signature: string; keyVersion: number }> {
    const input = digestToB64(digestHex);
    const { json } = await this.call("POST", `${safePath(transit, "transit-path")}/sign/${safePath(key, "key")}/sha2-256`, {
      input,
      prehashed: true,
      marshaling_algorithm: "asn1",
    });
    const sig: string = json?.data?.signature ?? "";
    const m = /^vault:v(\d+):/.exec(sig);
    if (!m) throw new VaultError("transit sign: unexpected signature format", 0);
    return { signature: sig, keyVersion: Number(m[1]) };
  }

  async verifyDigest(transit: string, key: string, digestHex: string, signature: string): Promise<boolean> {
    const { json } = await this.call("POST", `${safePath(transit, "transit-path")}/verify/${safePath(key, "key")}/sha2-256`, {
      input: digestToB64(digestHex),
      prehashed: true,
      marshaling_algorithm: "asn1",
      signature,
    });
    return json?.data?.valid === true;
  }

  /** The latest public key (PEM) of a transit key + its metadata flags (for the guard below). */
  async publicKey(transit: string, key: string): Promise<{ pem: string; version: number; exportable: boolean; allowPlaintextBackup: boolean; type: string }> {
    const { json } = await this.call("GET", `${safePath(transit, "transit-path")}/keys/${safePath(key, "key")}`);
    const d = json?.data ?? {};
    const version = Number(d.latest_version ?? 0);
    const pem = d.keys?.[String(version)]?.public_key ?? "";
    return { pem, version, exportable: d.exportable === true, allowPlaintextBackup: d.allow_plaintext_backup === true, type: String(d.type ?? "") };
  }

  /** KV v2 read; returns null on 404 (first rotation). */
  async kvRead(mount: string, path: string): Promise<{ data: Record<string, string>; version: number } | null> {
    try {
      const { json } = await this.call("GET", `${safePath(mount, "kv-mount")}/data/${safePath(path, "secret-path")}`);
      return { data: json?.data?.data ?? {}, version: Number(json?.data?.metadata?.version ?? 0) };
    } catch (e) {
      if (e instanceof VaultError && e.status === 404) return null;
      throw e;
    }
  }

  /** KV v2 write with check-and-set: cas=0 means "only if it does not exist", N means "only if the current version is N". */
  async kvWrite(mount: string, path: string, data: Record<string, string>, cas: number): Promise<number> {
    const { json } = await this.call("POST", `${safePath(mount, "kv-mount")}/data/${safePath(path, "secret-path")}`, { options: { cas }, data });
    return Number(json?.data?.version ?? 0);
  }
}

/** sha256:abc… or abc… (64 hex) → base64 of the 32 raw bytes. */
export function digestToB64(d: string): string {
  const hex = (d || "").trim().replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("digest must be a SHA-256: 64 hex chars, optionally prefixed sha256:");
  return Buffer.from(hex, "hex").toString("base64");
}

/** The audience a role's bound_audiences must contain. Default = GitHub's own default (the owner URL). */
export function audienceFor(input: string, serverUrl: string, owner: string): string {
  return (input || "").trim() || `${serverUrl.replace(/\/+$/, "")}/${owner}`;
}

/** Login with the job's OIDC token; masks the Vault token in the log. */
export async function loginFromEnv(core: { getIDToken(a?: string): Promise<string>; setSecret(s: string): void; info(m: string): void }, env: NodeJS.ProcessEnv, f?: Fetch): Promise<Vault> {
  const v = new Vault(env.VAULT_URL || "", f, env.VAULT_ALLOW_HTTP === "true");
  const aud = audienceFor(env.VAULT_AUDIENCE || "", env.GITHUB_SERVER_URL || "https://github.com", env.GITHUB_REPOSITORY_OWNER || "");
  const jwt = await core.getIDToken(aud);
  core.setSecret(jwt);
  const r = await v.login(env.VAULT_AUTH_PATH || "github-jwt", env.VAULT_ROLE || "", jwt);
  core.setSecret(r.token);
  core.info(`🔐 Vault login ok: role ${env.VAULT_ROLE} on auth/${env.VAULT_AUTH_PATH || "github-jwt"} · aud ${aud} · ttl ${r.ttl}s · policies ${r.policies.filter((p) => p !== "default").join(",") || "(default only)"}`);
  return v;
}
