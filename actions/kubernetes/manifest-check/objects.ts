// Turn rendered multi-document YAML into objects (yq does the YAML → JSON; no npm parser) and pull
// every container image out of them — core workloads AND custom resources that carry images.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./types.ts";

export interface K8sObject { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string }; [k: string]: unknown }
export interface ImageUse { image: string; object: string; source: string; path: string }

export function manifestFiles(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return [target];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ya?ml)$/.test(n)) out.push(p);
    }
  };
  walk(target);
  return out;
}

export async function loadObjects(exec: Exec, files: string[]): Promise<Array<{ file: string; obj: K8sObject }>> {
  const all: Array<{ file: string; obj: K8sObject }> = [];
  for (const f of files) {
    if (!readFileSync(f, "utf8").trim()) continue;
    const out = await exec.getExecOutput("yq", ["-o=json", "-I=0", "."], { silent: true, input: readFileSync(f), ignoreReturnCode: true });
    if (out.exitCode !== 0) throw new Error(`yq could not parse ${f}: ${out.stderr.trim()}`);
    for (const line of out.stdout.split("\n")) {
      const t = line.trim();
      if (!t || t === "null") continue;
      const v = JSON.parse(t) as K8sObject | K8sObject[];
      for (const o of Array.isArray(v) ? v : [v]) {
        if (!o || typeof o !== "object") continue;
        if (o.kind === "List" && Array.isArray((o as { items?: unknown[] }).items)) {
          for (const it of (o as { items: K8sObject[] }).items) all.push({ file: f, obj: it });
        } else all.push({ file: f, obj: o });
      }
    }
  }
  return all;
}

export function objectId(o: K8sObject): string {
  const ns = o.metadata?.namespace ? `${o.metadata.namespace}/` : "";
  return `${o.kind || "?"} ${ns}${o.metadata?.name || "?"}`;
}

const IMAGE_LIKE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9._-]+)*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;

/** Every image an object would run: containers/initContainers/ephemeralContainers anywhere, plus
 *  string fields named `image` or `*Image` (custom resources like WorkerPool.ateomImage,
 *  ActorTemplate.pauseImage, MCPServer.deployment.image). CRD definitions are skipped. */
export function extractImages(o: K8sObject, file: string): ImageUse[] {
  if (o.kind === "CustomResourceDefinition") return [];
  const found: ImageUse[] = [];
  const id = objectId(o);
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof val === "string" && (k === "image" || /[a-z]Image$/.test(k)) && IMAGE_LIKE.test(val.trim()) && val.trim().length > 0) {
        found.push({ image: val.trim(), object: id, source: file, path: p });
      } else if (val && typeof val === "object") walk(val, p);
    }
  };
  walk(o, "");
  return found;
}
