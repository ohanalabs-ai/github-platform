import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isPureCaller, referencedActionDirs } from "./lint.ts";

const none = () => false;

test("direct summaries pass", () => {
  assert.equal(classify("a.yaml", 'run: echo "x" >> "$GITHUB_STEP_SUMMARY"', {}, none).ok, true);
  assert.equal(classify("b.yaml", "await core.summary.addRaw(md).write()", {}, none).ok, true);
});

test("a summarizing local action or TS helper passes", () => {
  const text = "uses: ./.vionix-cicd/actions/network/tailscale/join\n";
  assert.deepEqual(referencedActionDirs(text), ["actions/network/tailscale/join"]);
  assert.match(classify("c.yaml", text, {}, (d) => d === "actions/network/tailscale/join").how, /via actions\/network\/tailscale\/join/);
  const ts = "await import(`${process.env.GITHUB_WORKSPACE}/.helpers/actions/docker/image-security/report.ts`)";
  assert.deepEqual(referencedActionDirs(ts), ["actions/docker/image-security"]);
});

test("pure callers pass, mixed jobs do not", () => {
  const caller = { jobs: { a: { uses: "ohanalabs-ai/github-platform/.github/workflows/x.yaml@main" }, b: { uses: "./.github/workflows/y.yml" } } };
  assert.equal(isPureCaller(caller), true);
  assert.equal(classify("d.yaml", "", caller, none).ok, true);
  assert.equal(isPureCaller({ jobs: { a: { uses: "o/r/.github/workflows/x.yaml@main" }, b: { "runs-on": "ubuntu-latest", steps: [] } } }), false);
  assert.equal(isPureCaller({}), false);
});

test("anything else fails unless allowlisted with a reason", () => {
  const v = classify("e.yaml", "steps:\n  - run: echo hi", { jobs: { a: { steps: [] } } }, none);
  assert.equal(v.ok, false);
  assert.match(v.how, /no run summary/);
  assert.match(classify("e.yaml", "", { jobs: { a: {} } }, none, { "e.yaml": "TODO: x" }).how, /ALLOWLISTED \(TODO\): TODO: x/);
});
