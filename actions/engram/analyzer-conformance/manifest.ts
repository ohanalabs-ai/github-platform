// Reads the few keys of an engram-analyzer/v1 manifest (`engram-analyzer.yaml` / `/engram/analyzer.yaml`) that the
// conformance gate needs. NOT a YAML parser: the contract's strict subset (okf/analyzer-contract-v1.md §1 — one
// document, no anchors/tags) means every key the gate reads is a top-level `key: value` line, flow sequences/maps
// on one line (`entrypoint: ["/usr/local/bin/analyzer"]`, `grpc: {service: S, rpc: R, port: 50051}`) or a block map
// one level deep. Full validation of the manifest is `analyze validate` (src/manifest.rs) in the analyzer repo.

export interface ManifestInfo {
  contract: string;
  name: string;
  version: string;
  interface: "cli" | "grpc";
  entrypoint: string[] | null;
  grpcPort: number | null;
  timeoutSeconds: number | null;
  /** `env.set`: static KEY=VALUE pairs the runner sets (contract §2). */
  envSet: string[];
}

/** `{ A: x, B: "y" }` → ["A=x", "B=y"]; [] when not a one-line flow map. */
export function flowMap(s: string): string[] {
  const t = s.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return [];
  return t.slice(1, -1).split(",").map((kv) => kv.trim()).filter(Boolean).map((kv) => {
    const i = kv.indexOf(":");
    return `${kv.slice(0, i).trim()}=${unquote(kv.slice(i + 1))}`;
  });
}

/** Drop a `# comment` that is not inside quotes. */
export function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** `["a", 'b', c]` → ["a","b","c"]; null when not a one-line flow sequence. */
export function flowSeq(s: string): string[] | null {
  const t = s.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const body = t.slice(1, -1);
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const c of body) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "" || out.length) out.push(cur.trim());
  return out.filter((x) => x !== "");
}

export function parseSeconds(s: string): number | null {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
}

export function readManifest(text: string): ManifestInfo {
  const top = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of lines) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (line === "") continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/.exec(line);
    if (m) {
      top.set(m[1], (m[2] || "").trim());
      current = m[1];
      blocks.set(current, []);
    } else if (current && /^\s/.test(line)) {
      blocks.get(current)?.push(line.trim());
    }
  }
  const iface = unquote(top.get("interface") || "cli");
  let grpcPort: number | null = null;
  const grpcInline = top.get("grpc") || "";
  const grpcText = grpcInline || (blocks.get("grpc") || []).join("\n");
  const pm = /\bport:\s*(\d+)/.exec(grpcText);
  if (pm) grpcPort = Number(pm[1]);
  let entrypoint = flowSeq(top.get("entrypoint") || "");
  if (!entrypoint && blocks.get("entrypoint")?.length) {
    entrypoint = (blocks.get("entrypoint") || []).filter((l) => l.startsWith("- ")).map((l) => unquote(l.slice(2)));
  }
  const envBlock = blocks.get("env") || [];
  const setLine = envBlock.find((l) => l.startsWith("set:"));
  let envSet = setLine ? flowMap(setLine.slice(4)) : [];
  if (setLine && envSet.length === 0) {
    // block form: `set:` followed by deeper `KEY: value` lines
    const i = envBlock.indexOf(setLine);
    envSet = envBlock.slice(i + 1).filter((l) => /^[A-Z][A-Z0-9_]*:\s/.test(l)).map((l) => {
      const j = l.indexOf(":");
      return `${l.slice(0, j)}=${unquote(l.slice(j + 1))}`;
    });
  }
  return {
    envSet,
    contract: unquote(top.get("contract") || ""),
    name: unquote(top.get("name") || ""),
    version: unquote(top.get("version") || ""),
    interface: iface === "grpc" ? "grpc" : "cli",
    entrypoint: entrypoint && entrypoint.length ? entrypoint : null,
    grpcPort,
    timeoutSeconds: parseSeconds(unquote(top.get("timeout") || "")),
  };
}
