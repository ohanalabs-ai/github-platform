// Live self-test fixture for vault-selftest.yaml: configures a throwaway dev-mode Vault (service
// container, root token = a random per-run value) the way a Planeo tenant is configured, so sign.ts and
// rotate.ts run against REAL Vault + REAL GitHub OIDC tokens:
//   auth/github-selftest  jwt, oidc_discovery_url = GitHub, bound_issuer = GitHub
//   role selftest-ok      bound to THIS repository_id + repository_owner_id + event_name, aud = SELFTEST_AUD
//   role selftest-other   bound to a repository_id that is not this one (the confused-deputy negative test)
//   transit key selftest-images  ecdsa-p256, exportable=false, allow_plaintext_backup=false
//   kv-v2 at selftest/, policy selftest = sign/verify/read that key + rw selftest/data/rotate/*
// STEP=setup does the above; STEP=negative proves selftest-other refuses this job's token.
import type { Ctx } from "./types.ts";
import { Vault, VaultError } from "./client.ts";

async function root(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${process.env.VAULT_URL}/v1/${path}`, {
    method,
    headers: { "x-vault-token": process.env.VAULT_ROOT_TOKEN || "", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
}

export default async function run({ core, context }: Ctx): Promise<void> {
  const env = process.env;
  const aud = env.SELFTEST_AUD || "";
  if ((env.STEP || "setup") === "negative") {
    const v = new Vault(env.VAULT_URL || "", undefined, true);
    const jwt = await core.getIDToken(aud);
    core.setSecret(jwt);
    try {
      await v.login("github-selftest", "selftest-other", jwt);
    } catch (e) {
      if (e instanceof VaultError && e.status === 400) return core.info(`✅ another repository's role refused this token: ${e.message}`);
      throw e;
    }
    throw new Error("❌ selftest-other accepted a token from a different repository_id — the bound claims do not bind");
  }

  await root("POST", "sys/auth/github-selftest", { type: "jwt" });
  await root("POST", "auth/github-selftest/config", { oidc_discovery_url: "https://token.actions.githubusercontent.com", bound_issuer: "https://token.actions.githubusercontent.com" });
  await root("POST", "sys/mounts/transit", { type: "transit" });
  await root("POST", "transit/keys/selftest-images", { type: "ecdsa-p256", exportable: false, allow_plaintext_backup: false });
  await root("POST", "sys/mounts/selftest", { type: "kv", options: { version: "2" } });
  await root("PUT", "sys/policies/acl/selftest", {
    policy: [
      'path "transit/sign/selftest-images/*" { capabilities = ["update"] }',
      'path "transit/verify/selftest-images/*" { capabilities = ["update"] }',
      'path "transit/keys/selftest-images" { capabilities = ["read"] }',
      'path "selftest/data/rotate/*" { capabilities = ["create", "read", "update"] }',
    ].join("\n"),
  });
  const claims = {
    repository_id: String(context.payload?.repository?.id ?? ""),
    repository_owner_id: String(context.payload?.repository?.owner?.id ?? ""),
    event_name: ["pull_request", "push", "workflow_dispatch"],
  };
  if (!claims.repository_id || !claims.repository_owner_id) throw new Error("no repository id in the event payload");
  const role = (bound: Record<string, unknown>) => ({
    role_type: "jwt",
    bound_audiences: [aud],
    bound_claims: bound,
    user_claim: "repository_id",
    claim_mappings: { repository: "repository", ref: "ref", workflow_ref: "workflow_ref", run_id: "run_id" },
    token_policies: ["selftest"],
    token_ttl: "5m",
    token_max_ttl: "5m",
    token_no_default_policy: false,
  });
  await root("POST", "auth/github-selftest/role/selftest-ok", role(claims));
  await root("POST", "auth/github-selftest/role/selftest-other", role({ ...claims, repository_id: "1" }));
  core.info(`dev Vault configured: role selftest-ok bound to repository_id=${claims.repository_id} owner_id=${claims.repository_owner_id}, aud=${aud}`);
}
