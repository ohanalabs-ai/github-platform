// Pure logic of ⏳ preview deployed (deploy-wait.ts): read the GitOps "deployed + verified" commit status on the PR head sha.
// The status is set by the cluster, not by CI — e.g. Argo CD Notifications' `github` service after the preview Application is
// Synced + Healthy on that sha and its PostSync smoke hook passed (planeodev/website docs/design/preview-environments.md §11.2).
// A `failure` is NOT final: Argo CD retries the sync (e.g. the image was still being built), and the next attempt posts again.

export interface CommitStatus {
  context: string;
  state: "pending" | "success" | "failure" | "error" | string;
  description?: string | null;
  target_url?: string | null;
  updated_at?: string;
}

export type Verdict =
  | { kind: "deployed"; url: string; description: string }
  | { kind: "waiting"; state: string; description: string; url: string };

// GitHub's combined status lists the latest status per context; the raw list may hold several — take the newest.
export function latest(statuses: CommitStatus[], context: string): CommitStatus | undefined {
  return statuses
    .filter((s) => s.context === context)
    .sort((a, b) => Date.parse(b.updated_at || "") - Date.parse(a.updated_at || ""))[0];
}

export function verdict(statuses: CommitStatus[], context: string): Verdict {
  const s = latest(statuses, context);
  if (!s) return { kind: "waiting", state: "absent", description: `no "${context}" status yet`, url: "" };
  const description = (s.description || "").trim();
  const url = s.target_url || "";
  if (s.state === "success") return { kind: "deployed", url, description };
  return { kind: "waiting", state: s.state, description, url };
}

export function timeoutMessage(context: string, minutes: number, last: Verdict, app: string): string {
  const where = app ? ` Look at the Argo CD Application ${app}` : " Look at the preview's GitOps Application";
  const seen = last.kind === "waiting" ? `last: ${last.state}${last.description ? ` — ${last.description}` : ""}` : "";
  return `the preview was not deployed + verified ("${context}" success) on this commit within ${minutes} min (${seen}).${where}` +
    `${last.kind === "waiting" && last.url ? ` (${last.url})` : ""}: sync/health, the PostSync smoke Job's log, or an image that never built.`;
}
