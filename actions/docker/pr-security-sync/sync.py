#!/usr/bin/env python3
"""PR security synchronizer — the evaluate-and-decide engine behind pr-security-synchronizer.yaml.

Per-service image workflows live in DIFFERENT files (one caller per compose service, each calling
docker-multiarch-cicd.yaml then docker-image-security.yaml), so there is no shared `needs:` graph.
This script discovers every check run on the PR head SHA, waits until all of them (except this
workflow run's own jobs) completed, groups them by workflow run (= one service), re-classifies them
(build / scan / other), downloads each scan's `image-security-report` artifact (trivy.json + meta),
and decides.

Subcommands (all read env, write files under OUT_DIR, write step outputs to $GITHUB_OUTPUT):
  collect  wait + classify + consolidated.json (+ patch/copa candidate lists)
  patch    apply DETERMINISTIC language fixes at/above ACCEPT_LEVEL in the checked-out PR tree:
           Go modules (`go get mod@fixed`, kept only if the module's `go` directive stays within the
           Dockerfile's golang builder) and pip-compile pins (`pkg==fixed`, kept only if pip can
           still resolve the file). Everything else is left to Dependabot / Copa.
  decide   render the consolidated report (job summary + sticky comment), exit 1 on policy-fail.

Fix paths: copa-os (OS package, patched in the image by Copa), commit-go / commit-pip (committed
here), dependabot-base-image (Go stdlib = the golang builder image), dockerfile-binary (a binary the
Dockerfile downloads, e.g. grpc_health_probe — bump its version pin), dependabot-lang (npm, maven,
nuget, … — Dependabot PRs), none (no fixed version). Stdlib only (+ the gh CLI on the runner).
"""
import argparse, glob, json, os, re, subprocess, sys, time, zipfile, io

ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]
env = os.environ.get
OUT = env("OUT_DIR") or "pr-security-sync"
REPO = env("REPO") or env("GITHUB_REPOSITORY")


def out(**kv):
    path = env("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a") as f:
        for k, v in kv.items():
            if isinstance(v, (dict, list)):
                v = json.dumps(v, separators=(",", ":"))
            f.write(f"{k}={v}\n")


def gh(*args, raw=False):
    r = subprocess.run(["gh", *args], capture_output=True, text=not raw, check=False)
    if r.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}… failed: {(r.stderr or b'')[:300]}")
    return r.stdout


def gh_json(path):
    return json.loads(gh("api", "-H", "Accept: application/vnd.github+json", path))


def at_or_above(level):
    level = (level or "none").upper()
    return [] if level == "NONE" else ORDER[: ORDER.index(level) + 1]


# ----------------------------------------------------------------------------------------------
# collect
# ----------------------------------------------------------------------------------------------
def list_check_runs(sha):
    runs, page = [], 1
    while True:
        d = gh_json(f"repos/{REPO}/commits/{sha}/check-runs?per_page=100&page={page}")
        runs += d.get("check_runs", [])
        if len(runs) >= d.get("total_count", 0) or not d.get("check_runs"):
            return runs
        page += 1


def run_id_of(check):
    m = re.search(r"/actions/runs/(\d+)/", check.get("details_url") or "")
    return m.group(1) if m else None


def wait_for_checks(sha, own_run, ignore_re):
    interval = int(env("POLL_INTERVAL") or 30)
    deadline = time.time() + 60 * int(env("TIMEOUT_MINUTES") or 60)
    settle = int(env("SETTLE_SECONDS") or 90)
    start, last_n, stable = time.time(), -1, 0
    while True:
        checks = [c for c in list_check_runs(sha)
                  if run_id_of(c) != own_run and not ignore_re.search(c.get("name", ""))]
        pending = [c["name"] for c in checks if c.get("status") != "completed"]
        n = len(checks)
        stable = stable + 1 if (n == last_n and not pending) else 0
        last_n = n
        print(f"[{int(time.time() - start):>4}s] {n} check(s), {len(pending)} pending"
              + (f": {', '.join(pending[:6])}{' …' if len(pending) > 6 else ''}" if pending else ""))
        # Done: nothing pending, the set is stable across two polls, and the settle window passed
        # (workflows triggered by the same push can register their checks a little later).
        if not pending and stable >= 1 and time.time() - start >= settle:
            return checks
        if time.time() > deadline:
            raise TimeoutError(f"timed out after {env('TIMEOUT_MINUTES') or 60} min; still pending: {pending}")
        time.sleep(interval)


def compose_contexts():
    """service -> build context dir (relative to the repo root), from `docker compose config`."""
    f = env("COMPOSE_FILE") or "docker-compose.yaml"
    if not os.path.exists(f):
        return {}
    r = subprocess.run(["docker", "compose", "-f", f, "config", "--format", "json"],
                       capture_output=True, text=True, check=False)
    if r.returncode != 0:
        print(f"::warning::docker compose config failed for {f}: {r.stderr[:200]}")
        return {}
    root = os.path.abspath(".")
    ctx = {}
    for name, svc in (json.loads(r.stdout).get("services") or {}).items():
        b = svc.get("build")
        c = b.get("context") if isinstance(b, dict) else b
        if c:
            ctx[name] = os.path.relpath(os.path.abspath(c), root)
    return ctx


def norm_pip(n):
    return re.sub(r"[-_.]+", "-", n).lower()


def downloaded_by_dockerfile(target, ctx_dir):
    """True when the scanned binary is fetched by the Dockerfile (wget/curl/ADD URL), not built here."""
    base = os.path.basename((target or "").rstrip("/"))
    df = os.path.join(ctx_dir or "", "Dockerfile")
    if not base or not ctx_dir or not os.path.exists(df):
        return False
    text = open(df).read()
    return base in text and re.search(r"(?mi)\b(wget|curl)\b|^ADD\s+https?://", text) is not None


def fix_path(res_class, res_type, pkg, fixed, ctx_dir, target=""):
    if not fixed:
        return "none"
    if res_class == "os-pkgs":
        return "copa-os"
    t = (res_type or "").lower()
    if t == "gobinary" and downloaded_by_dockerfile(target, ctx_dir):
        return "dockerfile-binary"   # bump the tool's version pin in the Dockerfile
    if t in ("gobinary", "gomod"):
        if pkg == "stdlib":
            return "dependabot-base-image"
        return "commit-go" if ctx_dir and glob.glob(os.path.join(ctx_dir, "go.mod")) else "dependabot-lang"
    if t in ("python-pkg", "pip", "pipenv", "poetry"):
        req = os.path.join(ctx_dir or "", "requirements.txt")
        if ctx_dir and os.path.exists(req):
            pins = {norm_pip(l.split("==")[0]) for l in open(req) if "==" in l and not l.lstrip().startswith("#")}
            if norm_pip(pkg) in pins:
                return "commit-pip"
        return "dependabot-lang"
    return "dependabot-lang"


def collect():
    sha, own = env("HEAD_SHA"), env("GITHUB_RUN_ID")
    build_re = re.compile(env("BUILD_PATTERN") or r"🏗️ (pr|ref)-build$")
    scan_re = re.compile(env("SCAN_PATTERN") or r"🛡️ image security$")
    ignore_re = re.compile(env("IGNORE_PATTERN") or r"(?i)pr-delete|github-release|slsa|🏷️ release")
    accept = at_or_above(env("ACCEPT_LEVEL"))
    copa_sev = at_or_above(env("COPA_SEVERITY") or env("ACCEPT_LEVEL"))
    os.makedirs(OUT, exist_ok=True)
    checks = wait_for_checks(sha, own, ignore_re)
    ctx = compose_contexts()

    services, others = {}, []
    names = {}
    for c in checks:
        rid = run_id_of(c)
        kind = "build" if build_re.search(c["name"]) else "scan" if scan_re.search(c["name"]) else "other"
        if kind == "other" or not rid:
            others.append({"name": c["name"], "conclusion": c.get("conclusion"), "url": c.get("html_url")})
            continue
        if rid not in names:
            # NOT the run's `name`/`display_title` — with `run-name:` that is the title
            # ("🐳 adservice image 2/merge @ …"); the workflow's own `name:` is the service.
            wf_id = gh_json(f"repos/{REPO}/actions/runs/{rid}").get("workflow_id")
            wf_name = gh_json(f"repos/{REPO}/actions/workflows/{wf_id}").get("name") if wf_id else rid
            names[rid] = re.sub(r"^[^A-Za-z0-9]+", "", wf_name or str(rid)).strip()
        svc = services.setdefault(rid, {"service": names[rid], "run_id": rid,
                                        "run_url": f"https://github.com/{REPO}/actions/runs/{rid}"})
        svc[kind] = {"conclusion": c.get("conclusion"), "url": c.get("html_url")}

    patch_cands, copa_cands = [], []
    for rid, svc in services.items():
        svc["context"] = ctx.get(svc["service"], "")
        if "scan" not in svc:
            continue
        arts = gh_json(f"repos/{REPO}/actions/runs/{rid}/artifacts").get("artifacts", [])
        art = next((a for a in arts if a["name"] == "image-security-report" and not a.get("expired")), None)
        if not art:
            svc["scan"]["error"] = "no image-security-report artifact"
            continue
        svc["trivy_json_url"] = f"https://github.com/{REPO}/actions/runs/{rid}/artifacts/{art['id']}"
        z = zipfile.ZipFile(io.BytesIO(gh("api", f"repos/{REPO}/actions/artifacts/{art['id']}/zip", raw=True)))
        d = os.path.join(OUT, "scans", svc["service"]); os.makedirs(d, exist_ok=True); z.extractall(d)
        meta = json.load(open(os.path.join(d, "image-security-meta.json"))) if os.path.exists(os.path.join(d, "image-security-meta.json")) else {}
        trivy = json.load(open(os.path.join(d, "trivy.json")))
        # `trivy sbom` leaves Result.Target empty for Go binaries — the SBOM (Syft sourceInfo:
        # "… go module information: /usr/bin/grpc_health_probe") says which binary a module is in.
        where = {}
        sbom_f = os.path.join(d, "sbom.spdx.json")
        if os.path.exists(sbom_f):
            for p in json.load(open(sbom_f)).get("packages") or []:
                m = re.search(r"information: (\S+)", p.get("sourceInfo") or "")
                if m:
                    where.setdefault((p.get("name"), (p.get("versionInfo") or "").lstrip("vgo")), set()).add(m.group(1))
        svc.update(image=meta.get("image", ""), digest=meta.get("digest", ""),
                   status=meta.get("status") or ("policy-fail" if svc["scan"]["conclusion"] == "failure" else "pass"),
                   threshold=(meta.get("threshold") or "CRITICAL").upper(),
                   ignore_unfixed=bool(meta.get("ignore_unfixed")))
        block_sev = at_or_above(svc["threshold"])
        vulns = []
        for r in trivy.get("Results") or []:
            for v in r.get("Vulnerabilities") or []:
                fixed = v.get("FixedVersion") or ""
                vulns.append({"id": v.get("VulnerabilityID", ""), "pkg": v.get("PkgName", ""),
                              "installed": v.get("InstalledVersion", ""), "fixed": fixed,
                              "sev": (v.get("Severity") or "UNKNOWN").upper(),
                              "class": r.get("Class", ""), "type": r.get("Type", ""),
                              "target": r.get("Target") or ",".join(sorted(where.get((v.get("PkgName"), (v.get("InstalledVersion") or "").lstrip("vgo")), []))),
                              "path": fix_path(r.get("Class"), r.get("Type"), v.get("PkgName", ""), fixed, svc["context"],
                                               r.get("Target") or next(iter(where.get((v.get("PkgName"), (v.get("InstalledVersion") or "").lstrip("vgo")), [])), ""))})
        svc["counts"] = {s: sum(1 for v in vulns if v["sev"] == s) for s in ORDER}
        svc["fixable"] = {s: sum(1 for v in vulns if v["sev"] == s and v["fixed"]) for s in ORDER}
        svc["blocking"] = [v for v in vulns if v["sev"] in block_sev and (v["fixed"] or not svc["ignore_unfixed"])]
        accepted = [v for v in vulns if v["sev"] in accept and v["fixed"]]
        for v in accepted:
            if v["path"] in ("commit-go", "commit-pip"):
                patch_cands.append({"service": svc["service"], "context": svc["context"], **v})
        if any(v["path"] == "copa-os" and v["sev"] in copa_sev for v in vulns) and svc.get("image"):
            copa_cands.append({"service": svc["service"], "image": svc["image"], "digest": svc.get("digest", "")})

    # de-duplicate (same module may be reported by several CVEs) — keep the highest fixed version later
    result = {"version": 1, "repo": REPO, "head_sha": sha, "accept_level": (env("ACCEPT_LEVEL") or "none").lower(),
              "services": sorted(services.values(), key=lambda s: s["service"]), "others": others,
              "patch_candidates": patch_cands, "copa_candidates": copa_cands}
    json.dump(result, open(os.path.join(OUT, "consolidated.json"), "w"), indent=1)
    out(has_patches=str(bool(patch_cands)).lower(), copa_matrix={"include": copa_cands},
        has_copa=str(bool(copa_cands)).lower(), services=len(services))
    print(f"{len(services)} service(s); {len(patch_cands)} committable fix(es); {len(copa_cands)} image(s) for Copa")
    return 0


# ----------------------------------------------------------------------------------------------
# patch
# ----------------------------------------------------------------------------------------------
def vkey(v):
    return [int(x) if x.isdigit() else x for x in re.split(r"[.\-+]", v.lstrip("v"))]


def pick_fixed(installed, fixed):
    """Smallest listed fixed version strictly above the installed one (Trivy lists one per branch)."""
    cands = [f.strip() for f in fixed.split(",") if f.strip()]
    try:
        above = sorted([c for c in cands if vkey(c) > vkey(installed)], key=vkey)
    except TypeError:
        above = cands
    return above[0] if above else (cands[-1] if cands else "")


def go_directive(gomod):
    m = re.search(r"(?m)^go\s+(\d+\.\d+)", open(gomod).read())
    return m.group(1) if m else ""


def builder_go(ctx):
    df = os.path.join(ctx, "Dockerfile")
    if not os.path.exists(df):
        return ""
    m = re.search(r"(?mi)^FROM\s+(?:\S*/)?golang:(\d+\.\d+)", open(df).read())
    return m.group(1) if m else ""


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)
    return r.returncode, (r.stdout + r.stderr)[-600:]


def patch():
    data = json.load(open(os.path.join(OUT, "consolidated.json")))
    best = {}
    for c in data["patch_candidates"]:
        k = (c["context"], c["path"], c["pkg"])
        ver = pick_fixed(c["installed"], c["fixed"])
        if k not in best or vkey(ver) > vkey(best[k]["to"]):
            best[k] = {**c, "to": ver}
    applied, deferred = [], []
    for (ctx, path, pkg), c in sorted(best.items()):
        if path == "commit-go":
            gm = os.path.join(ctx, "go.mod")
            before = open(gm).read(); sum_before = open(os.path.join(ctx, "go.sum")).read() if os.path.exists(os.path.join(ctx, "go.sum")) else None
            to = c["to"] if c["to"].startswith("v") else "v" + c["to"]
            rc, log = run(["go", "get", f"{pkg}@{to}"], ctx)
            if rc == 0:
                rc, log = run(["go", "mod", "tidy"], ctx)
            limit, now = builder_go(ctx), go_directive(gm) if os.path.exists(gm) else ""
            if rc != 0 or (limit and now and vkey(now) > vkey(limit)):
                open(gm, "w").write(before)
                if sum_before is not None:
                    open(os.path.join(ctx, "go.sum"), "w").write(sum_before)
                why = (f"needs Go {now} but the Dockerfile builder is golang:{limit} — base image first (Dependabot docker)"
                       if rc == 0 else f"`go get` failed: {log.strip().splitlines()[-1] if log.strip() else rc}")
                deferred.append({**c, "reason": why})
                continue
            applied.append(c)
        elif path == "commit-pip":
            req = os.path.join(ctx, "requirements.txt")
            before = open(req).read()
            pat = re.compile(rf"(?mi)^({re.escape(pkg)}|{re.escape(pkg.replace('-', '_'))})==\S+")
            after, n = pat.subn(lambda m: f"{m.group(1)}=={c['to']}", before)
            if not n:
                deferred.append({**c, "reason": "pin not found"}); continue
            open(req, "w").write(after)
            rc, log = run([sys.executable, "-m", "pip", "install", "--dry-run", "--quiet", "--ignore-installed",
                           "--report", os.devnull, "-r", "requirements.txt"], ctx)
            if rc != 0:
                open(req, "w").write(before)
                deferred.append({**c, "reason": "pip cannot resolve with the bump — leave to Dependabot"}); continue
            applied.append(c)
    json.dump({"applied": applied, "deferred": deferred}, open(os.path.join(OUT, "patches.json"), "w"), indent=1)
    out(applied=len(applied), deferred=len(deferred))
    print(f"applied {len(applied)}, deferred {len(deferred)}")
    return 0


# ----------------------------------------------------------------------------------------------
# decide
# ----------------------------------------------------------------------------------------------
ICON = {"success": "✅", "failure": "❌", "cancelled": "🚫", "skipped": "⏭️", None: "⏳", "pass": "✅", "policy-fail": "❌"}


def decide():
    data = json.load(open(os.path.join(OUT, "consolidated.json")))
    patches = json.load(open(os.path.join(OUT, "patches.json"))) if os.path.exists(os.path.join(OUT, "patches.json")) else {"applied": [], "deferred": []}
    copa = []
    for f in sorted(glob.glob(os.path.join(OUT, "**", "copa-result.json"), recursive=True)):
        copa.append(json.load(open(f)))
    commit = env("PATCH_COMMIT") or ""
    lines = []
    w = lines.append
    builds_failed = [s for s in data["services"] if s.get("build", {}).get("conclusion") not in (None, "success", "skipped")]
    scans_failed = [s for s in data["services"] if s.get("status") == "policy-fail" or s.get("scan", {}).get("error")]
    verdict = "❌ policy-fail" if (builds_failed or scans_failed) else "✅ pass"
    w(f"# :shield: PR security synchronizer — {verdict}")
    w("")
    w(f"* Head: `{data['head_sha'][:12]}` · services: {len(data['services'])} · "
      f"accept-trivy-job-patches: `{data['accept_level']}`")
    w("")
    w("| Service | Build | Scan | Policy | CRITICAL | HIGH | MEDIUM | LOW | Blocking | Trivy JSON |")
    w("|---|---|---|---|---|---|---|---|---|---|")
    for s in data["services"]:
        c, b = s.get("counts") or {}, s.get("build") or {}
        sc = s.get("scan") or {}
        trivy = f"[artifact]({s['trivy_json_url']})" if s.get("trivy_json_url") else (sc.get("error") or "—")
        w(f"| [{s['service']}]({s['run_url']}) | {ICON.get(b.get('conclusion'), b.get('conclusion') or '—')} "
          f"| {ICON.get(s.get('status'), '—')} | {s.get('threshold', '—')} | "
          + " | ".join(str(c.get(k, '—')) for k in ORDER[:4])
          + f" | {len(s.get('blocking') or [])} | {trivy} |")
    blocking = [(s["service"], v) for s in data["services"] for v in (s.get("blocking") or [])]
    if blocking:
        w("")
        w("<details open>")
        w(f"  <summary>{len(blocking)} blocking finding(s)</summary>")
        w("")
        w("| Service | ID | Package | Installed | Fixed | Severity | Fix path |")
        w("|---|---|---|---|---|---|---|")
        for svc, v in sorted(blocking, key=lambda x: (ORDER.index(x[1]["sev"]), x[0], x[1]["pkg"]))[:150]:
            w(f"| {svc} | {v['id']} | {v['pkg']} | {v['installed']} | {v['fixed'] or '—'} | {v['sev']} | `{v['path']}` |")
        if len(blocking) > 150:
            w(f"| … {len(blocking) - 150} more in the artifacts |||||||")
        w("")
        w("</details>")
        paths = {}
        for _, v in blocking:
            paths[v["path"]] = paths.get(v["path"], 0) + 1
        w("")
        w("**Fix paths for the blocking findings:** " + ", ".join(f"`{k}` {n}" for k, n in sorted(paths.items())))
    w("")
    w("## :adhesive_bandage: Remediation")
    w("")
    if data["accept_level"] == "none":
        w("* `accept-trivy-job-patches: none` — nothing applied; the table above is the plan.")
    else:
        if patches["applied"]:
            w(f"* **Committed** to this PR{f' in `{commit[:12]}`' if commit else ''} ({len(patches['applied'])}):")
            for c in patches["applied"]:
                w(f"  * `{c['service']}` {c['pkg']} {c['installed']} → {c['to']} ({c['path']})")
        else:
            w("* No deterministic language fix to commit.")
        if patches["deferred"]:
            w(f"* **Left to Dependabot** ({len(patches['deferred'])}):")
            for c in patches["deferred"]:
                w(f"  * `{c['service']}` {c['pkg']} → {c['to']}: {c['reason']}")
        tools = sorted({(svc, v.get("target", "").split(",")[0], v["pkg"]) for svc, v in blocking if v["path"] == "dockerfile-binary"})
        if tools:
            by_bin = {}
            for svc, binary, pkg in tools:
                by_bin.setdefault(os.path.basename(binary) or "?", set()).add(svc)
            w("* **Dockerfile-downloaded tools** — bump their version pin in the Dockerfile: "
              + "; ".join(f"`{b}` in {len(svcs)} image(s)" for b, svcs in sorted(by_bin.items())))
        dep = sorted({(svc, v["pkg"], v["path"]) for svc, v in blocking if v["path"].startswith("dependabot")})
        if dep:
            w(f"* **Dependabot scope** ({len(dep)} package(s)): "
              + ", ".join(f"`{s}:{p}`" for s, p, _ in dep[:30]) + (" …" if len(dep) > 30 else ""))
    if copa:
        w("* **Copa-patched images** (OS packages, image only — not a commit):")
        w("")
        w("  Counts are fixable OS-package findings only (what Copa changes), before → after.")
        w("")
        w("  | Service | Patched image | Copa | CRITICAL | HIGH | All fixable OS |")
        w("  |---|---|---|---|---|---|")
        for r in copa:
            b, a = r.get("os_before") or {}, r.get("os_after") or {}
            arrow = lambda k: f"{b.get(k, '—')} → {a.get(k, '—')}"
            w(f"  | {r['service']} | `{r.get('patched') or '—'}` | {r.get('status')} | {arrow('CRITICAL')} | {arrow('HIGH')} | {arrow('total')} |")
    if data["others"]:
        bad = [o for o in data["others"] if o["conclusion"] not in ("success", "skipped", "neutral")]
        w("")
        w(f"* Other checks: {len(data['others'])} ({len(bad)} not successful — reported, not gating)")
    md = "\n".join(lines) + "\n"
    open(os.path.join(OUT, "pr-security-sync.md"), "w").write(md)
    if env("GITHUB_STEP_SUMMARY"):
        open(env("GITHUB_STEP_SUMMARY"), "a").write(md)
    out(status="policy-fail" if (builds_failed or scans_failed) else "pass",
        blocking=len(blocking), builds_failed=len(builds_failed))
    if builds_failed or scans_failed:
        print(f"::error title=PR security::{len(builds_failed)} build(s) failed, {len(scans_failed)} image(s) above policy — see the summary")
        return 1
    print("✅ all builds green, all images within policy")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["collect", "patch", "decide"])
    a = ap.parse_args()
    try:
        sys.exit({"collect": collect, "patch": patch, "decide": decide}[a.cmd]())
    except (RuntimeError, TimeoutError) as e:
        print(f"::error::{e}")
        sys.exit(2)
