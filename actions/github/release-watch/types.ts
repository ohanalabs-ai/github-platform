// Minimal shapes of what actions/github-script injects, plus the watch-list contract. Type-only (erased
// at load time) — no npm dependency on @actions/*; Node 24 strips these annotations natively.
export interface Core {
  info(message: string): void;
  warning(message: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  summary: { addRaw(text: string, addEOL?: boolean): { write(): Promise<unknown> } };
}
export interface Ctx {
  core: Core;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  github: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}

// ── the watch list (YAML or JSON in the CALLER repo) ─────────────────────────────────────────────
// A condition is ONE of these keys. Patterns may use the placeholders {version} {minor} {tag}
// {target} — substituted regex-escaped from the release being evaluated (and the list's target).
export interface FileMatch {
  repo?: string; // default: the entry's repo
  ref?: string; // default: "{tag}" (the release's tag); any branch/tag/sha, placeholders allowed
  path: string;
  pattern: string; // multiline regex (flag m), matched against the file's raw text
}
export interface Condition {
  minVersion?: string; // semver ≥ (the release's version, extracted from its tag)
  notesMatch?: string; // regex (flags im) on the release body
  fileMatch?: FileMatch;
}
export interface WatchEntry {
  name: string;
  repo: string; // owner/name
  current?: string; // the pin we run today (display + "newer than current" filter)
  tagPattern?: string; // regex a tag must match (e.g. ^v\d, ^argo-cd-) — other tags are ignored
  includePrerelease?: boolean; // default false: GitHub's prerelease flag OR a semver pre-release suffix
  match?: "all" | "any"; // how conditions combine (default all)
  conditions: Condition[];
  maxCandidates?: number; // newest GA releases evaluated (default 3)
  note?: string; // free text shown in the summary/issue (stepping stones, gates)
  titleTemplate?: string; // per-entry issue title (default: the list's)
}
export interface WatchList {
  target?: string; // e.g. "1.37" — {target} placeholder + issue title
  label?: string; // issue label (default "upstream-watch")
  titleTemplate?: string; // default "Unblocked: {name} {version} supports Kubernetes {target}"
  entries: WatchEntry[];
}

// ── results ──────────────────────────────────────────────────────────────────────────────────────
export interface Release {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  published_at?: string | null;
}
export interface Candidate {
  tag: string;
  version: string;
  url: string;
  body: string;
  publishedAt: string;
}
export interface ConditionResult {
  kind: "minVersion" | "notesMatch" | "fileMatch";
  met: boolean;
  detail: string;
}
export type Status = "met" | "waiting" | "error";
export interface EntryResult {
  name: string;
  repo: string;
  current: string;
  latest: string; // newest GA version ("" when none)
  latestUrl: string;
  status: Status;
  metVersion: string; // the newest release that satisfies the conditions ("" when none)
  metUrl: string;
  conditions: ConditionResult[]; // for the met release, else for the latest evaluated
  note: string;
  error: string;
  issue?: string; // issue URL + action, when one was opened/updated
}
