import { test } from "node:test";
import assert from "node:assert/strict";
import { latest, verdict, timeoutMessage, type CommitStatus } from "./deploy-status.ts";

const C = "preview/deployed";
const s = (state: string, at: string, extra: Partial<CommitStatus> = {}): CommitStatus => ({ context: C, state, updated_at: at, ...extra });

test("latest: newest status of the context wins, other contexts ignored", () => {
  const list = [s("pending", "2026-11-21T10:00:00Z"), s("success", "2026-11-21T10:05:00Z"), { context: "ci/x", state: "failure", updated_at: "2026-11-21T11:00:00Z" }];
  assert.equal(latest(list, C)?.state, "success");
  assert.equal(latest(list, "nope"), undefined);
});

test("verdict: success → deployed with the target URL", () => {
  const v = verdict([s("success", "2026-11-21T10:05:00Z", { target_url: "https://landing-pr9.platform.planeo.dev", description: "ok" })], C);
  assert.deepEqual(v, { kind: "deployed", url: "https://landing-pr9.platform.planeo.dev", description: "ok" });
});

test("verdict: absent, pending and failure all keep waiting (Argo CD retries a failed sync)", () => {
  assert.equal(verdict([], C).kind, "waiting");
  assert.equal((verdict([], C) as { state: string }).state, "absent");
  assert.equal(verdict([s("pending", "2026-11-21T10:00:00Z")], C).kind, "waiting");
  const f = verdict([s("failure", "2026-11-21T10:00:00Z", { description: "health Degraded" })], C);
  assert.equal(f.kind, "waiting");
  assert.equal((f as { state: string }).state, "failure");
});

test("verdict: a later failure overrides an earlier success (the newest is the truth)", () => {
  const v = verdict([s("success", "2026-11-21T10:00:00Z"), s("failure", "2026-11-21T10:09:00Z")], C);
  assert.equal(v.kind, "waiting");
});

test("timeoutMessage: names the context, the minutes, the last state and the Argo CD app", () => {
  const m = timeoutMessage(C, 20, { kind: "waiting", state: "failure", description: "sync Failed", url: "https://argocd.x/applications/argocd/landing-pr-9" }, "landing-pr-9");
  assert.match(m, /preview\/deployed/);
  assert.match(m, /20 min/);
  assert.match(m, /failure — sync Failed/);
  assert.match(m, /Argo CD Application landing-pr-9/);
  assert.match(m, /https:\/\/argocd\.x\/applications\/argocd\/landing-pr-9/);
});
