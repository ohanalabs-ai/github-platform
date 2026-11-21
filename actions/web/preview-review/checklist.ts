// Pure logic of the visual-review checklist (no I/O, unit-tested in checklist.test.ts):
// the caller's rules file maps changed-file globs to "what to verify visually"; generic items always apply.
//
// Rules file (JSON, in the CALLER repo, e.g. .github/preview-checklist.json):
//   { "title": "…", "rules": [ { "name": "Film", "globs": ["public/film/**"], "items": ["hero loop plays", …] } ],
//     "generic": ["mobile / iOS Safari", …] }

export interface Rule { name: string; globs: string[]; items: string[] }
export interface Rules { title?: string; rules: Rule[]; generic?: string[] }
export interface Section { name: string; items: string[]; files: string[] }

// Minimal glob → RegExp: `**` any depth (incl. none), `*` within one segment, `?` one char. Anchored, `/`-separated.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function parseRules(text: string): Rules {
  const r = JSON.parse(text) as Rules;
  if (!r || !Array.isArray(r.rules)) throw new Error("rules file: `rules` must be an array");
  for (const rule of r.rules) {
    if (!rule.name || !Array.isArray(rule.globs) || !Array.isArray(rule.items)) throw new Error(`rules file: rule ${JSON.stringify(rule.name)} needs name, globs[], items[]`);
  }
  return r;
}

// Every rule whose globs match at least one changed file, in rule order, with the matching files (for the reviewer's context).
export function sections(rules: Rules, changed: string[]): Section[] {
  const out: Section[] = [];
  for (const rule of rules.rules) {
    const res = rule.globs.map(globToRegExp);
    const files = changed.filter((f) => res.some((re) => re.test(f)));
    if (files.length) out.push({ name: rule.name, items: rule.items, files });
  }
  return out;
}

export interface Facts { url: string; image: string; headSha: string; environment: string; ready: string; changedCount: number }

const MAX_FILES = 8;

export function render(rules: Rules, secs: Section[], f: Facts): string {
  const l: string[] = [];
  l.push(`## 👀 ${rules.title || "Visual review of the preview"}`, "");
  l.push(`**Preview:** ${f.url}`, "");
  l.push("| | |", "|---|---|");
  l.push(`| Image | \`${f.image}\` |`);
  l.push(`| Head SHA | \`${f.headSha}\` |`);
  l.push(`| Status | ${f.ready} |`);
  l.push(`| Approve in | Environment \`${f.environment}\` (job **👀 visual review**): approving = a visual LGTM of this preview |`, "");
  if (secs.length) {
    l.push("### What this PR changes — verify", "");
    for (const s of secs) {
      const shown = s.files.slice(0, MAX_FILES).map((x) => `\`${x}\``).join(", ");
      const more = s.files.length > MAX_FILES ? ` and ${s.files.length - MAX_FILES} more` : "";
      l.push(`**${s.name}** (${shown}${more})`, "");
      for (const it of s.items) l.push(`- [ ] ${it}`);
      l.push("");
    }
  } else {
    l.push(`### What this PR changes`, "", `No checklist rule matches the ${f.changedCount} changed file(s): a quick look at the page is enough.`, "");
  }
  if (rules.generic?.length) {
    l.push("### Always", "");
    for (const it of rules.generic) l.push(`- [ ] ${it}`);
    l.push("");
  }
  return l.join("\n");
}
