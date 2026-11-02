import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSpecPaths, parseMode, safeWorkdir, parseVacuum, parseOasdiff, parsePorcelain, gate, breakingCount,
  renderLint, renderDrift, renderBreaking, renderComment, safeJson, tail, type BreakingResult, type LintResult, type DriftResult,
} from "./lib.ts";

test("spec paths: trimmed, de-duplicated, comments dropped; unsafe paths and empty lists throw", () => {
  assert.deepEqual(parseSpecPaths("  api/a.yaml \n\n# c\napi/b.json\napi/a.yaml\n"), ["api/a.yaml", "api/b.json"]);
  assert.throws(() => parseSpecPaths("/etc/passwd"), /unsafe/);
  assert.throws(() => parseSpecPaths("a/../../b.yaml"), /unsafe/);
  assert.throws(() => parseSpecPaths("a.yaml; rm -rf /"), /unsafe/);
  assert.throws(() => parseSpecPaths("\n \n"), /empty/);
});

test("modes and working directory", () => {
  assert.equal(parseMode(undefined, "m"), "advisory");
  assert.equal(parseMode("enforce", "m"), "enforce");
  assert.throws(() => parseMode("strict", "m"), /advisory or enforce/);
  assert.equal(safeWorkdir(""), ".");
  assert.equal(safeWorkdir("svc/api"), "svc/api");
  assert.throws(() => safeWorkdir("../x"), /inside/);
});

test("vacuum: pass, fail with counts, ANSI stripped, crash without a summary line", () => {
  const pass = parseVacuum("a.yaml", " | ▲ Passed with 0 errors, 3 warnings and 1 informs.\n", 0);
  assert.deepEqual([pass.ok, pass.errors, pass.warnings, pass.infos], [true, 0, 3, 1]);
  const fail = parseVacuum("b.yaml", "\u001b[31m | ✗ Failed with 3 errors, 4 warnings and 0 informs.\u001b[0m\n", 1);
  assert.deepEqual([fail.ok, fail.errors, fail.warnings], [false, 3, 4]);
  const crash = parseVacuum("c.yaml", "panic: cannot read", 2);
  assert.equal(crash.ok, false);
  assert.equal(crash.errors, 1);
  assert.equal(parseVacuum("d.yaml", "Passed with 0 errors, 0 warnings and 0 informs.", 1).ok, false);
});

test("oasdiff: only level 3 is breaking; empty / null output is no change", () => {
  assert.deepEqual(parseOasdiff("[]"), []);
  assert.deepEqual(parseOasdiff("null"), []);
  assert.deepEqual(parseOasdiff(""), []);
  const ch = parseOasdiff('[{"id":"x","text":"added required q","level":3,"operation":"GET","path":"/a"},{"id":"y","text":"n","level":1}]');
  assert.equal(breakingCount([{ path: "a", status: "compared", changes: ch }]), 1);
  assert.throws(() => parseOasdiff("{}"), /array/);
});

test("porcelain: modified, untracked, rename; the helper checkout is ignored", () => {
  const txt = " M gen/api.go\n?? gen/new.go\nR  old.go -> new2.go\n?? .openapi-platform/\n?? .openapi-platform/actions/x.ts\n";
  assert.deepEqual(parsePorcelain(txt), ["gen/api.go", "gen/new.go", "new2.go"]);
  assert.deepEqual(parsePorcelain(""), []);
});

const okLint: LintResult = { specs: [{ path: "a.yaml", ok: true, errors: 0, warnings: 2, infos: 0, detail: "" }], failed: false };
const cleanDrift: DriftResult = { command: "go generate ./...", generateExit: 0, files: [], drift: false };
const brk = (mode: "advisory" | "enforce", breaking: boolean): BreakingResult => ({
  mode, breaking,
  specs: [{ path: "a.yaml", status: "compared", changes: breaking ? [{ id: "new-required-request-parameter", text: "added the new required `q`", level: 3, operation: "GET", path: "/a" }] : [] }],
});

test("gate: lint and drift always block; breaking only in enforce", () => {
  assert.equal(gate(okLint, cleanDrift, brk("advisory", false)).failed, false);
  assert.equal(gate(okLint, cleanDrift, brk("advisory", true)).failed, false);
  assert.equal(gate(okLint, cleanDrift, brk("enforce", true)).breaking, true);
  assert.equal(gate(okLint, cleanDrift, brk("enforce", true)).failed, true);
  assert.equal(gate(okLint, { ...cleanDrift, drift: true, files: ["x"] }, undefined).failed, true);
  assert.equal(gate(okLint, { ...cleanDrift, generateExit: 1 }, undefined).failed, true);
  assert.equal(gate({ ...okLint, failed: true }, cleanDrift, undefined).failed, true);
});

test("markdown: drift lists files; breaking says advisory vs blocking; comment headline", () => {
  const d = renderDrift({ command: "go generate ./...", generateExit: 0, files: ["gen/a.go", "gen/b.go"], drift: true });
  assert.match(d, /drift/);
  assert.match(d, /`gen\/a\.go`/);
  assert.match(renderDrift({ ...cleanDrift, skipped: "generate-command is empty" }), /skipped/);
  assert.match(renderDrift(cleanDrift), /no drift/);
  assert.match(renderBreaking(brk("advisory", true)), /Advisory/);
  assert.match(renderBreaking(brk("enforce", true)), /Blocking/);
  assert.match(renderBreaking({ mode: "advisory", specs: [], breaking: false, skipped: "not a pull request" }), /skipped/);
  assert.match(renderLint(okLint), /✅ pass/);
  const adv = brk("advisory", true);
  assert.match(renderComment("T", okLint, cleanDrift, adv, gate(okLint, cleanDrift, adv)), /passes, with breaking changes/);
  const enf = brk("enforce", true);
  assert.match(renderComment("T", okLint, cleanDrift, enf, gate(okLint, cleanDrift, enf)), /blocked/);
  assert.match(renderComment("T", undefined, undefined, undefined), /did not run/);
});

test("safeJson and tail", () => {
  assert.equal(safeJson("not json"), undefined);
  assert.equal(safeJson(""), undefined);
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.equal(tail("1\n2\n3\n4", 2), "…\n3\n4");
});

test("comment key: stable, safe inside an HTML comment, never empty", async () => {
  const { commentKey } = await import("./lib.ts");
  assert.equal(commentKey(undefined), "openapi");
  assert.equal(commentKey("svc/api|a.yaml\nb.yaml"), "svc/api|a.yaml_b.yaml");
  assert.doesNotMatch(commentKey("x-->y -- z"), /--|>/);
  assert.equal(commentKey("   ").length > 0, true);
});
