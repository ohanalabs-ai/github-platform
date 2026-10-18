// 🧩 A small, dependency-free XML reader for test and coverage reports (JUnit, Cobertura, JaCoCo).
// Org rule: no npm dependencies in actions — github-script's Node 24 runtime has no XML parser, so this
// is hand-written. It covers what those report formats use: the XML prolog / processing instructions,
// comments, a DOCTYPE (incl. an internal subset — JaCoCo ships one), CDATA, self-closing tags,
// single/double-quoted attributes and the predefined + numeric character entities. It does NOT
// validate, resolve external entities (never fetched: no XXE) or keep namespaces apart from the name.
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m: string, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

const isSpace = (c: string): boolean => c === " " || c === "\n" || c === "\t" || c === "\r";

export function parseXml(src: string): XmlElement {
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const doc: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [doc];
  const fail = (msg: string): never => { throw new Error(`XML: ${msg} at offset ${i}`); };

  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf("<", i);
    if (lt < 0) { if (stack.length > 1) top.text += decodeEntities(src.slice(i)); break; }
    if (lt > i) { if (stack.length > 1) top.text += decodeEntities(src.slice(i, lt)); i = lt; }

    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 4);
      if (e < 0) fail("unterminated comment");
      i = e + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const e = src.indexOf("]]>", i + 9);
      if (e < 0) fail("unterminated CDATA");
      if (stack.length > 1) top.text += src.slice(i + 9, e);
      i = e + 3;
    } else if (src.startsWith("<?", i)) {
      const e = src.indexOf("?>", i + 2);
      if (e < 0) fail("unterminated processing instruction");
      i = e + 2;
    } else if (src.startsWith("<!", i)) {
      // <!DOCTYPE …> with an optional [internal subset]
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= n) fail("unterminated declaration");
      i = j + 1;
    } else if (src[i + 1] === "/") {
      const e = src.indexOf(">", i);
      if (e < 0) fail("unterminated end tag");
      const name = src.slice(i + 2, e).trim();
      if (stack.length <= 1 || top.name !== name) fail(`unexpected </${name}>${stack.length > 1 ? ` (open: <${top.name}>)` : ""}`);
      stack.pop();
      i = e + 1;
    } else {
      let j = i + 1;
      while (j < n && !isSpace(src[j]) && src[j] !== ">" && src[j] !== "/") j++;
      const name = src.slice(i + 1, j);
      if (!name) fail("empty tag name");
      const el: XmlElement = { name, attrs: {}, children: [], text: "" };
      let selfClosing = false;
      for (;;) {
        while (j < n && isSpace(src[j])) j++;
        if (j >= n) fail(`unterminated <${name}>`);
        if (src[j] === ">") { j++; break; }
        if (src[j] === "/" && src[j + 1] === ">") { selfClosing = true; j += 2; break; }
        const a = j;
        while (j < n && !isSpace(src[j]) && src[j] !== "=" && src[j] !== ">" && src[j] !== "/") j++;
        const attr = src.slice(a, j);
        while (j < n && isSpace(src[j])) j++;
        if (src[j] !== "=") { if (!attr) fail(`bad attribute in <${name}>`); el.attrs[attr] = ""; continue; } // tolerate a bare attribute
        j++;
        while (j < n && isSpace(src[j])) j++;
        const q = src[j];
        if (q !== '"' && q !== "'") fail(`unquoted attribute ${attr} in <${name}>`);
        const e = src.indexOf(q, j + 1);
        if (e < 0) fail(`unterminated attribute ${attr} in <${name}>`);
        // attribute-value normalisation: literal whitespace → space; &#xA; stays a newline
        el.attrs[attr] = decodeEntities(src.slice(j + 1, e).replace(/[\t\n\r]/g, " "));
        j = e + 1;
      }
      top.children.push(el);
      if (!selfClosing) stack.push(el);
      i = j;
    }
  }
  if (stack.length > 1) fail(`unclosed <${stack[stack.length - 1].name}>`);
  const root = doc.children[0];
  if (!root) fail("no root element");
  return root;
}

/** Local name without a namespace prefix (`ns2:testsuite` → `testsuite`). */
export const localName = (el: XmlElement): string => el.name.slice(el.name.indexOf(":") + 1);

export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => localName(c) === name);
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => localName(c) === name);
}

/** Every descendant (depth-first, document order) with this local name. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [...el.children].reverse();
  while (stack.length) {
    const c = stack.pop() as XmlElement;
    if (localName(c) === name) out.push(c);
    for (let k = c.children.length - 1; k >= 0; k--) stack.push(c.children[k]);
  }
  return out;
}

/** A numeric attribute; NaN when absent or not a number ("1,234.5" → 1234.5). */
export function numAttr(el: XmlElement, name: string): number {
  const v = el.attrs[name];
  if (v === undefined || v.trim() === "") return NaN;
  return Number(v.replace(/,/g, "").trim());
}
