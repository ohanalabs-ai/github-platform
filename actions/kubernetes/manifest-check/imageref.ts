// Parse an OCI image reference the way the container runtimes do (docker.io defaulting included),
// so availability is checked against the registry the kubelet will actually contact.
export interface ImageRef {
  raw: string;
  registry: string; // api host, e.g. registry-1.docker.io, ghcr.io, us-east1-docker.pkg.dev
  display: string; // host as written / implied (docker.io for Docker Hub)
  repository: string; // path, e.g. library/redis
  tag: string; // "" when the reference has none
  digest: string; // "sha256:…" or ""
}

const PLACEHOLDER = /CHANGE_ME|\$\{|\{\{|<[a-z-]+>/i;

export function isPlaceholder(raw: string): boolean {
  return PLACEHOLDER.test(raw);
}

export function parseImageRef(raw: string): ImageRef {
  const ref = raw.trim();
  let rest = ref;
  let digest = "";
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = "";
  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }
  const first = rest.split("/")[0];
  const hasHost = rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  let display = hasHost ? first : "docker.io";
  let repository = hasHost ? rest.slice(first.length + 1) : rest;
  if (display === "docker.io" || display === "index.docker.io" || display === "registry-1.docker.io") {
    display = "docker.io";
    if (!repository.includes("/")) repository = `library/${repository}`;
  }
  const registry = display === "docker.io" ? "registry-1.docker.io" : display;
  if (!digest && !tag) tag = "latest";
  return { raw: ref, registry, display, repository, tag, digest };
}

/** A tag that moves by design — never a reproducible deployment. */
export function isFloatingTag(r: ImageRef): boolean {
  if (r.digest) return false;
  const t = r.tag.toLowerCase();
  return t === "latest" || t === "main" || t === "master" || t === "stable" || t === "edge" || t === "nightly" || /^[a-z-]+$/.test(t);
}
