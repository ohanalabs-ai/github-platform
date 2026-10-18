// 🧾 Markdown helpers shared by test/junit-report and test/coverage-report (pure, unit-tested).

/** GitHub limits: a PR/issue comment and a check-run summary hold 65 536 chars; a step summary 1 MiB. */
export const COMMENT_LIMIT = 65000;
export const SUMMARY_LIMIT = 1000000;

/** Safe inside a markdown table cell: no pipes, no newlines, no raw HTML from test names. */
export function cell(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** A code fence longer than any backtick run inside `body`, so report text can never close it early. */
export function fenced(body: string, lang = "text"): string {
  const longest = Math.max(0, ...[...String(body).matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${String(body).replace(/\s+$/, "")}\n${f}`;
}

/** 0.138 → "0.14s", 65 → "1m 5s", 3725 → "1h 2m 5s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", r ? `${r}s` : ""].filter(Boolean).join(" ") || "0s";
}

/** 0.8312 → "83.12%"; NaN/undefined → "—". */
export function percent(rate: number | null | undefined, digits = 2): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(digits).replace(/\.?0+$/, "")}%`;
}

/** Cut text to `max` chars on a line boundary when possible. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf("\n", max);
  return `${s.slice(0, cut > max * 0.6 ? cut : max)}\n… (truncated)`;
}

/** Wrap in a <details> block (blank lines keep GitHub rendering the markdown inside). */
export function details(summary: string, body: string, open = false): string {
  return [`<details${open ? " open" : ""}>`, `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
}

/** "a, b\nc" → ["a","b","c"] — newline/comma separated input lists, blanks and #-comments dropped. */
export function listInput(v: string | undefined): string[] {
  return String(v || "").split(/[\n,]/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

export function boolInput(v: string | undefined, dflt = false): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return dflt;
  return s === "true" || s === "yes" || s === "1" || s === "on";
}

/** A stable sticky-comment key from a title: "✅ Test results" → "test-results". */
export function slug(s: string): string {
  return String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
}
