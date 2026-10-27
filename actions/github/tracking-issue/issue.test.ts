import { test } from "node:test";
import assert from "node:assert/strict";
import { commentBody, decide, issueBody, marker, normalizeOutcome, renderSummary } from "./issue.ts";
import type { Issue } from "./issue.ts";

const iss = (n: number, key: string, state = "open", extra: Partial<Issue> = {}): Issue => ({
  number: n, state, title: `t${n}`, body: `${marker(key)}\nbody`, html_url: `https://github.com/o/r/issues/${n}`, ...extra,
});

test("a failure with no open issue opens one", () => {
  assert.deepEqual(decide([], "nightly", "failure", true), { action: "create" });
  assert.deepEqual(decide([iss(3, "nightly", "closed")], "nightly", "failure", true), { action: "create" });
});

test("a failure with an open issue comments on it (no second issue)", () => {
  assert.deepEqual(decide([iss(7, "other"), iss(8, "nightly")], "nightly", "failure", true), { action: "comment", number: 8 });
});

test("a green run closes the open issue, or comments when close-on-success is off", () => {
  assert.deepEqual(decide([iss(8, "nightly")], "nightly", "success", true), { action: "close", number: 8 });
  assert.deepEqual(decide([iss(8, "nightly")], "nightly", "success", false), { action: "comment", number: 8 });
  assert.equal(decide([], "nightly", "success", true).action, "none");
});

test("cancelled / skipped / empty outcomes never touch issues", () => {
  for (const o of ["cancelled", "skipped", ""]) assert.equal(decide([iss(8, "nightly")], "nightly", o, true).action, "none");
});

test("pull requests and other keys are ignored", () => {
  assert.deepEqual(decide([iss(9, "nightly", "open", { pull_request: {} })], "nightly", "failure", true), { action: "create" });
});

test("outcome normalisation and bodies", () => {
  assert.equal(normalizeOutcome(" Success "), "success");
  assert.equal(normalizeOutcome("FAILURE"), "failure");
  assert.equal(normalizeOutcome("cancelled"), "other");
  assert.ok(issueBody("k", "x", "https://run").startsWith(marker("k")));
  assert.match(commentBody("success", "x", "https://run"), /Green again/);
  assert.match(commentBody("failure", "table", "https://run"), /Still failing[\s\S]*table/);
  assert.match(renderSummary("t", "failure", { action: "create" }, "https://u"), /opened https:\/\/u/);
});
