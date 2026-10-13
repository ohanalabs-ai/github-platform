import { test } from "node:test";
import assert from "node:assert/strict";
import { factsFromStatus, joinSummaryMarkdown } from "./summary.ts";

test("joined: node, tags, tailnet, IPs from tailscale status", () => {
  const f = factsFromStatus("success", "TeZ-k1", "tag:ci", { Self: { HostName: "gha-123", TailscaleIPs: ["100.64.0.9"], Online: true }, CurrentTailnet: { Name: "example.ts.net" } });
  const md = joinSummaryMarkdown(f);
  assert.match(md, /✅ joined/);
  assert.match(md, /`TeZ-k1` \(OIDC token exchange — no secret\)/);
  assert.match(md, /`tag:ci`/);
  assert.match(md, /gha-123/);
  assert.match(md, /100\.64\.0\.9/);
  assert.match(md, /example\.ts\.net/);
});

test("failed and skipped joins still summarize", () => {
  assert.match(joinSummaryMarkdown(factsFromStatus("failure", "TeZ-k1", "tag:ci", null)), /❌ failure[\s\S]*Hint/);
  const skipped = joinSummaryMarkdown(factsFromStatus("skipped", "", "", null));
  assert.match(skipped, /⏭️ skipped/);
  assert.doesNotMatch(skipped, /Hint/);
});
