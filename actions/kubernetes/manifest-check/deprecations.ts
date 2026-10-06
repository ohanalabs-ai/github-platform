// apiVersions removed from Kubernetes, by the minor version that removed them. A manifest that uses
// one cannot be applied to a cluster at or past that version — the admission-time failure, caught
// at build time.
export interface Removed { apiVersion: string; kinds: string[] | "*"; removedIn: string; replacement: string }

export const REMOVED: Removed[] = [
  { apiVersion: "extensions/v1beta1", kinds: "*", removedIn: "1.22", replacement: "apps/v1, networking.k8s.io/v1, policy/v1" },
  { apiVersion: "apps/v1beta1", kinds: "*", removedIn: "1.16", replacement: "apps/v1" },
  { apiVersion: "apps/v1beta2", kinds: "*", removedIn: "1.16", replacement: "apps/v1" },
  { apiVersion: "networking.k8s.io/v1beta1", kinds: ["Ingress", "IngressClass"], removedIn: "1.22", replacement: "networking.k8s.io/v1" },
  { apiVersion: "rbac.authorization.k8s.io/v1beta1", kinds: "*", removedIn: "1.22", replacement: "rbac.authorization.k8s.io/v1" },
  { apiVersion: "admissionregistration.k8s.io/v1beta1", kinds: "*", removedIn: "1.22", replacement: "admissionregistration.k8s.io/v1" },
  { apiVersion: "apiextensions.k8s.io/v1beta1", kinds: "*", removedIn: "1.22", replacement: "apiextensions.k8s.io/v1" },
  { apiVersion: "apiregistration.k8s.io/v1beta1", kinds: "*", removedIn: "1.22", replacement: "apiregistration.k8s.io/v1" },
  { apiVersion: "certificates.k8s.io/v1beta1", kinds: "*", removedIn: "1.22", replacement: "certificates.k8s.io/v1" },
  { apiVersion: "coordination.k8s.io/v1beta1", kinds: "*", removedIn: "1.22", replacement: "coordination.k8s.io/v1" },
  { apiVersion: "scheduling.k8s.io/v1beta1", kinds: "*", removedIn: "1.22", replacement: "scheduling.k8s.io/v1" },
  { apiVersion: "storage.k8s.io/v1beta1", kinds: ["CSIDriver", "CSINode", "StorageClass", "VolumeAttachment"], removedIn: "1.22", replacement: "storage.k8s.io/v1" },
  { apiVersion: "batch/v1beta1", kinds: ["CronJob"], removedIn: "1.25", replacement: "batch/v1" },
  { apiVersion: "policy/v1beta1", kinds: ["PodDisruptionBudget", "PodSecurityPolicy"], removedIn: "1.25", replacement: "policy/v1 (PSP: Pod Security Admission)" },
  { apiVersion: "autoscaling/v2beta1", kinds: ["HorizontalPodAutoscaler"], removedIn: "1.25", replacement: "autoscaling/v2" },
  { apiVersion: "autoscaling/v2beta2", kinds: ["HorizontalPodAutoscaler"], removedIn: "1.26", replacement: "autoscaling/v2" },
  { apiVersion: "discovery.k8s.io/v1beta1", kinds: ["EndpointSlice"], removedIn: "1.25", replacement: "discovery.k8s.io/v1" },
  { apiVersion: "events.k8s.io/v1beta1", kinds: ["Event"], removedIn: "1.25", replacement: "events.k8s.io/v1" },
  { apiVersion: "node.k8s.io/v1beta1", kinds: ["RuntimeClass"], removedIn: "1.25", replacement: "node.k8s.io/v1" },
  { apiVersion: "storage.k8s.io/v1beta1", kinds: ["CSIStorageCapacity"], removedIn: "1.27", replacement: "storage.k8s.io/v1" },
  { apiVersion: "flowcontrol.apiserver.k8s.io/v1beta1", kinds: "*", removedIn: "1.26", replacement: "flowcontrol.apiserver.k8s.io/v1" },
  { apiVersion: "flowcontrol.apiserver.k8s.io/v1beta2", kinds: "*", removedIn: "1.29", replacement: "flowcontrol.apiserver.k8s.io/v1" },
  { apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3", kinds: "*", removedIn: "1.32", replacement: "flowcontrol.apiserver.k8s.io/v1" },
];

/** "1.35.0" / "v1.35" → [1, 35] */
export function minor(v: string): [number, number] {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function atOrAfter(target: string, removedIn: string): boolean {
  const [ta, tb] = minor(target);
  const [ra, rb] = minor(removedIn);
  return ta > ra || (ta === ra && tb >= rb);
}

export function removedApi(apiVersion: string, kind: string, kubernetesVersion: string): Removed | undefined {
  return REMOVED.find(
    (r) => r.apiVersion === apiVersion && (r.kinds === "*" || r.kinds.includes(kind)) && atOrAfter(kubernetesVersion, r.removedIn),
  );
}
