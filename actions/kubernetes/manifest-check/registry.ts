// Is an image actually pullable? Speak the OCI distribution API (v2) the kubelet speaks: resolve the
// tag/digest to a manifest, follow the registry's bearer-token challenge with the configured auth
// profile, and — for an index — check the required platforms are in it (a single-platform image's
// config blob is read for its os/architecture). Only fetch; no docker daemon, no npm.
import type { ImageRef } from "./imageref.ts";

export const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** ok · missing (the registry says no such manifest/repo) · unverifiable (auth denied, rate limited,
 *  network) — a missing image fails the check; an unverifiable one is a warning unless the policy
 *  says otherwise. */
export type Availability = "ok" | "missing" | "unverifiable";

export interface ImageResult {
  availability: Availability;
  status: number; // last HTTP status (0 = network error)
  digest: string;
  mediaType: string;
  platforms: string[]; // os/arch[/variant] found (index entries, or the single image's config)
  missingPlatforms: string[];
  profile: string; // which credential was used: anonymous | github-token | gcp | dockerhub
  detail: string;
}

export interface Credential { username: string; password: string; profile: string }
/** host → credential. Hosts: ghcr.io, docker.io, *.pkg.dev / gcr.io (matched by suffix). */
export type Credentials = Record<string, Credential>;

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export function credentialFor(creds: Credentials, display: string): Credential | undefined {
  if (creds[display]) return creds[display];
  const k = Object.keys(creds).find((h) => h.startsWith(".") && display.endsWith(h));
  return k ? creds[k] : undefined;
}

/** `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x/y:pull"` → fields */
export function parseChallenge(h: string | null): { scheme: string; params: Record<string, string> } | undefined {
  if (!h) return undefined;
  const m = h.match(/^(\w+)\s+(.*)$/);
  if (!m) return undefined;
  const params: Record<string, string> = {};
  for (const p of m[2].matchAll(/(\w+)="([^"]*)"/g)) params[p[1]] = p[2];
  return { scheme: m[1].toLowerCase(), params };
}

function basic(c: Credential): string {
  return `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`;
}

async function token(f: Fetch, challenge: { params: Record<string, string> }, repo: string, cred?: Credential): Promise<{ token?: string; status: number }> {
  const { realm, service } = challenge.params;
  if (!realm) return { status: 0 };
  const u = new URL(realm);
  if (service) u.searchParams.set("service", service);
  u.searchParams.set("scope", challenge.params.scope || `repository:${repo}:pull`);
  const res = await f(u.toString(), { headers: cred ? { Authorization: basic(cred) } : {} });
  if (res.status !== 200) return { status: res.status };
  const body = JSON.parse(await res.text()) as { token?: string; access_token?: string };
  return { token: body.token || body.access_token, status: 200 };
}

interface Session { f: Fetch; ref: ImageRef; cred?: Credential; auth?: string }

async function get(s: Session, path: string, accept: string): Promise<{ status: number; headers: { get(n: string): string | null }; body: string }> {
  const url = `https://${s.ref.registry}/v2/${s.ref.repository}/${path}`;
  const call = () => s.f(url, { headers: { Accept: accept, ...(s.auth ? { Authorization: s.auth } : {}) } });
  let res = await call();
  if (res.status === 401) {
    const ch = parseChallenge(res.headers.get("www-authenticate"));
    if (ch?.scheme === "bearer") {
      const t = await token(s.f, ch, s.ref.repository, s.cred);
      if (t.token) {
        s.auth = `Bearer ${t.token}`;
        res = await call();
      } else if (t.status) return { status: t.status, headers: res.headers, body: "" };
    } else if (ch?.scheme === "basic" && s.cred) {
      s.auth = basic(s.cred);
      res = await call();
    }
  }
  return { status: res.status, headers: res.headers, body: res.status === 200 ? await res.text() : await res.text().catch(() => "") };
}

function platformOf(p: { os?: string; architecture?: string; variant?: string } | undefined): string {
  if (!p) return "";
  return [p.os, p.architecture, p.variant].filter(Boolean).join("/");
}

/** linux/arm64 is satisfied by linux/arm64/v8; linux/amd64 by linux/amd64. */
export function hasPlatform(found: string[], want: string): boolean {
  return found.some((f) => f === want || f.startsWith(`${want}/`));
}

function classify(status: number, body: string): Availability {
  if (status === 200) return "ok";
  // 404 MANIFEST_UNKNOWN / NAME_UNKNOWN is the registry saying "no such image". Some registries
  // (ghcr for a private package seen anonymously) answer 404/403/401 + DENIED/UNAUTHORIZED instead.
  if (status === 404 && !/DENIED|UNAUTHORIZED/i.test(body)) return "missing";
  return "unverifiable";
}

export async function checkImage(f: Fetch, ref: ImageRef, creds: Credentials, requiredPlatforms: string[]): Promise<ImageResult> {
  const cred = credentialFor(creds, ref.display);
  const s: Session = { f, ref, cred };
  const r: ImageResult = { availability: "unverifiable", status: 0, digest: "", mediaType: "", platforms: [], missingPlatforms: [], profile: cred?.profile || "anonymous", detail: "" };
  try {
    const m = await get(s, `manifests/${ref.digest || ref.tag}`, ACCEPT);
    r.status = m.status;
    r.availability = classify(m.status, m.body);
    if (r.availability !== "ok") {
      const errs = (() => { try { return (JSON.parse(m.body) as { errors?: Array<{ code?: string; message?: string }> }).errors || []; } catch { return []; } })();
      r.detail = errs.map((e) => `${e.code || ""} ${e.message || ""}`.trim()).join("; ") || `HTTP ${m.status}`;
      if (m.status === 429) r.detail = `rate limited (HTTP 429)${r.detail ? ` — ${r.detail}` : ""}`;
      return r;
    }
    r.digest = m.headers.get("docker-content-digest") || ref.digest;
    const doc = JSON.parse(m.body) as {
      mediaType?: string;
      manifests?: Array<{ platform?: { os?: string; architecture?: string; variant?: string }; annotations?: Record<string, string> }>;
      config?: { digest?: string };
    };
    r.mediaType = doc.mediaType || m.headers.get("content-type") || "";
    if (Array.isArray(doc.manifests)) {
      // attestation manifests (buildx provenance/SBOM) are listed as unknown/unknown — not a platform
      r.platforms = doc.manifests
        .filter((d) => d.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest")
        .map((d) => platformOf(d.platform))
        .filter((p) => p && p !== "unknown/unknown");
    } else if (doc.config?.digest) {
      const c = await get(s, `blobs/${doc.config.digest}`, "application/json");
      if (c.status === 200) {
        const p = platformOf(JSON.parse(c.body) as { os?: string; architecture?: string; variant?: string });
        if (p) r.platforms = [p];
      }
    }
    if (r.platforms.length) r.missingPlatforms = requiredPlatforms.filter((p) => !hasPlatform(r.platforms, p));
    else r.detail = "platform not determinable (config blob unreadable)";
    return r;
  } catch (e) {
    r.availability = "unverifiable";
    r.detail = `network: ${e instanceof Error ? e.message : String(e)}`;
    return r;
  }
}
