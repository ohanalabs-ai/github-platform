# The vionix signing canary — a throwaway, dependency-free image whose only job is to be built by the
# real builder and signed/attested by the org's Vault Transit key (.github/workflows/vionix-signing-canary.yaml).
FROM scratch
COPY canary.txt /canary.txt
