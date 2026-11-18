import { test } from "node:test";
import { lastLine } from "./checks.ts";
import assert from "node:assert/strict";
import { validate } from "./schema.ts";
import { flowSeq, readManifest, stripComment } from "./manifest.ts";
import {
  checkAlpine, checkBasePinned, checkEntrypoint, checkLabel, checkManifest, checkMissingEnv, checkNonRoot, checkRun,
  checkServe, finalBase, listening, modeOf, renderTable, tarFirstFile, verdict,
} from "./checks.ts";
import { digestOf, parseEnvLines, platformChild, repoOf, runGate } from "./gate.ts";
import type { Docker } from "./types.ts";

const SCHEMA = {
  type: "object",
  required: ["repo", "sha", "nodes", "metadata"],
  additionalProperties: false,
  properties: {
    repo: { type: "string", pattern: "^devsecops::repo::.+/.+/.+$" },
    sha: { type: "string" },
    nodes: { type: "array", items: { $ref: "#/$defs/Node" } },
    metadata: { type: "object", required: ["analyzer"], properties: { analyzer: { type: "string" }, partial: { type: "boolean" } } },
  },
  $defs: { Node: { type: "object", required: ["id"], properties: { id: { type: "string" }, n: { type: "integer", minimum: 0 } } } },
};
const REPO = "devsecops::repo::github.com/o/r";
const want = { schema: SCHEMA, name: "npm-default", repoNodeId: REPO, sha: "abc" };
const doc = (o: object = {}) => Buffer.from(JSON.stringify({ repo: REPO, sha: "abc", nodes: [{ id: "x" }], metadata: { analyzer: "npm-default" }, ...o }));

test("schema: valid, missing required, additional property, $ref, pattern, minimum", () => {
  assert.deepEqual(validate(SCHEMA, JSON.parse(doc().toString())), []);
  assert.match(validate(SCHEMA, { repo: REPO, sha: "a", nodes: [] })[0], /missing required "metadata"/);
  assert.match(validate(SCHEMA, { ...JSON.parse(doc().toString()), extra: 1 })[0], /unexpected property "extra"/);
  assert.match(validate(SCHEMA, { ...JSON.parse(doc().toString()), nodes: [{}] })[0], /\$\.nodes\[0\]: missing required "id"/);
  assert.match(validate(SCHEMA, { ...JSON.parse(doc().toString()), repo: "nope" })[0], /does not match/);
  assert.match(validate(SCHEMA, { ...JSON.parse(doc().toString()), nodes: [{ id: "a", n: -1 }] })[0], /below minimum/);
  assert.match(validate({ type: "object", unknownKeyword: 1 }, {})[0], /not supported/);
  assert.deepEqual(validate({ if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } }, { a: 2 }), []);
  assert.equal(validate({ if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } }, { a: 1 }).length, 1);
});

test("manifest: flow seq with comment, grpc inline map, block form, timeout", () => {
  assert.equal(stripComment('entrypoint: ["analyzer"]            # the binary'), 'entrypoint: ["analyzer"]            ');
  assert.deepEqual(flowSeq('["java", "-jar", \'analyzer.jar\']'), ["java", "-jar", "analyzer.jar"]);
  const m = readManifest([
    "# header", "contract: engram-analyzer/v1", "name: osv-vuln-scanner", "version: 1.0.0", "description: >", "  long text: here",
    "interface: grpc", "grpc: {service: VulnerabilityScanner, rpc: ScanPURLs, port: 50051}",
    'entrypoint: ["/usr/local/bin/osv-vuln-scanner"]  # c', "timeout: 300s",
  ].join("\n"));
  assert.equal(m.name, "osv-vuln-scanner");
  assert.equal(m.interface, "grpc");
  assert.equal(m.grpcPort, 50051);
  assert.deepEqual(m.entrypoint, ["/usr/local/bin/osv-vuln-scanner"]);
  assert.equal(m.timeoutSeconds, 300);
  const b = readManifest("name: x\ngrpc:\n  service: S\n  port: 9000\nentrypoint:\n  - /bin/a\n  - b\n");
  assert.equal(b.grpcPort, 9000);
  assert.deepEqual(b.entrypoint, ["/bin/a", "b"]);
  assert.equal(b.interface, "cli");
  const e = readManifest("name: j\nenv:\n  required: [REPO_NODE_ID]\n  set: { BUILD_DECISION_FILE: /in/decision.json }   # c\n  optional: [X]\n");
  assert.deepEqual(e.envSet, ["BUILD_DECISION_FILE=/in/decision.json"]);
  assert.deepEqual(readManifest("name: k\n").envSet, []);
});

test("tar: first regular file of a docker cp stream", () => {
  const body = Buffer.from("ID=alpine\nVERSION_ID=3.22.2\n");
  const h = Buffer.alloc(512);
  h.write("os-release", 0);
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("0", 156);
  const tar = Buffer.concat([h, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
  assert.equal(tarFirstFile(tar)?.toString(), body.toString());
  assert.equal(checkAlpine(body.toString()).status, "pass");
  assert.equal(checkAlpine('ID="debian"\nVERSION_ID="12"').status, "fail");
  assert.equal(checkAlpine(null).status, "fail");
});

test("Dockerfile final base: stage alias, ARG default, pinning", () => {
  const pinned = "alpine:3.22@sha256:" + "a".repeat(64);
  assert.equal(finalBase(`ARG BASE=${pinned}\nFROM golang:1.26 AS build\nFROM \${BASE} AS final\nFROM final\n`), pinned);
  assert.equal(checkBasePinned(`FROM golang AS b\nFROM ${pinned}\n`).status, "pass");
  assert.equal(checkBasePinned("FROM alpine:3.22\n").status, "fail");
  assert.equal(checkBasePinned(`FROM gcr.io/distroless/static@sha256:${"b".repeat(64)}\n`).status, "fail");
  assert.equal(checkBasePinned(`FROM python:3.13-alpine@sha256:${"b".repeat(64)}\n`).status, "pass");
  assert.equal(checkBasePinned(`FROM localhost:5000/alpine:3.22@sha256:${"b".repeat(64)}\n`).status, "pass");
  assert.equal(checkBasePinned(null).status, "n/a");
});

test("USER, ENTRYPOINT, manifest, label", () => {
  assert.equal(checkNonRoot("").status, "fail");
  assert.equal(checkNonRoot("root").status, "fail");
  assert.equal(checkNonRoot("0:0").status, "fail");
  assert.equal(checkNonRoot("65532:65532").status, "pass");
  assert.equal(checkEntrypoint(["analyzer"], null).status, "fail");
  assert.equal(checkEntrypoint(["/bin/sh", "-c", "x"], null).status, "fail");
  assert.equal(checkEntrypoint(["/usr/local/bin/analyzer"], ["/usr/local/bin/analyzer"]).status, "pass");
  assert.equal(checkEntrypoint(["/usr/local/bin/analyzer"], ["/other"]).status, "fail");
  assert.equal(checkEntrypoint(null, null).status, "fail");
  const m = Buffer.from("name: x\n");
  assert.equal(checkManifest(null, m).status, "fail");
  assert.equal(checkManifest(m, Buffer.from("name: y\n")).status, "fail");
  assert.equal(checkManifest(m, m).status, "pass");
  assert.equal(checkLabel(undefined, "ab").status, "fail");
  assert.equal(checkLabel("sha256:ab", "ab").status, "pass");
  assert.equal(checkLabel("sha256:cd", "ab").status, "fail");
});

test("contract run: exit codes, single document, name, partial", () => {
  const ok = { code: 0, stdout: doc(), stderr: "", timedOut: false };
  assert.equal(checkRun("run", ok, want).status, "pass");
  assert.equal(checkRun("run", { ...ok, code: 2 }, want).status, "fail");
  assert.equal(checkRun("run", { ...ok, timedOut: true }, want).status, "fail");
  assert.equal(checkRun("run", { ...ok, stdout: Buffer.concat([doc(), doc()]) }, want).status, "fail");
  assert.equal(checkRun("run", { ...ok, stdout: doc({ metadata: { analyzer: "other" } }) }, want).status, "fail");
  assert.equal(checkRun("run", { ...ok, code: 1 }, want).status, "fail");
  assert.equal(checkRun("run", { ...ok, code: 1, stdout: doc({ metadata: { analyzer: "npm-default", partial: true } }) }, want).status, "pass");
  assert.equal(checkRun("run", { ...ok, stdout: doc({ sha: "zzz" }) }, want).status, "fail");
  assert.equal(checkMissingEnv({ ...ok, code: 2 }).status, "pass");
  assert.equal(checkMissingEnv(ok).status, "fail");
});

test("stderr: the telling line", () => {
  assert.equal(lastLine("docker: Error response from daemon: exec: \"/bin/sh\": stat /bin/sh: no such file or directory\n\nRun 'docker run --help' for more information\n"),
    'Error response from daemon: exec: "/bin/sh": stat /bin/sh: no such file or directory');
  assert.equal(lastLine("node:internal\nError: Cannot find module '/x'\n  at foo\nNode.js v24"), "Error: Cannot find module '/x'");
  assert.equal(lastLine("just info\n"), "just info");
});

test("grpc: /proc/net/tcp LISTEN parsing", () => {
  const tcp = "  sl  local_address rem_address   st\n   0: 00000000:C383 00000000:0000 0A 00000000:00000000\n";
  assert.equal(listening(tcp, 50051), true);
  assert.equal(listening(tcp, 50052), false);
  assert.equal(listening(tcp.replace(" 0A ", " 01 "), 50051), false);
  assert.equal(checkServe(true, true, 50051, "").status, "pass");
  assert.equal(checkServe(false, false, 50051, "boom").status, "fail");
  assert.equal(checkServe(true, false, null, "").status, "fail");
});

test("enforcement list and verdict", () => {
  const list = '{\n"analyzers": {\n\n"npm-default": "enforce",\n\n"nuget-default": "report"\n}\n}';
  assert.equal(modeOf(list, "npm-default", ""), "enforce");
  assert.equal(modeOf(list, "nuget-default", ""), "report");
  assert.equal(modeOf(list, "absent", ""), "report");
  assert.equal(modeOf(null, "npm-default", ""), "report");
  assert.equal(modeOf(list, "npm-default", "report"), "report");
  assert.throws(() => modeOf("{", "x", ""));
  assert.equal(verdict([{ id: "a", status: "pass", detail: "" }, { id: "b", status: "n/a", detail: "" }]), true);
  assert.equal(verdict([{ id: "a", status: "fail", detail: "" }]), false);
  assert.equal(digestOf("r@sha256:abc", []), "sha256:abc");
  assert.equal(digestOf("r:t", ["r@sha256:def"]), "sha256:def");
  assert.equal(repoOf("ghcr.io/o/r/svc@sha256:abc"), "ghcr.io/o/r/svc");
  assert.equal(repoOf("localhost:5000/svc:tag"), "localhost:5000/svc");
  const idx = JSON.stringify({ manifests: [
    { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
    { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
    { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } }] });
  assert.equal(platformChild(idx, "linux/amd64"), "sha256:amd");
  assert.equal(platformChild(JSON.stringify({ config: {} }), "linux/amd64"), null);
  assert.deepEqual(parseEnvLines("# c\nBUILD_DECISION_FILE=/in/decision.json\n\n"), ["BUILD_DECISION_FILE=/in/decision.json"]);
  assert.throws(() => parseEnvLines("lower=x"));
  assert.throws(() => parseEnvLines("REPO_ROOT=/x"));
});

test("runGate end to end with a fake docker (cli profile, all pass)", async () => {
  const manifest = Buffer.from('contract: engram-analyzer/v1\nname: npm-default\nversion: 1.0.0\nentrypoint: ["/usr/local/bin/analyzer"]\n');
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(manifest).digest("hex");
  const tarOf = (b: Buffer) => {
    const h = Buffer.alloc(512);
    h.write("f", 0);
    h.write(b.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("0", 156);
    return Buffer.concat([h, b, Buffer.alloc((512 - (b.length % 512)) % 512), Buffer.alloc(1024)]);
  };
  const { FIXTURE_REPO_NODE_ID, FIXTURE_SHA } = await import("./gate.ts");
  const out = Buffer.from(JSON.stringify({ repo: FIXTURE_REPO_NODE_ID, sha: FIXTURE_SHA, nodes: [], metadata: { analyzer: "npm-default" } }));
  const fake: Docker = async (args) => {
    const r = (code: number, stdout = Buffer.alloc(0)) => ({ code, stdout, stderr: "", timedOut: false });
    if (args[0] === "image") return r(0, Buffer.from(JSON.stringify([{ Id: "sha256:img", Os: "linux", Architecture: "amd64", RepoDigests: ["x@sha256:1"], Config: { User: "65532:65532", Entrypoint: ["/usr/local/bin/analyzer"], Labels: { "dev.rekorda.engram.analyzer.manifest-digest": `sha256:${sha}` } } }])));
    if (args[0] === "cp") return r(0, tarOf(args[2].endsWith("os-release") ? Buffer.from("ID=alpine\nVERSION_ID=3.22.2\n") : manifest));
    if (args[0] === "run" && args.includes("/bin/sh")) return r(0);
    if (args[0] === "run") return args.some((a) => a.startsWith("REPO_NODE_ID=")) ? r(0, out) : r(2);
    return r(0);
  };
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "conformance-"));
  writeFileSync(join(dir, "schema.json"), JSON.stringify(SCHEMA));
  const rep = await runGate({ image: "x:main", fixture: dir, schemaPath: join(dir, "schema.json"), mode: "enforce", pull: false }, fake);
  assert.equal(rep.ok, true, JSON.stringify(rep.checks.filter((x) => x.status === "fail")));
  assert.equal(rep.analyzer, "npm-default");
  assert.match(renderTable([rep]), /\| `npm-default` \| cli \| enforce \|/);
});
