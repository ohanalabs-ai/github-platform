// Pure evaluators of the engram-analyzer/v1 conformance checks (okf/analyzer-contract-v1.md in
// ohanalabs-ai/vionix-codegraph-analyzer). No I/O here: gate.ts gathers the facts with the docker CLI and hands
// them to these functions, so every verdict is unit-tested in conformance.test.ts.
import type { Check, Report, Status } from "./types.ts";
import { validate } from "./schema.ts";

export const LABEL_MANIFEST_DIGEST = "dev.rekorda.engram.analyzer.manifest-digest";
export const MANIFEST_PATH = "/engram/analyzer.yaml";
export const RUN_UID = "65532:65532";

/** The check ids, in the order of the report columns. */
export const CHECK_IDS = [
  "alpine", "base-pinned", "non-root", "entrypoint", "manifest", "label", "busybox", "run", "relocated", "missing-env",
] as const;

export const CHECK_TITLES: Record<string, string> = {
  "alpine": "final base is Alpine (/etc/os-release)",
  "base-pinned": "final FROM pinned tag@sha256 (Dockerfile)",
  "non-root": "image USER is non-root",
  "entrypoint": "exec-form absolute ENTRYPOINT (= manifest entrypoint)",
  "manifest": `manifest at ${MANIFEST_PATH} (= source manifest)`,
  "label": `label ${LABEL_MANIFEST_DIGEST} = sha256 of the manifest`,
  "busybox": "busybox mkdir / tar --no-same-owner --no-same-permissions / chmod",
  "run": "contract run at /repo: one schema-valid document, exit 0|1",
  "relocated": "relocated run (REPO_ROOT elsewhere, cwd /)",
  "missing-env": "no REPO_NODE_ID → exit 2",
  "serve": "grpc: starts and listens on the manifest grpc.port",
};

export const c = (id: string, status: Status, detail: string): Check => ({ id, status, detail });

/** The content of the first regular file in a tar stream (what `docker cp <ctr>:<file> -` writes). */
export function tarFirstFile(tar: Buffer): Buffer | null {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null;
    const size = parseInt(header.subarray(124, 136).toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const start = off + 512;
    if (type === "0" || type === "\0" || type === "7") return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

export function osReleaseId(text: string): { id: string; version: string } {
  const get = (k: string) => (new RegExp(`^${k}=("?)([^"\\n]*)\\1`, "m").exec(text) || [])[2] || "";
  return { id: get("ID"), version: get("VERSION_ID") };
}

export function checkAlpine(osRelease: string | null): Check {
  if (osRelease === null) return c("alpine", "fail", "no /etc/os-release in the image (not an Alpine base)");
  const { id, version } = osReleaseId(osRelease);
  return id === "alpine" ? c("alpine", "pass", `alpine ${version}`) : c("alpine", "fail", `base is ${id || "unknown"} ${version}`.trim());
}

/** The final stage's base image of a Dockerfile, following stage aliases and ARG defaults. */
export function finalBase(dockerfile: string): string | null {
  const args = new Map<string, string>();
  const stages = new Map<string, string>();
  let last: string | null = null;
  const lines = dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=("?)([^"\s]*)\2/i.exec(line);
    if (arg && last === null) args.set(arg[1], arg[3]);
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;
    let image = from[1].replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, n) => args.get(n) ?? `\${${n}}`);
    while (stages.has(image.toLowerCase())) image = stages.get(image.toLowerCase()) as string;
    if (from[2]) stages.set(from[2].toLowerCase(), image);
    last = image;
  }
  return last;
}

export function checkBasePinned(dockerfile: string | null): Check {
  if (dockerfile === null) return c("base-pinned", "n/a", "no Dockerfile given");
  const base = finalBase(dockerfile);
  if (!base) return c("base-pinned", "fail", "no FROM in the Dockerfile");
  // Alpine-ness is the `alpine` check (os-release of the built image); this one is the pin: tag AND digest.
  const m = /^(\S+?):([^:@/\s]+)@sha256:[a-f0-9]{64}$/.exec(base);
  if (m) return c("base-pinned", "pass", `${m[1]}:${m[2]}@sha256:…`);
  if (/@sha256:[a-f0-9]{64}$/.test(base)) return c("base-pinned", "fail", `final base ${base.replace(/@sha256:.*/, "")}@sha256:… has a digest but no tag`);
  return c("base-pinned", "fail", `final base ${base} is not pinned by tag@sha256`);
}

export function checkNonRoot(user: string): Check {
  const u = user.trim();
  const name = u.split(":")[0];
  if (u === "" || name === "root" || name === "0") return c("non-root", "fail", u === "" ? "no USER (runs as root)" : `USER ${u}`);
  return c("non-root", "pass", name === "65532" ? `USER ${u}` : `USER ${u} (contract target: 65532)`);
}

export function checkEntrypoint(entrypoint: string[] | null, manifestEntrypoint: string[] | null): Check {
  if (!entrypoint || entrypoint.length === 0) return c("entrypoint", "fail", "no ENTRYPOINT");
  if (entrypoint.length >= 2 && /(^|\/)(ba)?sh$/.test(entrypoint[0]) && entrypoint[1] === "-c") {
    return c("entrypoint", "fail", `shell form (${entrypoint.join(" ").slice(0, 60)})`);
  }
  if (!entrypoint[0].startsWith("/")) return c("entrypoint", "fail", `relative ${JSON.stringify(entrypoint[0])} (relies on WORKDIR/PATH)`);
  if (manifestEntrypoint && JSON.stringify(manifestEntrypoint) !== JSON.stringify(entrypoint)) {
    return c("entrypoint", "fail", `image ${JSON.stringify(entrypoint)} ≠ manifest ${JSON.stringify(manifestEntrypoint)}`);
  }
  return c("entrypoint", "pass", JSON.stringify(entrypoint));
}

export function checkManifest(inImage: Buffer | null, source: Buffer | null): Check {
  if (inImage === null) return c("manifest", "fail", `no ${MANIFEST_PATH} in the image`);
  if (source !== null && !inImage.equals(source)) return c("manifest", "fail", `${MANIFEST_PATH} differs from the source engram-analyzer.yaml`);
  return c("manifest", "pass", source !== null ? "present, byte-identical to the source" : "present");
}

export function checkLabel(label: string | undefined, manifestSha256: string | null): Check {
  if (!label) return c("label", "fail", `no ${LABEL_MANIFEST_DIGEST} label`);
  if (manifestSha256 === null) return c("label", "fail", `label ${label.slice(0, 19)}… but no manifest in the image to match`);
  return label === `sha256:${manifestSha256}`
    ? c("label", "pass", `sha256:${manifestSha256.slice(0, 12)}…`)
    : c("label", "fail", `label ${label.slice(0, 19)}… ≠ manifest sha256:${manifestSha256.slice(0, 12)}…`);
}

export function checkBusybox(code: number, stderr: string): Check {
  if (code === 0) return c("busybox", "pass", "mkdir, tar -x --no-same-owner --no-same-permissions, chmod work as uid 65532");
  return c("busybox", "fail", lastLine(stderr) || `exit ${code}`);
}

export interface RunExpect {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  name: string;
  repoNodeId: string;
  sha: string;
}
export interface RunFacts { code: number; stdout: Buffer; stderr: string; timedOut: boolean }

const MAX_STDOUT = 64 * 1024 * 1024;

/** The most telling stderr line: the first that names an error, else the last (docker's usage hint dropped). */
export function lastLine(s: string): string {
  const lines = s.trim().split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Run 'docker run --help'"));
  const err = lines.find((l) => /error|exception|not found|no such file|denied|refus|panic|fatal/i.test(l));
  return (err || lines.slice(-1)[0] || "").replace(/^docker: /, "").slice(0, 160);
}

/** The cli contract run: exit 0|1, exactly one schema-valid JSON document on stdout, metadata.analyzer = name. */
export function checkRun(id: string, r: RunFacts, want: RunExpect): Check {
  if (r.timedOut) return c(id, "fail", "timed out");
  if (r.code !== 0 && r.code !== 1) return c(id, "fail", `exit ${r.code}${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
  if (r.stdout.length > MAX_STDOUT) return c(id, "fail", `stdout is ${r.stdout.length} bytes (> 64 MiB)`);
  const text = r.stdout.toString("utf8").trim();
  if (text === "") return c(id, "fail", `exit ${r.code} with empty stdout${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  try { doc = JSON.parse(text); } catch (e) {
    return c(id, "fail", `stdout is not exactly one JSON document (${String((e as Error).message).slice(0, 60)})`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return c(id, "fail", "stdout is not a JSON object");
  const errors = validate(want.schema, doc, 5);
  if (errors.length) return c(id, "fail", `schema: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`);
  const got = doc?.metadata?.analyzer;
  if (got !== want.name) return c(id, "fail", `metadata.analyzer ${JSON.stringify(got)} ≠ manifest name ${JSON.stringify(want.name)}`);
  if (doc.repo !== want.repoNodeId) return c(id, "fail", `repo ${JSON.stringify(doc.repo)} ≠ REPO_NODE_ID`);
  if (doc.sha !== want.sha) return c(id, "fail", `sha ${JSON.stringify(doc.sha)} ≠ REPO_SHA`);
  if (r.code === 1 && doc?.metadata?.partial !== true) return c(id, "fail", "exit 1 without metadata.partial: true");
  const nodes = Array.isArray(doc.nodes) ? doc.nodes.length : 0;
  return c(id, "pass", `exit ${r.code}${r.code === 1 ? " (partial)" : ""}, ${nodes} nodes`);
}

export function checkMissingEnv(r: RunFacts): Check {
  if (r.timedOut) return c("missing-env", "fail", "timed out");
  return r.code === 2 ? c("missing-env", "pass", "exit 2") : c("missing-env", "fail", `exit ${r.code} (want 2)`);
}

/** Is a TCP socket LISTENing on `port` in /proc/net/tcp{,6} content? */
export function listening(procNetTcp: string, port: number): boolean {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return procNetTcp.split("\n").some((l) => {
    const f = l.trim().split(/\s+/);
    return f.length > 3 && /:([0-9A-F]{4})$/i.test(f[1]) && f[1].toUpperCase().endsWith(`:${hex}`) && f[3] === "0A";
  });
}

export function checkServe(running: boolean, isListening: boolean, port: number | null, detail: string): Check {
  if (port === null) return c("serve", "fail", "manifest declares interface: grpc without grpc.port");
  if (!running) return c("serve", "fail", `exited before listening${detail ? `: ${detail}` : ""}`);
  return isListening ? c("serve", "pass", `listening on :${port}`) : c("serve", "fail", `running but not listening on :${port}`);
}

/** Overall verdict: every check that applies passed. */
export function verdict(checks: Check[]): boolean {
  return checks.every((x) => x.status !== "fail");
}

const ICON: Record<Status, string> = { pass: "✅", fail: "❌", "n/a": "➖" };

/** One row per analyzer, one column per check (the cli columns; a grpc analyzer shows `serve` under `run`). */
export function renderTable(reports: Report[]): string {
  const cols = ["alpine", "base-pinned", "non-root", "entrypoint", "manifest", "label", "busybox", "run", "relocated", "missing-env"];
  const head = `| analyzer | profile | mode | ${cols.join(" | ")} | verdict |`;
  const sep = `|${"---|".repeat(cols.length + 4)}`;
  const rows = reports.map((r) => {
    const byId = new Map(r.checks.map((x) => [x.id, x]));
    if (r.profile === "grpc" && byId.has("serve")) byId.set("run", byId.get("serve") as Check);
    const cells = cols.map((id) => ICON[(byId.get(id)?.status || "n/a") as Status]);
    return `| \`${r.analyzer}\` | ${r.profile} | ${r.mode} | ${cells.join(" | ")} | ${r.ok ? "✅ pass" : "❌ fail"} |`;
  });
  return [head, sep, ...rows].join("\n");
}

/** The per-check detail of one report (markdown). */
export function renderDetail(r: Report): string {
  const lines = [
    `### \`${r.analyzer}\` — ${r.ok ? "✅ conforms" : "❌ does not conform"} (${r.profile} profile, ${r.mode})`, "",
    `Image: \`${r.image}\`${r.digest ? ` (\`${r.digest}\`)` : ""}`, "",
    "| check | result | detail |", "|---|---|---|",
    ...r.checks.map((x) => `| ${CHECK_TITLES[x.id] || x.id} | ${ICON[x.status]} ${x.status} | ${x.detail.replace(/\|/g, "\\|")} |`),
  ];
  return lines.join("\n");
}

/** Enforcement mode of one analyzer from the caller's list file (JSON object name → "enforce" | "report"). */
export function modeOf(listJson: string | null, analyzer: string, override: string): "enforce" | "report" {
  if (override === "enforce" || override === "report") return override;
  if (!listJson) return "report";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let list: any;
  try { list = JSON.parse(listJson); } catch { throw new Error("the enforcement list is not valid JSON"); }
  const v = list?.analyzers?.[analyzer];
  return v === "enforce" ? "enforce" : "report";
}
