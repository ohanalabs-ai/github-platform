// A small JSON Schema (2020-12) validator — enough for schema/subgraph.schema.json and the fragment schemas,
// with no npm dependency (org rule: all Actions logic is TypeScript, Node built-ins only).
//
// Supported: type (string or list), enum, const, required, properties, additionalProperties (bool or schema),
// patternProperties, items, prefixItems, minItems, maxItems, uniqueItems, minLength, maxLength, pattern, minimum,
// maximum, exclusiveMinimum, exclusiveMaximum, allOf, anyOf, oneOf, not, if/then/else, $ref to "#/…" pointers.
// Annotations (description, examples, title, default, format, $comment, …) are ignored, as the spec allows for
// `format`. An UNKNOWN assertion keyword is reported as an error so a schema change cannot silently weaken the gate.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "$defs", "definitions", "title", "description", "examples", "default", "format",
  "deprecated", "readOnly", "writeOnly", "contentMediaType", "contentEncoding",
]);
const ASSERTIONS = new Set([
  "type", "enum", "const", "required", "properties", "additionalProperties", "patternProperties", "items",
  "prefixItems", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$ref",
  "minProperties", "maxProperties",
]);

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: Json): boolean {
  const t = typeOf(v);
  return want === t || (want === "number" && t === "integer");
}

function deepEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveRef(root: Json, ref: string): Json {
  if (!ref.startsWith("#")) throw new Error(`unsupported $ref ${ref} (only local "#/…" pointers)`);
  let node = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node?.[key];
    if (node === undefined) throw new Error(`unresolvable $ref ${ref}`);
  }
  return node;
}

/** Validate `value` against `schema`; returns human-readable errors (empty = valid). At most `limit` errors. */
export function validate(schema: Json, value: Json, limit = 20): string[] {
  const errors: string[] = [];
  const root = schema;
  const regexCache = new Map<string, RegExp>();
  const re = (p: string) => {
    if (!regexCache.has(p)) regexCache.set(p, new RegExp(p, "u"));
    return regexCache.get(p) as RegExp;
  };

  const check = (s: Json, v: Json, path: string, out: string[]): void => {
    if (out.length >= limit) return;
    if (s === true || s === undefined) return;
    if (s === false) { out.push(`${path}: not allowed`); return; }
    for (const k of Object.keys(s)) {
      if (!ANNOTATIONS.has(k) && !ASSERTIONS.has(k)) out.push(`schema keyword "${k}" at ${path} is not supported by the gate`);
    }
    if (s.$ref) check(resolveRef(root, s.$ref), v, path, out);
    if (s.type !== undefined) {
      const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(t, v))) { out.push(`${path}: expected ${types.join("|")}, got ${typeOf(v)}`); return; }
    }
    if (s.enum && !s.enum.some((e: Json) => deepEqual(e, v))) out.push(`${path}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
    if ("const" in s && !deepEqual(s.const, v)) out.push(`${path}: must equal ${JSON.stringify(s.const)}`);
    const t = typeOf(v);
    if (t === "string") {
      const len = [...v].length;
      if (s.minLength !== undefined && len < s.minLength) out.push(`${path}: shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && len > s.maxLength) out.push(`${path}: longer than ${s.maxLength}`);
      if (s.pattern !== undefined && !re(s.pattern).test(v)) out.push(`${path}: ${JSON.stringify(v).slice(0, 80)} does not match /${s.pattern}/`);
    }
    if (t === "integer" || t === "number") {
      if (s.minimum !== undefined && v < s.minimum) out.push(`${path}: below minimum ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) out.push(`${path}: above maximum ${s.maximum}`);
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) out.push(`${path}: not above ${s.exclusiveMinimum}`);
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) out.push(`${path}: not below ${s.exclusiveMaximum}`);
    }
    if (t === "array") {
      if (s.minItems !== undefined && v.length < s.minItems) out.push(`${path}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${path}: more than ${s.maxItems} items`);
      if (s.uniqueItems && new Set(v.map((x: Json) => JSON.stringify(x))).size !== v.length) out.push(`${path}: items are not unique`);
      const prefix: Json[] = s.prefixItems || [];
      v.forEach((item: Json, i: number) => {
        if (i < prefix.length) check(prefix[i], item, `${path}[${i}]`, out);
        else if (s.items !== undefined) check(s.items, item, `${path}[${i}]`, out);
      });
    }
    if (t === "object") {
      const keys = Object.keys(v);
      if (s.minProperties !== undefined && keys.length < s.minProperties) out.push(`${path}: fewer than ${s.minProperties} properties`);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) out.push(`${path}: more than ${s.maxProperties} properties`);
      for (const r of s.required || []) if (!(r in v)) out.push(`${path}: missing required "${r}"`);
      const props = s.properties || {};
      const pats = Object.entries(s.patternProperties || {});
      for (const k of keys) {
        let matched = false;
        if (k in props) { matched = true; check(props[k], v[k], `${path}.${k}`, out); }
        for (const [p, ps] of pats) if (re(p).test(k)) { matched = true; check(ps, v[k], `${path}.${k}`, out); }
        if (!matched && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) out.push(`${path}: unexpected property "${k}"`);
          else check(s.additionalProperties, v[k], `${path}.${k}`, out);
        }
      }
    }
    if (s.allOf) for (const sub of s.allOf) check(sub, v, path, out);
    const passes = (sub: Json) => { const e: string[] = []; check(sub, v, path, e); return e.length === 0; };
    if (s.anyOf && !s.anyOf.some(passes)) out.push(`${path}: matches none of anyOf`);
    if (s.oneOf) {
      const n = s.oneOf.filter(passes).length;
      if (n !== 1) out.push(`${path}: matches ${n} of oneOf (exactly 1 required)`);
    }
    if (s.not !== undefined && passes(s.not)) out.push(`${path}: must not match "not"`);
    if (s.if !== undefined) {
      if (passes(s.if)) { if (s.then !== undefined) check(s.then, v, path, out); }
      else if (s.else !== undefined) check(s.else, v, path, out);
    }
  };

  check(schema, value, "$", errors);
  return errors.slice(0, limit);
}
