// Self-test for the report formatter — `node --test actions/docker/image-security/` (Node 24+,
// native TypeScript type stripping; node:test + node:assert only, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./report.ts";
import { repoOf } from "./resolve.ts";

const sbom = {
  packages: [
    { SPDXID: "SPDXRef-DocumentRoot", name: "root" },
    { SPDXID: "SPDXRef-c", name: "img", primaryPackagePurpose: "CONTAINER" },
    { SPDXID: "SPDXRef-1", name: "google.golang.org/grpc", versionInfo: "v1.54.0", externalRefs: [{ referenceLocator: "pkg:golang/google.golang.org/grpc@v1.54.0" }] },
    { SPDXID: "SPDXRef-2", name: "openssl", versionInfo: "3.0.8-r0", externalRefs: [{ referenceLocator: "pkg:apk/alpine/openssl@3.0.8-r0" }] },
  ],
};
const trivy = {
  Results: [
    { Vulnerabilities: [
      { VulnerabilityID: "CVE-1", PkgName: "google.golang.org/grpc", InstalledVersion: "v1.54.0", FixedVersion: "1.79.3", Severity: "CRITICAL" },
      { VulnerabilityID: "CVE-2", PkgName: "stdlib", InstalledVersion: "1.20.3", FixedVersion: "", Severity: "CRITICAL" },
      { VulnerabilityID: "CVE-3", PkgName: "x", InstalledVersion: "1", FixedVersion: "2", Severity: "HIGH" },
    ] },
    { Vulnerabilities: [ // OS packages (apk) — the second Result trivy emits for an image's OS layer
      { VulnerabilityID: "CVE-4", PkgName: "openssl", InstalledVersion: "3.0.8-r0", FixedVersion: "3.0.15-r0", Severity: "MEDIUM" },
    ] },
    { Vulnerabilities: null },
  ],
};
const base = { sbom, trivy, image: "ghcr.io/o/r/svc:main", digest: "sha256:abc", revision: "deadbeef", sbomOrigin: "build attestation (GitHub, verified)" };

test("policy-fail at CRITICAL; Vionix format; OS packages counted", () => {
  const r = buildReport({ ...base, threshold: "CRITICAL", ignoreUnfixed: false });
  assert.equal(r.status, "policy-fail");
  assert.equal(r.blocking.length, 2);
  assert.deepEqual(r.counts, { CRITICAL: 2, HIGH: 1, MEDIUM: 1, LOW: 0, UNKNOWN: 0 });
  assert.equal(r.fixable.CRITICAL, 1);
  assert.equal(r.packageCount, 2); // root + CONTAINER excluded
  assert.match(r.md, /^# :jigsaw: SBOM Report\n\n## :whale: ghcr\.io\/o\/r\/svc:main\n/);
  assert.match(r.md, /\|apk\|/); assert.match(r.md, /\|golang\|/);
  assert.match(r.md, /## :shield: Vulnerabilities — :x: policy-fail/);
  assert.match(r.md, /\|CVE-2\|stdlib\|1\.20\.3\|—\|CRITICAL\|/);
});

test("ignore-unfixed drops unfixed findings from the gate only", () => {
  const r = buildReport({ ...base, threshold: "CRITICAL", ignoreUnfixed: true });
  assert.equal(r.status, "policy-fail");
  assert.equal(r.blocking.length, 1);
  assert.equal(r.counts.CRITICAL, 2); // still reported
  assert.match(r.md, /fail on CRITICAL or above, fixed only/);
});

test("pass when nothing reaches the threshold; NONE is report-only", () => {
  const clean = { Results: [{ Vulnerabilities: [{ VulnerabilityID: "CVE-9", PkgName: "x", Severity: "LOW", FixedVersion: "2" }] }] };
  assert.equal(buildReport({ ...base, trivy: clean, threshold: "CRITICAL", ignoreUnfixed: false }).status, "pass");
  const none = buildReport({ ...base, threshold: "NONE", ignoreUnfixed: false });
  assert.equal(none.status, "pass");
  assert.match(none.md, /\* Policy: report only/);
});

test("bad threshold is rejected", () => {
  assert.throws(() => buildReport({ ...base, threshold: "SEVERE", ignoreUnfixed: false }), /severity-threshold must be one of/);
});

test("repoOf strips tag/digest, keeps registry ports", () => {
  assert.equal(repoOf("ghcr.io/o/r/svc:main"), "ghcr.io/o/r/svc");
  assert.equal(repoOf("ghcr.io/o/r/svc@sha256:abc"), "ghcr.io/o/r/svc");
  assert.equal(repoOf("localhost:5000/svc:1"), "localhost:5000/svc");
  assert.equal(repoOf("localhost:5000/svc"), "localhost:5000/svc");
});

import { declaresOs, mergeResults } from "./os.ts";
test("OS: detects an SBOM that declares the OS; merges OS results", () => {
  assert.equal(declaresOs({ packages: [{ primaryPackagePurpose: "OPERATING-SYSTEM" }] }), true);
  assert.equal(declaresOs(sbom), false);
  const m = mergeResults({ Results: [{ Class: "lang-pkgs", Vulnerabilities: [] }] }, { Results: [{ Class: "os-pkgs", Vulnerabilities: [{}] }] });
  assert.equal(m.Results?.length, 2);
  assert.equal(m.Results?.[1].Class, "os-pkgs");
});
