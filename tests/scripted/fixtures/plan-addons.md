### 1 to add, 1 to change, 1 to destroy, 1 unchanged

> ❌ **1 resource(s) could not be previewed** — the apply may fail or change them blind; read their notes below.

- add
    - `k8s` apps/v1.Deployment openlit/openlit-pricing — kustomize addons/product/openlit (server-side)
- change
    - `k8s` v1.Secret openlit/openlit-db
- destroy
    - `helm-release` openobserve/openobserve — helm uninstall (present now, chart openobserve-0.14.5)

<details><summary>✅ unchanged (1)</summary>

- `k8s` v1.ConfigMap openlit/openlit-config

</details>

- ℹ️ not diffable — the apply also does this:
    - `step` openlit — imports the OpenLIT dashboards (hooks/openlit/import-dashboards.sh, non-fatal)

- ❌ errors
    - `k8s` kustomize addons/platform/kagent — kubectl diff failed (exit 2): the CRD Agent is not established yet

<details><summary>Change details</summary>

````diff
# k8s apps/v1.Deployment openlit/openlit-pricing will be created
# kustomize addons/product/openlit (server-side)
--- /dev/null
+++ apps/v1.Deployment openlit/openlit-pricing
@@ -0,0 +1,4 @@
+apiVersion: apps/v1
+kind: Deployment
+metadata:
+  name: openlit-pricing
````

````diff
# k8s v1.Secret openlit/openlit-db will be updated
--- live
+++ rendered
(Secret: 2 line(s) differ — values withheld)
````

````diff
# helm-release openobserve/openobserve will be destroyed
# helm uninstall (present now, chart openobserve-0.14.5)
````

````diff
# k8s kustomize addons/platform/kagent could not be previewed
# kubectl diff failed (exit 2): the CRD Agent is not established yet
````

</details>
