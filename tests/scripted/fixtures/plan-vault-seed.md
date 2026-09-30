### 1 to add, 1 to change, 0 to destroy, 8 unchanged

- add
    - `vault-kv` planeo/clouds/aws/eks/product/auth-broker/session-key — MISSING — the apply mints it (values generated at apply, never printed)
- change
    - `vault-kv` planeo/clusters/platform-aws-eks-use1-prd/render-vars — 1 added, 1 changed, 0 removed, 14 unchanged key(s) — a new KV version

<details><summary>✅ unchanged (8)</summary>

- `vault-kv` planeo/clouds/aws/eks/platform/authentik/bootstrap — exists, keeping (never re-minted)
- `vault-kv` planeo/clouds/aws/eks/platform/authentik/oidc-clients — exists, keeping (never re-minted)
- `vault-kv` planeo/clouds/aws/eks/platform/oauth2-proxy/cookie — exists, keeping (never re-minted)
- `vault-kv` planeo/clouds/aws/eks/platform/openobserve/root — exists, keeping (never re-minted)
- `vault-kv` planeo/clouds/aws/eks/product/auth-broker/redis — exists, keeping (never re-minted)
- `vault-kv` planeo/clouds/aws/eks/product/auth-broker/credstore-redis — exists, keeping (never re-minted)
- `vault-kv` planeo/clouds/aws/eks/platform/argocd/repos/eks-cluster — exists, keeping (deploy key)
- `vault-kv` planeo/clouds/aws/eks/platform/argocd/repos/customers — exists, keeping (deploy key)

</details>

<details><summary>Change details</summary>

````diff
# vault-kv planeo/clouds/aws/eks/product/auth-broker/session-key will be created
# MISSING — the apply mints it (values generated at apply, never printed)
--- planeo/clouds/aws/eks/product/auth-broker/session-key (absent)
+++ planeo/clouds/aws/eks/product/auth-broker/session-key (apply)
@@ -0,0 +1 @@
+key = <generated at apply, 32 chars>
````

````diff
# vault-kv planeo/clusters/platform-aws-eks-use1-prd/render-vars will be updated
# 1 added, 1 changed, 0 removed, 14 unchanged key(s) — a new KV version
--- planeo/clusters/platform-aws-eks-use1-prd/render-vars (current, v7)
+++ planeo/clusters/platform-aws-eks-use1-prd/render-vars (apply)
@@ -1,4 +1,5 @@
 CHANGE_ME_AWS_REGION = <redacted len=9 sha256:5f3c1a2b>
-CHANGE_ME_CLUSTER_NAME = <redacted len=11 sha256:0a9b8c7d>
+CHANGE_ME_CLUSTER_NAME = <redacted len=15 sha256:e1f2a3b4>
+CHANGE_ME_GVISOR_NODEPOOL = <redacted len=6 sha256:77aa11bb>
 CHANGE_ME_DOMAIN = <redacted len=10 sha256:9c8d7e6f>
````

</details>
