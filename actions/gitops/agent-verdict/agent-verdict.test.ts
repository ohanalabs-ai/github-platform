import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decide, buildGate, renderAgentMarkdown, readGroups, SCHEMA } from "./agent-verdict.ts";
import type { GroupJson } from "./agent-verdict.ts";

const META = { title: "Rekorda", mode: "diff", repository: "ohanalabs-ai/k8s-infra", pr: 18, sha: "abc1234", run_url: "https://github.com/ohanalabs-ai/k8s-infra/actions/runs/1" };
const ok = { render: "ok", path: "apps/neo4j/overlays/rekorda-prd" };

test("decision mapping — every documented live status", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ render: "failed", act_status: "—" }, "fix-render"],
    [{ ...ok, act_status: "error" }, "fix-live-error"],
    [{ ...ok, act_status: "refresh-failed" }, "fix-live-error"],
    [{ ...ok, act_status: "validate-failed" }, "fix-live-error"],
    [{ ...ok, act_status: "noop" }, "blocked-noop"],
    [{ ...ok, act_status: "new", new: true, kinds: 4 }, "review-new-app"],
    [{ ...ok, act_status: "diff", added: 1 }, "merge-ok"],
    [{ ...ok, act_status: "noop-live-equal" }, "merge-ok"],
    [{ ...ok, act_status: "noop-expected" }, "merge-ok"],
    [{ ...ok, act_status: "noop-prune-nothing" }, "merge-ok"],
    [{ ...ok, act_status: "noop-allowed" }, "merge-ok"],
    [{ ...ok, act_status: "meta" }, "merge-ok"],
    [{ ...ok, act_status: "validated" }, "live-ok"],
    [{ ...ok, act_status: "skipped-no-argocd" }, "merge-ok-render-only"],
    [{ ...ok, act_status: "skipped-no-tailnet" }, "merge-ok-render-only"],
    [{ ...ok, act_status: "render-only" }, "merge-ok-render-only"],
    [{ ...ok, act_status: "build-only" }, "merge-ok-render-only"],
    [{ render: "external", act_status: "external" }, "merge-ok-render-only"],
    [{ ...ok, act_status: "—" }, "merge-ok-render-only"],
    [{ ...ok, act_status: "something-new" }, "needs-human"],
  ];
  for (const [u, want] of cases) assert.equal(decide({ app: "a", ...u }).decision, want, JSON.stringify(u));
});

test("render failure wins over any live status", () => {
  assert.equal(decide({ app: "a", render: "failed", act_status: "diff" }).decision, "fix-render");
});

const group = (units: GroupJson["units"]): GroupJson => ({ cluster: "rekorda-prd", group: "rekorda", mode: "diff", units });

test("verdict: pass, with the human-merge next action", () => {
  const g = buildGate([group([{ app: "rekorda-prd-neo4j", ...ok, act_status: "diff", changed: 1 }])], { rekorda: { result: "success" } }, META);
  assert.equal(g.schema, SCHEMA);
  assert.equal(g.verdict, "pass");
  assert.deepEqual(g.not_verified, []);
  assert.match(g.next_actions.join("\n"), /agents never merge/);
  assert.equal(g.units[0].cluster, "rekorda-prd");
});

test("verdict: no-change when no group has units", () => {
  const g = buildGate([group([])], { rekorda: { result: "success" } }, META);
  assert.equal(g.verdict, "no-change");
});

test("verdict: blocked by a blocking unit; failed by a failed/cancelled group (failed wins)", () => {
  const units = [{ app: "x", ...ok, act_status: "noop" }];
  assert.equal(buildGate([group(units)], { rekorda: { result: "success" } }, META).verdict, "blocked");
  assert.equal(buildGate([group(units)], { rekorda: { result: "failure" } }, META).verdict, "failed");
  assert.equal(buildGate([group([])], { rekorda: { result: "cancelled" } }, META).verdict, "failed");
  const nh = buildGate([group([{ app: "y", ...ok, act_status: "weird" }])], { rekorda: { result: "success" } }, META);
  assert.equal(nh.verdict, "blocked");
  assert.match(nh.next_actions.join("\n"), /do not guess/);
});

test("render-only units pass but land in not_verified and the next action says so", () => {
  const g = buildGate([group([{ app: "rekorda-prd-graphiti", ...ok, act_status: "skipped-no-tailnet" }])], { rekorda: { result: "success" } }, META);
  assert.equal(g.verdict, "pass");
  assert.equal(g.not_verified.length, 1);
  assert.match(g.not_verified[0], /live argocd diff not run for rekorda-prd-graphiti .*skipped-no-tailnet/);
  assert.match(g.next_actions.join("\n"), /1 unit\(s\) NOT live-verified/);
});

test("markdown: summary section, collapsed comment, JSON embedded, pipes escaped", () => {
  const g = buildGate([group([{ app: "a", render: "failed", path: "p|q" }])], { rekorda: { result: "failure" } }, META);
  const md = renderAgentMarkdown(g);
  assert.match(md, /## 🤖 Agent decision — gitops-gate\/v1/);
  assert.match(md, /Verdict: ❌ `failed`/);
  assert.match(md, /"schema": "planeo.dev\/gitops-gate\/v1"/);
  assert.match(md, /p\\\|q/);
  assert.match(renderAgentMarkdown(g, true), /^<details><summary>🤖 Agent decision/);
});

test("readGroups walks nested artifact dirs and skips broken JSON", () => {
  const d = mkdtempSync(join(tmpdir(), "agent-verdict-"));
  try {
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "group-rekorda-prd-rekorda.json"), JSON.stringify(group([{ app: "a", ...ok, act_status: "diff" }])));
    writeFileSync(join(d, "group-broken.json"), "{");
    writeFileSync(join(d, "other.json"), "{}");
    const gs = readGroups(d);
    assert.equal(gs.length, 1);
    assert.equal(gs[0].units[0].app, "a");
    assert.deepEqual(readGroups(join(d, "missing")), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("skipped-check-failed blocks as fix-check (the live diff never ran)", () => {
  const d = decide({ app: "a", render: "ok", act_status: "skipped-check-failed" } as Parameters<typeof decide>[0]);
  assert.equal(d.decision, "fix-check");
});
