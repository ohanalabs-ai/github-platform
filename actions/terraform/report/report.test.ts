import { test } from "node:test";
import assert from "node:assert/strict";
import { parseErrors, parseCounts, summaryMarkdown } from "./report.ts";

// The real `-no-color` output of the failed apply that motivated this action
// (planeodev/planeo-infra run 38155154144, deploy job).
const FAILED_APPLY = `tailscale_federated_identity.github_ci["planeodev"]: Creating...
tailscale_federated_identity.github_ci["ohanalabs-ai"]: Creating...

Error: Failed to create federated identity

  with tailscale_federated_identity.github_ci["planeodev"],
  on tailscale-ci-federation.tf line 28, in resource "tailscale_federated_identity" "github_ci":
  28: resource "tailscale_federated_identity" "github_ci" {

not found (404)

Error: Failed to create federated identity

  with tailscale_federated_identity.github_ci["ohanalabs-ai"],
  on tailscale-ci-federation.tf line 28, in resource "tailscale_federated_identity" "github_ci":
  28: resource "tailscale_federated_identity" "github_ci" {

not found (404)
`;

const BOXED = `╷
│ Error: Provider credentials error
│
│   with provider["registry.terraform.io/hashicorp/aws"],
│   on providers.tf line 1, in provider "aws":
│    1: provider "aws" {
│
│ no valid credential sources found
╵
`;

test("parses every Error block with its resource address, file and line", () => {
  const errs = parseErrors(FAILED_APPLY);
  assert.equal(errs.length, 2);
  assert.deepEqual(errs.map((e) => e.address), [
    'tailscale_federated_identity.github_ci["planeodev"]',
    'tailscale_federated_identity.github_ci["ohanalabs-ai"]',
  ]);
  assert.equal(errs[0].summary, "Failed to create federated identity");
  assert.equal(errs[0].file, "tailscale-ci-federation.tf");
  assert.equal(errs[0].line, 28);
  assert.equal(errs[0].detail, "not found (404)");
});

test("parses the │-framed (colour) form", () => {
  const [e] = parseErrors(BOXED);
  assert.equal(e.summary, "Provider credentials error");
  assert.equal(e.address, 'provider["registry.terraform.io/hashicorp/aws"]');
  assert.equal(e.file, "providers.tf");
  assert.match(e.detail, /no valid credential sources found/);
});

test("a clean apply has no errors and reports counts", () => {
  const text = "aws_s3_bucket.x: Creation complete after 2s\n\nApply complete! Resources: 3 added, 1 changed, 0 destroyed.\n";
  assert.deepEqual(parseErrors(text), []);
  assert.deepEqual(parseCounts(text), { added: 3, changed: 1, destroyed: 0 });
});

test("destroy footer counts", () => {
  assert.deepEqual(parseCounts("Destroy complete! Resources: 7 destroyed.\n"), { added: 0, changed: 0, destroyed: 7 });
});

test("summary names each failing resource; a failure without Error blocks says so", () => {
  const md = summaryMarkdown("apply", "failure", parseErrors(FAILED_APPLY), null);
  assert.match(md, /❌ failure/);
  assert.match(md, /### 2 errors/);
  assert.match(md, /github_ci\["ohanalabs-ai"\]/);
  assert.match(summaryMarkdown("apply", "failure", [], null), /No Terraform `Error:` block/);
  assert.match(summaryMarkdown("destroy", "success", [], { added: 0, changed: 0, destroyed: 2 }), /🧨 terraform destroy: ✅/);
});
