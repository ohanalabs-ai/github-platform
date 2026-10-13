// 🌐 tailnet join — the run summary (owner rule 2026-10-13: every workflow publishes what it did, on
// every outcome). Reads `tailscale status --json` when the CLI is there; never prints a key.
// env: JOIN_OUTCOME (the join step's outcome), CLIENT_ID, TAGS
export interface JoinFacts { outcome: string; clientId?: string; tags?: string; hostname?: string; ips?: string[]; tailnet?: string; online?: boolean }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function factsFromStatus(outcome: string, clientId: string, tags: string, status: any): JoinFacts {
  const self = status?.Self || {};
  return {
    outcome, clientId, tags,
    hostname: self.HostName || self.DNSName || undefined,
    ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : undefined,
    tailnet: status?.CurrentTailnet?.Name || undefined,
    online: typeof self.Online === "boolean" ? self.Online : undefined,
  };
}

export function joinSummaryMarkdown(f: JoinFacts): string {
  const ok = f.outcome === "success";
  const rows: [string, string][] = [["Outcome", ok ? "✅ joined" : f.outcome === "skipped" ? "⏭️ skipped" : `❌ ${f.outcome || "failed"}`]];
  if (f.clientId) rows.push(["Federated identity", `\`${f.clientId}\` (OIDC token exchange — no secret)`]);
  if (f.tags) rows.push(["Tags", f.tags.split(",").map((t) => `\`${t.trim()}\``).join(", ")]);
  if (f.tailnet) rows.push(["Tailnet", f.tailnet]);
  if (f.hostname) rows.push(["Node", f.hostname]);
  if (f.ips?.length) rows.push(["Tailnet IPs", f.ips.join(", ")]);
  if (f.online !== undefined) rows.push(["Online", f.online ? "yes" : "no"]);
  if (!ok && f.outcome !== "skipped") rows.push(["Hint", "403 at the token exchange = the identity's subject/claims don't match this run (immutable OIDC subject? branch ref?); flag errors = duplicate `--accept-routes` (v4 adds it)"]);
  return ["## 🌐 tailnet join", "", "| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`), ""].join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function run({ core, exec }: { core: any; exec: any }): Promise<void> {
  const env = process.env;
  let status: unknown = null;
  try {
    const r = await exec.getExecOutput("tailscale", ["status", "--json"], { silent: true, ignoreReturnCode: true });
    if (r.exitCode === 0) status = JSON.parse(r.stdout);
  } catch { /* CLI absent (the join never installed it) — summarize the outcome alone */ }
  await core.summary.addRaw(joinSummaryMarkdown(factsFromStatus(env.JOIN_OUTCOME || "", env.CLIENT_ID || "", env.TAGS || "", status)), true).write();
}
