// 🧩 engram-analyzer conformance gate — does this analyzer IMAGE keep contract engram-analyzer/v1?
// (okf/analyzer-contract-v1.md in ohanalabs-ai/vionix-codegraph-analyzer.)
//
// Facts are gathered with the docker CLI only (docker.ts), verdicts are the pure functions of checks.ts:
//   static  — final base is Alpine (/etc/os-release, read with `docker cp`, so no binary in the image is needed);
//             the Dockerfile's final FROM is alpine:<tag>@sha256:…; image USER is non-root; exec-form absolute
//             ENTRYPOINT equal to the manifest's; /engram/analyzer.yaml present (= the source manifest) and the
//             label dev.rekorda.engram.analyzer.manifest-digest = its sha256; busybox mkdir/tar/chmod work as
//             uid 65532 on a read-only root (the Substrate runner stages the snapshot with them)
//   cli     — `docker run --network none --read-only --cap-drop ALL --user 65532:65532 -v <fixture>:/repo:ro …`
//             → exactly one schema-valid sub-graph on stdout, metadata.analyzer = manifest name, exit 0|1; the same
//             with the tree elsewhere (REPO_ROOT) and cwd /; without REPO_NODE_ID → exit 2
//   grpc    — (manifest `interface: grpc`, registry `service: true`; contract §2 "every row except stdout/exit
//             codes") the static checks, then the service starts under the same sandbox and listens on grpc.port
//
// Entry points: `run(ctx)` for actions/github-script (inputs via env, see the reusable workflow), and runGate()
// for cli.ts (local runs: `node actions/engram/analyzer-conformance/cli.ts --help`).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Check, Ctx, Docker, Report } from "./types.ts";
import { readManifest } from "./manifest.ts";
import type { ManifestInfo } from "./manifest.ts";
import {
  LABEL_MANIFEST_DIGEST, MANIFEST_PATH, RUN_UID, c, checkAlpine, checkBasePinned, checkBusybox, checkEntrypoint,
  checkLabel, checkManifest, checkMissingEnv, checkNonRoot, checkRun, checkServe, listening, modeOf, renderDetail,
  renderTable, tarFirstFile, verdict,
} from "./checks.ts";

/** Netns probe for the grpc profile (reads /proc/net/tcp of the service's network namespace). */
export const PROBE_IMAGE = "alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f";
export const FIXTURE_REPO_NODE_ID = "devsecops::repo::github.com/ohanalabs-ai/analyzer-conformance-fixture";
export const FIXTURE_SHA = "0c0ffee00c0ffee00c0ffee00c0ffee00c0ffee0";
const RELOCATED_ROOT = "/mnt/conformance/tree";

export interface GateOptions {
  image: string;
  fixture: string;
  schemaPath: string;
  manifestPath?: string;
  dockerfilePath?: string;
  analyzer?: string;
  mode: "enforce" | "report";
  profile?: "cli" | "grpc" | "";
  platform?: string;
  pull?: boolean;
  timeoutSeconds?: number;
  /** A directory staged read-only at /in (contract §7 `consumes`, e.g. a build tier's preflight verdict). */
  inputsDir?: string;
  /** Extra KEY=VALUE env for the contract runs (the manifest's `env.set`, a staged input's path variable). */
  env?: string[];
}

/** "KEY=VALUE" lines (blank lines and # comments dropped); a malformed line is an error. */
export function parseEnvLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    if (!/^[A-Z][A-Z0-9_]*=/.test(l)) throw new Error(`env line is not KEY=VALUE: ${l.slice(0, 40)}`);
    if (/^(REPO_NODE_ID|REPO_SHA|REPO_ROOT)=/.test(l)) throw new Error(`env may not override ${l.split("=")[0]}`);
    return l;
  });
}

// The run-time sandbox of contract §2: no network, read-only root, no capabilities, arbitrary non-root uid,
// writable /tmp only.
export function sandbox(): string[] {
  return [
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", RUN_UID, "--tmpfs", "/tmp:rw,mode=1777,size=512m",
  ];
}

export const BUSYBOX_SCRIPT = [
  "set -e", "cd /tmp", "mkdir -p s/a/b", "echo conformance > s/a/b/f", "tar -c -f t.tar -C s a", "mkdir -p d",
  "tar -x -f t.tar -C d --no-same-owner --no-same-permissions", "chmod -R u+rwX,go+rX d", "test -f d/a/b/f",
].join("; ");

function name(): string {
  return `engram-conformance-${randomBytes(5).toString("hex")}`;
}

async function cpFile(docker: Docker, ctr: string, path: string): Promise<Buffer | null> {
  const r = await docker(["cp", "-L", `${ctr}:${path}`, "-"]);
  return r.code === 0 ? tarFirstFile(r.stdout) : null;
}

/** repo without tag or digest: "ghcr.io/o/r/svc:tag" → "ghcr.io/o/r/svc" (registry ports kept). */
export function repoOf(image: string): string {
  const noDigest = image.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

/** The digest of `platform`'s manifest in an OCI index / Docker manifest list (raw JSON); null when not an index. */
export function platformChild(rawIndex: string, platform: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let idx: any;
  try { idx = JSON.parse(rawIndex); } catch { return null; }
  if (!Array.isArray(idx?.manifests)) return null;
  const [os, arch, variant] = platform.split("/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = idx.manifests.find((x: any) => x?.platform?.os === os && x?.platform?.architecture === arch && (!variant || x?.platform?.variant === variant));
  return m?.digest || null;
}

export function digestOf(image: string, repoDigests: string[]): string {
  const at = image.indexOf("@sha256:");
  if (at >= 0) return image.slice(at + 1);
  const d = repoDigests.find((x) => x.includes("@sha256:"));
  return d ? d.slice(d.indexOf("@") + 1) : "";
}

export async function runGate(o: GateOptions, docker: Docker): Promise<Report> {
  const platform = o.platform || "linux/amd64";
  const checks: Check[] = [];
  const report = (analyzer: string, digest: string, profile: "cli" | "grpc"): Report =>
    ({ analyzer, image: o.image, digest, profile, mode: o.mode, checks, ok: verdict(checks) });

  let pullError = "";
  let local = o.image;
  if (o.pull !== false) {
    // Pull the platform's own manifest (repo@<child digest>) when the reference is an index: unambiguous, and a
    // daemon that already holds another platform of the same index digest cannot refuse it.
    const raw = await docker(["buildx", "imagetools", "inspect", "--raw", o.image], { timeoutMs: 120_000 });
    if (raw.code === 0) {
      const child = platformChild(raw.stdout.toString("utf8"), platform);
      if (child) local = `${repoOf(o.image)}@${child}`;
    }
    const p = await docker(["pull", "--quiet", "--platform", platform, local], { timeoutMs: 15 * 60_000 });
    // A containerd image store can refuse to re-pull a digest it already holds ("cannot overwrite digest"):
    // only an image that is then NOT inspectable is a failure.
    if (p.code !== 0) pullError = p.stderr.trim().slice(0, 160);
  }
  const insp = await docker(["image", "inspect", local]);
  if (insp.code !== 0) {
    checks.push(c("run", "fail", pullError ? `docker pull failed: ${pullError}` : `docker image inspect failed: ${insp.stderr.trim().slice(0, 160)}`));
    return report(o.analyzer || o.image, "", "cli");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const img: any = (JSON.parse(insp.stdout.toString("utf8")) as any[])[0];
  const cfg = img?.Config || {};
  const digest = digestOf(o.image, img?.RepoDigests || []);
  // Everything below runs the local image by its ID: unambiguous, and immune to a tag moving mid-gate.
  const ref = String(img?.Id || o.image);
  const got = `${img?.Os}/${img?.Architecture}`;
  if (!platform.startsWith(got)) {
    checks.push(c("run", "fail", `local image is ${got}, not ${platform}${pullError ? ` (docker pull: ${pullError})` : ""}`));
    return report(o.analyzer || o.image, digest, "cli");
  }

  // Files out of the image without running anything in it.
  const ctr = name();
  const created = await docker(["create", "--name", ctr, "--entrypoint", "/engram-conformance-noop", ref]);
  let osRelease: string | null = null;
  let manifestBytes: Buffer | null = null;
  if (created.code === 0) {
    osRelease = (await cpFile(docker, ctr, "/etc/os-release"))?.toString("utf8") ?? null;
    manifestBytes = await cpFile(docker, ctr, MANIFEST_PATH);
    await docker(["rm", "-f", ctr]);
  }
  const sourceBytes = o.manifestPath && existsSync(o.manifestPath) ? readFileSync(o.manifestPath) : null;
  const info: ManifestInfo | null = manifestBytes ? readManifest(manifestBytes.toString("utf8"))
    : sourceBytes ? readManifest(sourceBytes.toString("utf8")) : null;
  const analyzer = info?.name || o.analyzer || o.image;
  const profile: "cli" | "grpc" = o.profile === "cli" || o.profile === "grpc" ? o.profile : info?.interface || "cli";
  const dockerfile = o.dockerfilePath && existsSync(o.dockerfilePath) ? readFileSync(o.dockerfilePath, "utf8") : null;

  checks.push(checkAlpine(osRelease));
  checks.push(checkBasePinned(o.dockerfilePath ? dockerfile ?? "" : null));
  checks.push(checkNonRoot(String(cfg.User || "")));
  checks.push(checkEntrypoint(Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint : null, info?.entrypoint ?? null));
  checks.push(checkManifest(manifestBytes, sourceBytes));
  checks.push(checkLabel(cfg.Labels?.[LABEL_MANIFEST_DIGEST], manifestBytes ? createHash("sha256").update(manifestBytes).digest("hex") : null));
  const bb = await docker(["run", "--rm", ...sandbox(), "--entrypoint", "/bin/sh", ref, "-c", BUSYBOX_SCRIPT], { timeoutMs: 60_000 });
  checks.push(checkBusybox(bb.code, bb.stderr));

  const timeoutMs = 1000 * Math.min(o.timeoutSeconds || 600, info?.timeoutSeconds || 600);
  const engramEnv = ["-e", "ENGRAM_CONTRACT=engram-analyzer/v1", "-e", `ENGRAM_ANALYZER=${analyzer}@${info?.version || "0"}`,
    ...[...(info?.envSet || []), ...(o.env || [])].flatMap((kv) => ["-e", kv]), ...(o.inputsDir ? ["-v", `${resolve(o.inputsDir)}:/in:ro`] : [])];

  if (profile === "grpc") {
    const port = info?.grpcPort ?? null;
    const svc = name();
    const started = await docker(["run", "-d", "--name", svc, ...sandbox(), ...engramEnv,
      ...(port ? ["-e", `PORT=${port}`] : []), ref]);
    let running = started.code === 0;
    let isListening = false;
    for (let i = 0; running && port && i < 30 && !isListening; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await docker(["inspect", "-f", "{{.State.Running}}", svc]);
      running = st.stdout.toString().trim() === "true";
      if (!running) break;
      const probe = await docker(["run", "--rm", "--network", `container:${svc}`, PROBE_IMAGE, "cat", "/proc/net/tcp", "/proc/net/tcp6"]);
      isListening = listening(probe.stdout.toString("utf8"), port);
    }
    const logs = await docker(["logs", "--tail", "5", svc]);
    await docker(["rm", "-f", svc]);
    const why = started.code !== 0 ? started.stderr : logs.stderr || logs.stdout.toString("utf8");
    checks.push(checkServe(running, isListening, port, why.trim().split("\n").slice(-1)[0]?.slice(0, 120) || ""));
    for (const id of ["run", "relocated", "missing-env"]) checks.push(c(id, "n/a", "grpc profile (no stdout/exit-code contract)"));
    return report(analyzer, digest, profile);
  }

  const fixture = resolve(o.fixture);
  const schema = JSON.parse(readFileSync(o.schemaPath, "utf8"));
  const want = { schema, name: analyzer, repoNodeId: FIXTURE_REPO_NODE_ID, sha: FIXTURE_SHA };
  const contractRun = async (extra: string[], env: string[]) => {
    const n = name();
    return docker(["run", "--rm", "--name", n, ...sandbox(), ...extra, ...engramEnv, ...env, ref],
      { timeoutMs, onTimeout: async () => { await docker(["rm", "-f", n]); } });
  };
  const ids = ["-e", `REPO_NODE_ID=${FIXTURE_REPO_NODE_ID}`, "-e", `REPO_SHA=${FIXTURE_SHA}`];
  checks.push(checkRun("run", await contractRun(["-v", `${fixture}:/repo:ro`], ids), want));
  checks.push(checkRun("relocated", await contractRun(["-v", `${fixture}:${RELOCATED_ROOT}:ro`, "-w", "/"],
    [...ids, "-e", `REPO_ROOT=${RELOCATED_ROOT}`]), want));
  checks.push(checkMissingEnv(await contractRun(["-v", `${fixture}:/repo:ro`], ["-e", `REPO_SHA=${FIXTURE_SHA}`])));
  return report(analyzer, digest, profile);
}

function ws(p: string): string {
  return isAbsolute(p) ? p : join(process.env.GITHUB_WORKSPACE || process.cwd(), p);
}

/** actions/github-script entry point. Inputs (env): IMAGE, FIXTURE, SCHEMA, MANIFEST, DOCKERFILE, ANALYZER,
 * ENFORCEMENT_FILE, MODE (enforce|report|"" = from the file), PROFILE, PLATFORM, TIMEOUT_SECONDS, INPUTS_DIR, EXTRA_ENV. */
export default async function run({ core }: Ctx): Promise<void> {
  const env = process.env;
  const image = env.IMAGE || "";
  if (!image) {
    core.notice("no image was built in this run — conformance skipped");
    await core.summary.addRaw("## 🧩 analyzer conformance\n\nNo image was built in this run — skipped.\n", true).write();
    core.setOutput("status", "skipped");
    return;
  }
  const analyzerIn = env.ANALYZER || "";
  const listPath = env.ENFORCEMENT_FILE ? ws(env.ENFORCEMENT_FILE) : "";
  let mode: "enforce" | "report";
  try {
    mode = modeOf(listPath && existsSync(listPath) ? readFileSync(listPath, "utf8") : null, analyzerIn, env.MODE || "");
  } catch (e) {
    core.setFailed(String((e as Error).message));
    return;
  }
  const opts: GateOptions = {
    image,
    fixture: ws(env.FIXTURE || ""),
    schemaPath: ws(env.SCHEMA || "schema/subgraph.schema.json"),
    manifestPath: env.MANIFEST ? ws(env.MANIFEST) : undefined,
    dockerfilePath: env.DOCKERFILE ? ws(env.DOCKERFILE) : undefined,
    analyzer: analyzerIn || undefined,
    mode,
    profile: (env.PROFILE || "") as GateOptions["profile"],
    platform: env.PLATFORM || "linux/amd64",
    timeoutSeconds: Number(env.TIMEOUT_SECONDS || "600"),
    inputsDir: env.INPUTS_DIR ? ws(env.INPUTS_DIR) : undefined,
    env: [],
  };
  try { opts.env = parseEnvLines(env.EXTRA_ENV || ""); } catch (e) { core.setFailed(String((e as Error).message)); return; }
  const { docker } = await import("./docker.ts");
  if (image.startsWith("ghcr.io/") && env.GH_TOKEN) {
    // read-only pull of the image just built (packages: read); the token goes in on stdin, never argv
    const login = await docker(["login", "ghcr.io", "-u", env.GITHUB_ACTOR || "github-actions", "--password-stdin"], { input: Buffer.from(env.GH_TOKEN) });
    if (login.code !== 0) core.warning(`docker login ghcr.io failed: ${login.stderr.trim().slice(0, 160)}`);
  }
  const r = await runGate(opts, docker);
  const status = r.ok ? "pass" : mode === "enforce" ? "fail" : "report-fail";
  await core.summary.addRaw([
    `## 🧩 analyzer conformance — \`${r.analyzer}\``, "",
    renderTable([r]), "", renderDetail(r), "",
    r.ok ? "**✅ conforms to engram-analyzer/v1**"
      : mode === "enforce" ? "**❌ does not conform — enforced, the job fails**"
        : `**⚠️ does not conform — report-only** (flip \`${r.analyzer}\` to \`enforce\` in the enforcement list once migrated)`,
    "",
  ].join("\n"), true).write();
  core.setOutput("status", status);
  core.setOutput("report", JSON.stringify(r));
  const failed = r.checks.filter((x) => x.status === "fail").map((x) => `${x.id}: ${x.detail}`);
  if (r.ok) core.info(`${r.analyzer} conforms`);
  else if (mode === "enforce") core.setFailed(`${r.analyzer} does not conform:\n${failed.join("\n")}`);
  else core.warning(`${r.analyzer} does not conform (report-only):\n${failed.join("\n")}`);
}
