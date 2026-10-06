// node --test actions/kubernetes/manifest-check/manifest-check.test.ts — no network, no cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isFloatingTag, isPlaceholder, parseImageRef } from "./imageref.ts";
import { removedApi } from "./deprecations.ts";
import { extractImages } from "./objects.ts";
import { checkImage, hasPlatform, parseChallenge, type Fetch } from "./registry.ts";
import { imageFindings, renderReport, schemaFindings, type Policy } from "./findings.ts";
import { credentials, findKustomizations, list } from "./check.ts";
import { PINS, urlFor, VERSIONS } from "./install.ts";

const D = "sha256:" + "a".repeat(64);
const policy: Policy = { requireDigest: false, failOnUnverifiable: false, failOnFloating: false };

test("parseImageRef: Docker Hub defaults, registries with ports, tag + digest", () => {
  assert.deepEqual(parseImageRef("redis:alpine"), { raw: "redis:alpine", registry: "registry-1.docker.io", display: "docker.io", repository: "library/redis", tag: "alpine", digest: "" });
  assert.equal(parseImageRef("busybox").tag, "latest");
  const g = parseImageRef(`us-central1-docker.pkg.dev/google-samples/microservices-demo/frontend:v0.10.3@${D}`);
  assert.equal(g.registry, "us-central1-docker.pkg.dev");
  assert.equal(g.repository, "google-samples/microservices-demo/frontend");
  assert.equal(g.tag, "v0.10.3");
  assert.equal(g.digest, D);
  const p = parseImageRef("localhost:5000/team/app:1.2");
  assert.equal(p.registry, "localhost:5000");
  assert.equal(p.repository, "team/app");
  assert.equal(parseImageRef("bitnami/redis").repository, "bitnami/redis");
  assert.equal(parseImageRef("ghcr.io/ohanalabs-ai/x:sha-1").display, "ghcr.io");
});

test("floating vs tag-only vs digest; placeholders", () => {
  assert.equal(isFloatingTag(parseImageRef("nginx:latest")), true);
  assert.equal(isFloatingTag(parseImageRef("nginx:main")), true);
  assert.equal(isFloatingTag(parseImageRef("nginx:1.27.0")), false);
  assert.equal(isFloatingTag(parseImageRef(`nginx@${D}`)), false);
  assert.equal(isPlaceholder("CHANGE_ME_IMAGE"), true);
  assert.equal(isPlaceholder("${IMAGE}"), true);
  assert.equal(isPlaceholder("nginx:1"), false);
});

test("removed APIs by target Kubernetes version", () => {
  assert.equal(removedApi("batch/v1beta1", "CronJob", "1.35.0")?.replacement, "batch/v1");
  assert.equal(removedApi("batch/v1beta1", "CronJob", "1.24.0"), undefined);
  assert.equal(removedApi("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema", "v1.32"), removedApi("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema", "1.36.0"));
  assert.equal(removedApi("apps/v1", "Deployment", "1.36.0"), undefined);
  assert.equal(removedApi("extensions/v1beta1", "Ingress", "1.22.0")?.removedIn, "1.22");
});

test("extractImages: pod templates, init containers, CR *Image fields; CRDs and non-images ignored", () => {
  const dep = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "fe", namespace: "web" }, spec: { template: { spec: {
    initContainers: [{ name: "i", image: "busybox:1.36", imagePullPolicy: "Always" }],
    containers: [{ name: "c", image: `ghcr.io/o/fe@${D}` }],
  } } } };
  const got = extractImages(dep, "f.yaml").map((i) => i.image);
  assert.deepEqual(got, ["busybox:1.36", `ghcr.io/o/fe@${D}`]);
  assert.deepEqual(extractImages({ kind: "WorkerPool", spec: { ateomImage: "ghcr.io/x/ateom:1", description: "an image of x" } }, "f").map((i) => i.image), ["ghcr.io/x/ateom:1"]);
  assert.deepEqual(extractImages({ kind: "CustomResourceDefinition", spec: { image: "x:1" } }, "f"), []);
});

// A tiny fake registry: a token endpoint, an index, a single-platform manifest + config, a private
// repo (DENIED) and an unknown tag.
function fakeRegistry(): { f: Fetch; calls: string[] } {
  const calls: string[] = [];
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const f: Fetch = async (url, init) => {
    calls.push(url);
    const auth = init?.headers?.Authorization || "";
    if (url.startsWith("https://reg.test/token")) {
      if (url.includes("private") && !auth.startsWith("Basic ")) return res(403, { errors: [{ code: "DENIED" }] });
      return res(200, { token: "t0k" });
    }
    if (!auth.startsWith("Bearer ")) return res(401, "", { "www-authenticate": 'Bearer realm="https://reg.test/token",service="reg.test",scope="repository:' + (url.match(/\/v2\/([^/]+)\//)?.[1] || "x") + ':pull"' });
    if (url.endsWith("/v2/multi/manifests/1.0")) return res(200, { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
      { platform: { os: "linux", architecture: "amd64" } }, { platform: { os: "linux", architecture: "arm64", variant: "v8" } },
      { platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } },
    ] }, { "docker-content-digest": D });
    if (url.endsWith("/v2/single/manifests/1.0")) return res(200, { mediaType: "application/vnd.docker.distribution.manifest.v2+json", config: { digest: "sha256:cfg" } }, { "docker-content-digest": D });
    if (url.endsWith("/v2/single/blobs/sha256:cfg")) return res(200, { os: "linux", architecture: "arm64" });
    if (url.endsWith("/v2/private/manifests/1.0")) return res(200, { manifests: [{ platform: { os: "linux", architecture: "amd64" } }] }, { "docker-content-digest": D });
    return res(404, { errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] });
  };
  return { f, calls };
}

test("checkImage: index platforms, single-image config, missing tag, private without/with creds", async () => {
  const { f } = fakeRegistry();
  const multi = await checkImage(f, parseImageRef("reg.test/multi:1.0"), {}, ["linux/amd64", "linux/arm64"]);
  assert.equal(multi.availability, "ok");
  assert.deepEqual(multi.platforms, ["linux/amd64", "linux/arm64/v8"]);
  assert.deepEqual(multi.missingPlatforms, []);
  assert.equal(multi.digest, D);
  const single = await checkImage(f, parseImageRef("reg.test/single:1.0"), {}, ["linux/amd64"]);
  assert.deepEqual(single.missingPlatforms, ["linux/amd64"]);
  const missing = await checkImage(f, parseImageRef("reg.test/multi:9.9"), {}, ["linux/amd64"]);
  assert.equal(missing.availability, "missing");
  assert.match(missing.detail, /MANIFEST_UNKNOWN/);
  const denied = await checkImage(f, parseImageRef("reg.test/private:1.0"), {}, ["linux/amd64"]);
  assert.equal(denied.availability, "unverifiable");
  assert.equal(denied.profile, "anonymous");
  const authed = await checkImage(f, parseImageRef("reg.test/private:1.0"), { "reg.test": { username: "u", password: "p", profile: "github-token" } }, ["linux/amd64"]);
  assert.equal(authed.availability, "ok");
  assert.equal(authed.profile, "github-token");
});

test("checkImage: a network error is unverifiable, never missing", async () => {
  const r = await checkImage(async () => { throw new Error("ECONNRESET"); }, parseImageRef("reg.test/x:1"), {}, ["linux/amd64"]);
  assert.equal(r.availability, "unverifiable");
  assert.match(r.detail, /ECONNRESET/);
});

test("parseChallenge / hasPlatform", () => {
  assert.deepEqual(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io"')?.params, { realm: "https://ghcr.io/token", service: "ghcr.io" });
  assert.equal(parseChallenge(null), undefined);
  assert.equal(hasPlatform(["linux/arm64/v8"], "linux/arm64"), true);
  assert.equal(hasPlatform(["linux/arm64"], "linux/amd64"), false);
});

test("policy: missing → error, unverifiable → warning (or error), floating → warning, tag-only → notice", () => {
  const ok = { availability: "ok" as const, status: 200, digest: D, mediaType: "", platforms: ["linux/amd64"], missingPlatforms: [], profile: "anonymous", detail: "" };
  assert.equal(imageFindings("nginx:1.27", ["u"], ok, policy, ["linux/amd64"])[0].level, "notice");
  assert.equal(imageFindings("nginx:1.27", ["u"], ok, { ...policy, requireDigest: true }, ["linux/amd64"])[0].level, "error");
  assert.deepEqual(imageFindings(`nginx@${D}`, ["u"], ok, policy, ["linux/amd64"]), []);
  assert.equal(imageFindings("nginx:latest", ["u"], ok, policy, ["linux/amd64"])[0].level, "warning");
  const un = { ...ok, availability: "unverifiable" as const, status: 401, detail: "DENIED" };
  assert.equal(imageFindings("ghcr.io/p/x:1", ["u"], un, policy, ["linux/amd64"])[0].level, "warning");
  assert.equal(imageFindings("ghcr.io/p/x:1", ["u"], un, { ...policy, failOnUnverifiable: true }, ["linux/amd64"])[0].level, "error");
  assert.equal(imageFindings("x:9", ["u"], { ...ok, availability: "missing", status: 404 }, policy, ["linux/amd64"])[0].level, "error");
  assert.equal(imageFindings("x:9", ["u"], { ...ok, missingPlatforms: ["linux/amd64"], platforms: ["linux/arm64"] }, policy, ["linux/amd64"])[0].level, "error");
  assert.equal(imageFindings("CHANGE_ME", ["u"], undefined, policy, ["linux/amd64"])[0].level, "notice");
});

test("schemaFindings + report", () => {
  const f = schemaFindings("demo", [{ kind: "Service", name: "fe", version: "v1", status: "statusInvalid", msg: "port: expected integer" }, { status: "statusValid" }]);
  assert.equal(f.length, 1);
  const md = renderReport({ title: "demo", kubernetesVersion: "1.35.0", policyMode: "enforce", platforms: ["linux/amd64"], units: [{ unit: "demo", objects: 3, build: "ok", schema: "❌ 1 invalid", deprecated: 0, images: 0 }], images: [], findings: f });
  assert.match(md, /❌ \*\*1 error\(s\)\*\*/);
  assert.match(md, /port: expected integer/);
});

test("credentials: ghcr github-token, GCP placeholder, Docker Hub optional", () => {
  const c = credentials({ GHCR_TOKEN: "g", GCP_ACCESS_TOKEN: "y" });
  assert.equal(c["ghcr.io"].profile, "github-token");
  assert.equal(c[".pkg.dev"].username, "oauth2accesstoken");
  assert.equal(c["docker.io"], undefined);
  assert.deepEqual(list("a, b\nc"), ["a", "b", "c"]);
});

test("findKustomizations skips charts/ and dot-dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "kz-"));
  for (const d of ["", "base", "overlays/prd", "charts/x", ".git/y"]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, "kustomization.yaml"), "resources: []\n");
  }
  assert.deepEqual(findKustomizations(root).map((d) => d.slice(root.length)).sort(), ["", "/base", "/overlays/prd"]);
});

test("installer pins every tool for both architectures", () => {
  for (const t of Object.keys(VERSIONS)) for (const a of ["amd64", "arm64"]) {
    assert.match(PINS[`${t}-${a}`], /^[a-f0-9]{64}$/);
    assert.ok(urlFor(t, a).startsWith("https://"));
  }
});
