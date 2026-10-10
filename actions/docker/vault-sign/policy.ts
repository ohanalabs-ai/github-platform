// Pure decisions for the Vault Transit signing path — when to sign, which cosign flags, and the CUE
// the round-trip verification evaluates (the SAME predicate policy the clusters' Sigstore
// policy-controller ClusterImagePolicy asserts — planeo-infra clusters/base/hooks/policy/).

export interface SignInputs {
  eventName: string; // github.event_name
  ref: string; // github.ref
  signingRefs: string; // comma/newline list: exact refs or a trailing-* prefix (refs/tags/v*)
  vaultUrl: string;
  vaultRole: string;
  transitKey: string;
}
export interface Decision { sign: boolean; reason: string }

export function parseRefs(list: string): string[] {
  return list.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export function refMatches(ref: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? ref.startsWith(p.slice(0, -1)) : ref === p));
}

/**
 * Sign only from a trusted build: never a pull_request (untrusted code; the PR role is read-only and
 * the Vault role binds `ref`, so it would 403 anyway), only refs the caller lists (default main /
 * develop — the refs the admission CUE accepts and the per-repo Vault roles are bound to).
 * Missing configuration is an error, not a silent skip: the caller asked for attestation-mode vault.
 */
export function decide(i: SignInputs): Decision {
  const missing = ([["vault-url", i.vaultUrl], ["vault-role", i.vaultRole], ["transit-key", i.transitKey]] as const)
    .filter(([, v]) => !v.trim()).map(([k]) => k);
  if (missing.length) throw new Error(`attestation-mode vault needs input(s): ${missing.join(", ")}`);
  if (i.eventName === "pull_request" || i.eventName === "pull_request_target") {
    return { sign: false, reason: `${i.eventName} events never sign (untrusted code); the push build of the merge signs` };
  }
  const refs = parseRefs(i.signingRefs);
  if (!refMatches(i.ref, refs)) {
    return { sign: false, reason: `${i.ref} is not a signing ref (${refs.join(", ") || "none configured"})` };
  }
  return { sign: true, reason: `${i.eventName} on ${i.ref}` };
}

/** `cosign version --json` → major version (0 when unknown). */
export function cosignMajor(versionJson: string): number {
  try {
    const v = (JSON.parse(versionJson) as { gitVersion?: string }).gitVersion || "";
    const m = /^v?(\d+)\./.exec(v);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

/**
 * Flags for a key-based, NO-transparency-log signature in the classic `.sig`/`.att` tag layout that
 * policy-controller and `cosign verify --key` read. cosign v3 defaults to a signing config (which
 * uploads to the public Rekor) and the new bundle format; `--tlog-upload=false` alone is rejected
 * there ("not supported with --use-signing-config") — verified with cosign v3.1.3.
 */
export function signFlags(major: number): string[] {
  return major >= 3
    ? ["--yes", "--use-signing-config=false", "--tlog-upload=false", "--new-bundle-format=false"]
    : ["--yes", "--tlog-upload=false"];
}

/** Verification never consults a transparency log: the trust root is the pinned public key. */
export function verifyFlags(major: number): string[] {
  return major >= 3 ? ["--insecure-ignore-tlog=true", "--new-bundle-format=false"] : ["--insecure-ignore-tlog=true"];
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A Go-regexp string as a CUE string literal body (backslashes doubled). */
const cueStr = (re: string) => re.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export interface CueInputs {
  org: string; // the GitHub org whose images the policy covers (planeodev | ohanalabs-ai)
  refsRegex?: string; // default ^refs/heads/(main|develop)$
  signerWorkflow: string; // ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml
  serverUrl?: string;
}

/** The ClusterImagePolicy `approved-build` CUE for one org — same fields and patterns (dots escaped). */
export function admissionCue(i: CueInputs): string {
  const server = (i.serverUrl || "https://github.com").replace(/\/+$/, "");
  const repo = `^${reEscape(server)}/${reEscape(i.org)}/[A-Za-z0-9._-]+$`;
  const ref = i.refsRegex || "^refs/heads/(main|develop)$";
  const path = "^\\.github/workflows/.+\\.ya?ml$";
  const builder = `^${reEscape(server)}/${reEscape(i.signerWorkflow)}@`;
  return [
    `predicateType: "https://slsa.dev/provenance/v1"`,
    `predicate: {`,
    `  buildDefinition: {`,
    `    externalParameters: {`,
    `      workflow: {`,
    `        repository: =~"${cueStr(repo)}"`,
    `        ref:        =~"${cueStr(ref)}"`,
    `        path:       =~"${cueStr(path)}"`,
    `      }`,
    `    }`,
    `  }`,
    `  runDetails: {`,
    `    builder: {`,
    `      id: =~"${cueStr(builder)}"`,
    `    }`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}
