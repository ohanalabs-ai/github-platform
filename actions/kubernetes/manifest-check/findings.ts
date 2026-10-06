// The policy: turn what the checks observed into findings (error · warning · notice) and render the
// report. Pure functions — the self-tests drive them without a network or a cluster.
import { isFloatingTag, parseImageRef } from "./imageref.ts";
import type { ImageResult } from "./registry.ts";

export type Level = "error" | "warning" | "notice";
export type Check = "build" | "schema" | "deprecated-api" | "image";
export interface Finding { level: Level; check: Check; unit: string; subject: string; message: string }

export interface Policy {
  requireDigest: boolean; // tag-only references are errors (default: notice)
  failOnUnverifiable: boolean; // an image the profile cannot see is an error (default: warning)
  failOnFloating: boolean; // :latest/:main… are errors (default: warning)
}

export interface KubeconformResource { filename?: string; kind?: string; name?: string; version?: string; status?: string; msg?: string }

export function schemaFindings(unit: string, resources: KubeconformResource[]): Finding[] {
  return resources
    .filter((r) => r.status === "statusInvalid" || r.status === "statusError")
    .map((r) => ({
      level: "error" as Level,
      check: "schema" as Check,
      unit,
      subject: `${r.kind || "?"} ${r.name || "?"} (${r.version || "?"})`,
      message: (r.msg || r.status || "").replace(/\s+/g, " ").trim(),
    }));
}

export function imageFindings(image: string, units: string[], res: ImageResult | undefined, policy: Policy, platforms: string[]): Finding[] {
  const out: Finding[] = [];
  const unit = units.join(", ");
  const ref = parseImageRef(image);
  if (!res) {
    out.push({ level: "notice", check: "image", unit, subject: image, message: "placeholder reference — not checked" });
    return out;
  }
  if (res.availability === "missing") {
    out.push({ level: "error", check: "image", unit, subject: image, message: `not found in ${ref.display} (${res.detail})` });
    return out;
  }
  if (res.availability === "unverifiable") {
    out.push({
      level: policy.failOnUnverifiable ? "error" : "warning",
      check: "image",
      unit,
      subject: image,
      message: `unverifiable with the ${res.profile} profile — ${res.detail} (private? grant this repo read access or configure registry auth)`,
    });
    return out;
  }
  if (res.missingPlatforms.length) {
    out.push({ level: "error", check: "image", unit, subject: image, message: `no ${res.missingPlatforms.join(", ")} variant (has ${res.platforms.join(", ") || "?"}) — required: ${platforms.join(", ")}` });
  }
  if (!ref.digest) {
    if (isFloatingTag(ref)) {
      out.push({ level: policy.failOnFloating ? "error" : "warning", check: "image", unit, subject: image, message: `floating tag :${ref.tag} — resolves to ${res.digest}; pin by digest` });
    } else {
      out.push({ level: policy.requireDigest ? "error" : "notice", check: "image", unit, subject: image, message: `tag-only — resolves to ${res.digest}; consider @digest` });
    }
  }
  return out;
}

const ICON: Record<Level, string> = { error: "❌", warning: "⚠️", notice: "ℹ️" };

export interface UnitSummary { unit: string; objects: number; build: "ok" | "failed" | "rendered"; schema: string; deprecated: number; images: number }
export interface ImageRow { image: string; units: string[]; res?: ImageResult }

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderReport(o: { title: string; kubernetesVersion: string; policyMode: string; platforms: string[]; units: UnitSummary[]; images: ImageRow[]; findings: Finding[]; runUrl?: string }): string {
  const errors = o.findings.filter((f) => f.level === "error").length;
  const warnings = o.findings.filter((f) => f.level === "warning").length;
  const verdict = errors ? `❌ **${errors} error(s)**` : warnings ? `✅ passed with ⚠️ ${warnings} warning(s)` : "✅ passed";
  const lines: string[] = [];
  lines.push(`### 🧪 ${o.title} — kustomize check ${verdict}`);
  lines.push("");
  lines.push(`Kubernetes \`${o.kubernetesVersion}\` · policy \`${o.policyMode}\` · required platform(s) \`${o.platforms.join(", ")}\`${o.runUrl ? ` · [run](${o.runUrl})` : ""}`);
  lines.push("");
  lines.push("| unit | objects | build | schema | removed APIs | images |");
  lines.push("|---|---:|---|---|---:|---:|");
  for (const u of o.units) lines.push(`| \`${esc(u.unit)}\` | ${u.objects} | ${u.build} | ${u.schema} | ${u.deprecated} | ${u.images} |`);
  lines.push("");
  if (o.images.length) {
    lines.push("<details><summary>🐳 images (" + o.images.length + ")</summary>");
    lines.push("");
    lines.push("| image | available | digest | platforms | auth |");
    lines.push("|---|---|---|---|---|");
    for (const i of o.images) {
      const r = i.res;
      const avail = !r ? "⏭️ placeholder" : r.availability === "ok" ? (r.missingPlatforms.length ? "❌ platform" : "✅") : r.availability === "missing" ? "❌ missing" : `⚠️ ${r.status || "net"}`;
      const dg = r?.digest ? `\`${r.digest.slice(0, 19)}…\`` : "—";
      lines.push(`| \`${esc(i.image)}\` | ${avail} | ${dg} | ${r?.platforms.join(", ") || "—"} | ${r?.profile || "—"} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  if (o.findings.length) {
    lines.push("| | check | unit | subject | finding |");
    lines.push("|---|---|---|---|---|");
    const order: Level[] = ["error", "warning", "notice"];
    for (const f of [...o.findings].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))) {
      lines.push(`| ${ICON[f.level]} | ${f.check} | \`${esc(f.unit)}\` | \`${esc(f.subject)}\` | ${esc(f.message)} |`);
    }
  } else lines.push("No findings.");
  return lines.join("\n") + "\n";
}
