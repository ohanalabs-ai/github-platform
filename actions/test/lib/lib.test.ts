import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, descendants, numAttr, parseXml } from "./xml.ts";
import { cell, clip, fenced, formatDuration, listInput, percent, slug } from "./markdown.ts";
import { commentMarker, expandPatterns, stickyComment } from "./github.ts";

test("xml: prolog, comment, DOCTYPE with internal subset, CDATA, self-closing, entities", () => {
  const x = parseXml(`﻿<?xml version="1.0"?>
<!DOCTYPE r [ <!ELEMENT r ANY> ]>
<!-- c -->
<r a='1' b="x &amp; &lt;y&gt; &#34;q&#34;&#xA;n"><k/><k v="2">t<![CDATA[<raw> & ]]>u</k></r>`);
  assert.equal(x.name, "r");
  assert.equal(x.attrs.a, "1");
  assert.equal(x.attrs.b, 'x & <y> "q"\nn');
  assert.equal(x.children.length, 2);
  assert.equal(x.children[1].text, "t<raw> & u");
  assert.equal(numAttr(x.children[1], "v"), 2);
  assert.ok(Number.isNaN(numAttr(x.children[0], "v")));
});

test("xml: literal newlines in attributes normalise to spaces; numeric entities stay", () => {
  assert.equal(parseXml(`<a m="one\ntwo&#10;three"/>`).attrs.m, "one two\nthree");
  assert.equal(decodeEntities("&unknown; &#0; &#x1F600;"), "&unknown; &#0; 😀");
});

test("xml: namespaced names and descendants in document order", () => {
  const x = parseXml(`<ns:a><b n="1"><b n="2"/></b><c><b n="3"/></c></ns:a>`);
  assert.deepEqual(descendants(x, "b").map((b) => b.attrs.n), ["1", "2", "3"]);
});

test("xml: malformed input throws with a position", () => {
  assert.throws(() => parseXml("<a><b></a>"), /unexpected <\/a>/);
  assert.throws(() => parseXml("<a>"), /unclosed <a>/);
  assert.throws(() => parseXml("just text"), /no root element/);
  assert.throws(() => parseXml("<a x=1/>"), /unquoted attribute/);
});

test("markdown: cell escapes pipes, html and newlines", () => {
  assert.equal(cell("a|b <script>\nc & d"), "a\\|b &lt;script&gt; c &amp; d");
});

test("markdown: fence is longer than any backtick run in the body", () => {
  assert.equal(fenced("x ``` y"), "````text\nx ``` y\n````");
  assert.equal(fenced("plain", "shell"), "```shell\nplain\n```");
});

test("markdown: durations, percents, clip, lists, slugs", () => {
  assert.equal(formatDuration(0.138295), "0.14s");
  assert.equal(formatDuration(10.29), "10.3s");
  assert.equal(formatDuration(65), "1m 5s");
  assert.equal(formatDuration(3725), "1h 2m 5s");
  assert.equal(formatDuration(NaN), "0s");
  assert.equal(percent(0.8312), "83.12%");
  assert.equal(percent(0.8), "80%");
  assert.equal(percent(null), "—");
  assert.match(clip("a\n".repeat(100), 50), /… \(truncated\)$/);
  assert.deepEqual(listInput("a, b\n# c\n\nd"), ["a", "b", "d"]);
  assert.equal(slug("✅ Test results"), "test-results");
  assert.equal(slug("☂️"), "report");
});

test("github: directories expand per extension, globs and negations pass through", () => {
  const isDir = (p: string) => p === "reports" || p === "reports/";
  assert.deepEqual(expandPatterns(["reports/", "x/**/*.xml", "!reports/skip.xml"], isDir, ["xml", "tap"]),
    ["reports/**/*.xml", "reports/**/*.tap", "x/**/*.xml", "!reports/skip.xml"]);
});

test("github: sticky comment deletes the previous marker comment and posts a fresh one", async () => {
  const calls: string[] = [];
  const github = {
    paginate: async () => [{ id: 1, body: `${commentMarker("k")}\nold` }, { id: 2, body: "someone else" }],
    rest: { issues: {
      listComments: () => undefined,
      deleteComment: async ({ comment_id }: { comment_id: number }) => { calls.push(`delete ${comment_id}`); },
      createComment: async ({ body }: { body: string }) => { calls.push(`create ${body.split("\n")[1]}`); return { data: { html_url: "u" } }; },
    } },
  };
  const context = { repo: { owner: "o", repo: "r" }, payload: { pull_request: { number: 7 } } };
  const r = await stickyComment({ core: {}, github, context, glob: {} }, "k", "new");
  assert.deepEqual(calls, ["delete 1", "create new"]);
  assert.equal(r.ok, true);
});

test("github: a 403 degrades to a not-ok result; push events skip the comment", async () => {
  const github = { paginate: async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); }, rest: { issues: {} } };
  const pr = await stickyComment({ core: {}, github, context: { repo: { owner: "o", repo: "r" }, payload: { pull_request: { number: 1 } } }, glob: {} }, "k", "b");
  assert.equal(pr.ok, false);
  assert.match(pr.detail, /HTTP 403.*pull-requests: write/);
  const push = await stickyComment({ core: {}, github, context: { repo: { owner: "o", repo: "r" }, payload: {} }, glob: {} }, "k", "b");
  assert.match(push.detail, /not a pull_request event/);
});
