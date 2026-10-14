import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidates, combine, compareSemver, decideIssue, evaluateEntry, fill, issueBody, issueTitle, marker,
  renderSummary, validateList, versionFromTag,
} from "./watch.ts";
import type { EntryResult, Release, WatchEntry, WatchList } from "./types.ts";

const rel = (tag: string, extra: Partial<Release> = {}): Release => ({
  tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, prerelease: false, draft: false, body: "", ...extra,
});
const noFiles = async () => null;

test("versionFromTag extracts semver from prefixed tags", () => {
  assert.equal(versionFromTag("v1.20.2"), "1.20.2");
  assert.equal(versionFromTag("argo-cd-10.10.3"), "10.10.3");
  assert.equal(versionFromTag("helm-chart-2.12.0"), "2.12.0");
  assert.equal(versionFromTag("v1.0.0-alpha13"), "1.0.0-alpha13");
  assert.equal(versionFromTag("v3.6"), "3.6.0");
  assert.equal(versionFromTag("nightly"), "");
});

test("compareSemver orders releases and pre-releases", () => {
  assert.equal(compareSemver("1.21.2", "1.20.4"), 1);
  assert.equal(compareSemver("1.0.0-alpha13", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-alpha13", "1.0.0-alpha9"), 1);
  assert.equal(compareSemver("v3.6.0", "3.6.0"), 0);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0-beta.2"), 1);
});

test("candidates: GA only, semver suffix counts as pre-release, newest semver first, tag filter", () => {
  const rs = [
    rel("v1.20.4"), rel("v1.21.2"), rel("v1.22.0-beta.0", { prerelease: true }),
    rel("v1.0.0-alpha13"), // kagent: not flagged prerelease on GitHub, still a pre-release
    rel("v9.9.9", { draft: true }), rel("helm-chart-2.12.0"),
  ];
  assert.deepEqual(candidates(rs, { tagPattern: "^v\\d" }).map((c) => c.version), ["1.21.2", "1.20.4"]);
  assert.deepEqual(candidates(rs, { tagPattern: "^v\\d", includePrerelease: true }).map((c) => c.version), ["1.22.0-beta.0", "1.21.2", "1.20.4", "1.0.0-alpha13"]);
});

test("fill substitutes placeholders, regex-escaped when asked", () => {
  const vars = { version: "2.12.0", minor: "2.12", tag: "v2.12.0", target: "1.37", name: "eso" };
  assert.equal(fill("^\\|\\s*{minor}\\s*\\|.*{target}", vars, true), "^\\|\\s*2\\.12\\s*\\|.*1\\.37");
  assert.equal(fill("{tag}", vars, false), "v2.12.0");
});

test("minVersion: waiting below, met at/above, only releases newer than current", async () => {
  const e: WatchEntry = { name: "cert-manager", repo: "cert-manager/cert-manager", current: "v1.21.0", conditions: [{ minVersion: "1.22.0" }] };
  const waiting = await evaluateEntry(e, [rel("v1.21.2"), rel("v1.20.4")], "1.37", noFiles);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.latest, "1.21.2");
  const met = await evaluateEntry(e, [rel("v1.21.2"), rel("v1.22.0")], "1.37", noFiles);
  assert.equal(met.status, "met");
  assert.equal(met.metVersion, "1.22.0");
});

test("notesMatch is case-insensitive multiline regex on the body", async () => {
  const e: WatchEntry = { name: "x", repo: "o/r", conditions: [{ notesMatch: "kubernetes {target}" }] };
  const r = await evaluateEntry(e, [rel("v2.0.0", { body: "Adds support for\nKubernetes 1.37 (GA)" })], "1.37", noFiles);
  assert.equal(r.status, "met");
  const r2 = await evaluateEntry(e, [rel("v2.0.0", { body: "Kubernetes 1.36" })], "1.37", noFiles);
  assert.equal(r2.status, "waiting");
});

test("fileMatch fetches at the release tag with placeholders; missing file is not met", async () => {
  const seen: string[] = [];
  const files: Record<string, string> = {
    "external-secrets/external-secrets@v2.13.0:docs/s.md": "| 2.13 | 1.36-1.37 | Nov |\n| 2.12 | 1.36 | Oct |",
    "external-secrets/external-secrets@v2.12.0:docs/s.md": "| 2.12 | 1.36 | Oct |",
  };
  const fetchFile = async (repo: string, ref: string, path: string) => { seen.push(`${repo}@${ref}:${path}`); return files[`${repo}@${ref}:${path}`] ?? null; };
  const e: WatchEntry = {
    name: "external-secrets", repo: "external-secrets/external-secrets", current: "2.7.0", tagPattern: "^v\\d",
    conditions: [{ fileMatch: { path: "docs/s.md", pattern: "^\\|\\s*{minor}\\s*\\|[^|\\n]*{target}" } }],
  };
  const waiting = await evaluateEntry(e, [rel("v2.12.0"), rel("helm-chart-2.12.0")], "1.37", fetchFile);
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(seen, ["external-secrets/external-secrets@v2.12.0:docs/s.md"]);
  const met = await evaluateEntry(e, [rel("v2.12.0"), rel("v2.13.0")], "1.37", fetchFile);
  assert.equal(met.status, "met");
  assert.equal(met.metVersion, "2.13.0");
  const missing = await evaluateEntry({ ...e, conditions: [{ fileMatch: { path: "nope.md", pattern: "x" } }] }, [rel("v2.12.0")], "1.37", fetchFile);
  assert.match(missing.conditions[0].detail, /not found/);
});

test("fileMatch with an explicit repo + ref (e.g. a website repo's branch)", async () => {
  const fetchFile = async (repo: string, ref: string) => (repo === "cert-manager/website" && ref === "master" ? "| 1.22 | 1.33 → 1.37 |" : null);
  const e: WatchEntry = { name: "cm", repo: "cert-manager/cert-manager", conditions: [{ fileMatch: { repo: "cert-manager/website", ref: "master", path: "x", pattern: "{minor}.*{target}" } }] };
  assert.equal((await evaluateEntry(e, [rel("v1.22.0")], "1.37", fetchFile)).status, "met");
});

test("match any vs all", () => {
  const rs = [{ kind: "minVersion" as const, met: true, detail: "" }, { kind: "fileMatch" as const, met: false, detail: "" }];
  assert.equal(combine(rs, "all"), false);
  assert.equal(combine(rs, "any"), true);
  assert.equal(combine([], "any"), false);
});

test("no GA release → waiting with a reason", async () => {
  const r = await evaluateEntry({ name: "kagent", repo: "kagent-dev/kagent", conditions: [{ minVersion: "1.0.0" }] }, [rel("v1.0.0-alpha13")], "1.37", noFiles);
  assert.equal(r.status, "waiting");
  assert.equal(r.latest, "");
});

test("validateList rejects malformed lists", () => {
  assert.throws(() => validateList({}), /entries/);
  assert.throws(() => validateList({ entries: [{ name: "a", repo: "bad", conditions: [{ minVersion: "1.0.0" }] }] }), /owner\/name/);
  assert.throws(() => validateList({ entries: [{ name: "a", repo: "o/r", conditions: [{ minVersion: "1.0.0", notesMatch: "x" }] }] }), /exactly one/);
  assert.throws(() => validateList({ entries: [{ name: "a", repo: "o/r", conditions: [{ minVersion: "x" }] }] }), /semver/);
  assert.throws(() => validateList({ entries: [{ name: "a", repo: "o/r", conditions: [{ minVersion: "1.0.0" }] }, { name: "a", repo: "o/r", conditions: [{ minVersion: "1.0.0" }] }] }), /duplicate/);
  const ok = validateList({ target: "1.37", entries: [{ name: "a", repo: "o/r", current: 1.2, conditions: [{ minVersion: "1.0.0" }] }] });
  assert.equal(ok.entries[0].current, "1.2");
});

const metResult: EntryResult = {
  name: "argo-cd", repo: "argoproj/argo-cd", current: "v3.4.5", latest: "3.6.0", latestUrl: "u", status: "met",
  metVersion: "3.6.0", metUrl: "u", conditions: [{ kind: "minVersion", met: true, detail: "3.6.0 ≥ 3.6.0" }], note: "", error: "",
};
const list: WatchList = { target: "1.37", label: "eks-1.37", titleTemplate: "R1 unblocked: {name} {version} supports Kubernetes {target}", entries: [] };

test("issue title/body: templated, carries the marker, stable across runs", () => {
  assert.equal(issueTitle(metResult, list), "R1 unblocked: argo-cd 3.6.0 supports Kubernetes 1.37");
  const b = issueBody(metResult, list);
  assert.ok(b.startsWith(marker("argo-cd")));
  assert.equal(b, issueBody(metResult, list));
});

test("decideIssue: create, update open, skip unchanged, never reopen closed", () => {
  const title = issueTitle(metResult, list), body = issueBody(metResult, list);
  assert.deepEqual(decideIssue([], "argo-cd", title, body), { action: "create" });
  const open = { number: 7, state: "open", title: "old", body: `${marker("argo-cd")}\nold`, html_url: "" };
  assert.deepEqual(decideIssue([open], "argo-cd", title, body), { action: "update", number: 7 });
  assert.equal(decideIssue([{ ...open, title, body }], "argo-cd", title, body).action, "skip");
  const closed = { ...open, state: "closed" };
  assert.deepEqual(decideIssue([closed], "argo-cd", title, body), { action: "skip", number: 7, reason: "closed (acknowledged) — not reopened" });
  // another entry's marker does not dedupe this one ("argo-cd" vs "argo-cd-chart")
  assert.deepEqual(decideIssue([{ ...open, body: marker("argo-cd-chart") }], "argo-cd", title, body), { action: "create" });
});

test("renderSummary: one row per entry, counts, escaped pipes", () => {
  const waiting: EntryResult = { ...metResult, name: "eso", status: "waiting", metVersion: "", conditions: [{ kind: "fileMatch", met: false, detail: "x /a|b/" }] };
  const md = renderSummary([metResult, waiting], list, ".github/upstream-watch.yaml");
  assert.match(md, /1 ✅ met/);
  assert.match(md, /1 ⏳ waiting/);
  assert.match(md, /a\\\|b/);
  assert.equal(md.split("\n").filter((l) => l.startsWith("| ✅") || l.startsWith("| ⏳")).length, 2);
});

test("issue title: a per-entry template wins over the list's", () => {
  assert.equal(issueTitle(metResult, list, "R1: {name} chart ships {version}"), "R1: argo-cd chart ships 3.6.0");
});
