// Self-test for sync.ts — node:test + node:assert only (no dependencies). Run: node --test <this file>
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atOrAbove, evaluate, fixPath, pickFixed, renderDecision } from "./sync.ts";

const ctx = mkdtempSync(join(tmpdir(), "sync-test-"));
writeFileSync(join(ctx, "Dockerfile"), "FROM golang:1.24 AS b\nRUN apk add --no-cache busybox=1.36 ca-certificates && \\\n  wget -qO/bin/grpc_health_probe https://x/grpc_health_probe\n");
writeFileSync(join(ctx, "go.mod"), "module x\n\ngo 1.24\n");
writeFileSync(join(ctx, "requirements.txt"), "# pinned\nRequests==2.31.0\nurllib3==2.0.0\n");

test("fix paths: every declarative route", () => {
  assert.equal(fixPath("os-pkgs", "alpine", "busybox", "1.37", ctx), "dockerfile");
  assert.equal(fixPath("os-pkgs", "alpine", "openssl", "3.1", ctx), "base-image");
  assert.equal(fixPath("lang-pkgs", "gobinary", "golang.org/x/net", "0.38.0", ctx, "/bin/grpc_health_probe"), "dockerfile-binary");
  assert.equal(fixPath("lang-pkgs", "gobinary", "stdlib", "1.24.6", ctx), "base-image");
  assert.equal(fixPath("lang-pkgs", "gomod", "golang.org/x/net", "0.38.0", ctx), "commit-go");
  assert.equal(fixPath("lang-pkgs", "pip", "requests", "2.32.0", ctx), "commit-pip");
  assert.equal(fixPath("lang-pkgs", "pip", "flask", "3.0", ctx), "dependabot-lang");
  assert.equal(fixPath("lang-pkgs", "npm", "lodash", "4.17.21", ctx), "dependabot-lang");
  assert.equal(fixPath("lang-pkgs", "npm", "lodash", "", ctx), "none");
});

test("pickFixed: smallest fixed version above the installed one", () => {
  assert.equal(pickFixed("v0.33.0", "0.36.0, 0.38.0"), "0.36.0");
  assert.equal(pickFixed("0.37.0", "0.36.0, 0.38.0"), "0.38.0");
  assert.equal(atOrAbove("high").join(), "CRITICAL,HIGH");
  assert.deepEqual(atOrAbove("none"), []);
});

const trivy = { Results: [
  { Class: "lang-pkgs", Type: "gomod", Vulnerabilities: [
    { VulnerabilityID: "CVE-1", PkgName: "golang.org/x/net", InstalledVersion: "v0.33.0", FixedVersion: "0.38.0", Severity: "CRITICAL" },
    { VulnerabilityID: "CVE-2", PkgName: "golang.org/x/text", InstalledVersion: "v0.1.0", FixedVersion: "", Severity: "CRITICAL" }] },
  { Class: "os-pkgs", Type: "alpine", Vulnerabilities: [
    { VulnerabilityID: "CVE-3", PkgName: "openssl", InstalledVersion: "3.0", FixedVersion: "3.1", Severity: "HIGH" }] },
] };

test("evaluate: policy-fail with OS packages; ignore-unfixed drops the unfixed CRITICAL", () => {
  const svc: any = { service: "a", context: ctx, scan: { conclusion: "failure" } };
  const cands = evaluate(svc, { status: "policy-fail", threshold: "CRITICAL" }, trivy, null, atOrAbove("critical"));
  assert.deepEqual(svc.counts, { CRITICAL: 2, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
  assert.equal(svc.blocking.length, 2);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].path, "commit-go");
  const svc2: any = { service: "a", context: ctx, scan: { conclusion: "failure" } };
  evaluate(svc2, { status: "policy-fail", threshold: "HIGH", ignore_unfixed: true }, trivy, null, []);
  assert.deepEqual(svc2.blocking.map((v: any) => v.id), ["CVE-1", "CVE-3"]);
  assert.equal(svc2.blocking[1].path, "base-image");
});

test("decide: pass vs policy-fail and the consolidated table", () => {
  const base = { head_sha: "0123456789abcdef", accept_level: "none", others: [] };
  const ok = renderDecision({ ...base, services: [{ service: "a", run_url: "u", build: { conclusion: "success" }, status: "pass", threshold: "CRITICAL", counts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 }, blocking: [] }] }, { applied: [], deferred: [] }, "");
  assert.equal(ok.status, "pass");
  assert.match(ok.md, /^# :shield: PR security synchronizer — ✅ pass\n/);
  assert.match(ok.md, /\| \[a\]\(u\) \| ✅ \| ✅ \| CRITICAL \| 0 \| 1 \| 0 \| 0 \| 0 \| — \|/);
  const svc: any = { service: "a", run_url: "u", context: ctx, build: { conclusion: "success" }, scan: { conclusion: "failure" } };
  evaluate(svc, { status: "policy-fail", threshold: "CRITICAL" }, trivy, null, []);
  const bad = renderDecision({ ...base, services: [svc] }, { applied: [], deferred: [] }, "");
  assert.equal(bad.status, "policy-fail");
  assert.equal(bad.blocking, 2);
  assert.match(bad.md, /\*\*Fix paths for the blocking findings:\*\* `commit-go` 1, `none` 1/);
});
