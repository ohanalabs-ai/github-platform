"""python3 -m imgsec <command> … — the only entry point the composite actions call."""
import argparse
import os
import sys

from . import ImgsecError
from . import util


def _bool(v):
    if str(v).lower() in ("true", "1", "yes"):
        return True
    if str(v).lower() in ("false", "0", "no", ""):
        return False
    raise argparse.ArgumentTypeError(f"expected true/false, got {v!r}")


def parser():
    p = argparse.ArgumentParser(prog="imgsec")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("plan")
    s.add_argument("--platforms", default="all")
    s.add_argument("--sbom-policy", default="prefer-registry")
    s.add_argument("--severity-threshold", default="HIGH")
    s.add_argument("--ignore-unfixed", type=_bool, default=False)
    s.add_argument("--source-repository", default="")
    s.add_argument("--source-revision", default="")
    s.add_argument("--source-artifact", default="")
    s.add_argument("--root", required=True)
    s.add_argument("--out", required=True)

    s = sub.add_parser("render", help="render a sources document to one multi-document YAML file (mode 0600)")
    s.add_argument("--root", required=True)
    s.add_argument("--out", required=True)

    s = sub.add_parser("auth-select")
    s.add_argument("--plan", required=True)
    s.add_argument("--image-id", required=True)
    s.add_argument("--error-file", default="")
    s = sub.add_parser("auth-write")
    s.add_argument("--error-file", default="")
    sub.add_parser("auth-cleanup")

    s = sub.add_parser("resolve")
    s.add_argument("--plan", required=True)
    s.add_argument("--image-id", required=True)
    s.add_argument("--auth-error", default="")
    s.add_argument("--out", required=True)

    s = sub.add_parser("scan-plan")
    s.add_argument("--plan", required=True)
    s.add_argument("--resolved-dir", required=True)
    s.add_argument("--out", required=True)

    s = sub.add_parser("scan")
    s.add_argument("--plan", required=True)
    s.add_argument("--scan-plan", required=True)
    s.add_argument("--unit", required=True)
    s.add_argument("--auth-error", default="")
    s.add_argument("--out", required=True)

    s = sub.add_parser("report")
    s.add_argument("--plan", required=True)
    s.add_argument("--scan-plan", default="")
    s.add_argument("--resolved-dir", default="")
    s.add_argument("--results-dir", default="")
    s.add_argument("--out", required=True)

    s = sub.add_parser("pin")
    s.add_argument("--manifests", required=True)
    s.add_argument("--mapping", default="")
    s.add_argument("--out", required=True)
    s.add_argument("--report", default="")
    s.add_argument("--expect-json", default="")
    s.add_argument("--forbid-json", default="")
    s.add_argument("--adapters-json", default="")
    s.add_argument("--require-digest", action="store_true")
    s.add_argument("--allow-secrets", action="store_true")

    s = sub.add_parser("buildmap")
    s.add_argument("action", choices=["validate", "record", "assemble"])
    s.add_argument("--map", required=True)
    s.add_argument("--root", default=".")
    s.add_argument("--revision", default="")
    s.add_argument("--include-optional", type=_bool, default=False)
    s.add_argument("--service", default="")
    s.add_argument("--registry", default="")
    s.add_argument("--namespace", default="")
    s.add_argument("--tag", default="")
    s.add_argument("--digest", default="")
    s.add_argument("--records-dir", default="")
    s.add_argument("--kustomize-overlay", default="")
    s.add_argument("--out", default="")
    return p


def cmd_render(args):
    from . import render, yamlio
    sources = render.parse_sources(os.environ.get("IMGSEC_SOURCES", ""))
    if not sources:
        raise ImgsecError("input", "render needs IMGSEC_SOURCES")
    r = render.Renderer(os.path.realpath(args.root))
    try:
        docs = []
        for src in sources["sources"]:
            d, _ = r.render(src)
            docs += [doc for _, doc in d if doc is not None]
    finally:
        r.cleanup()
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(yamlio.dump_all(docs))
    print(f"rendered {len(docs)} document(s) → {args.out}")
    return 0


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.cmd == "plan":
            from . import plan
            return plan.main(args)
        if args.cmd == "render":
            return cmd_render(args)
        if args.cmd == "auth-select":
            from . import auth
            return auth.main_select(args)
        if args.cmd == "auth-write":
            from . import auth
            return auth.main_write(args)
        if args.cmd == "auth-cleanup":
            from . import auth
            return auth.main_cleanup(args)
        if args.cmd == "resolve":
            from . import resolve
            return resolve.main(args)
        if args.cmd == "scan-plan":
            from . import scanplan
            return scanplan.main(args)
        if args.cmd == "scan":
            from . import scan
            return scan.main(args)
        if args.cmd == "report":
            from . import report
            return report.main(args)
        if args.cmd == "pin":
            from . import pin
            return pin.main(args)
        if args.cmd == "buildmap":
            from . import buildmap
            return buildmap.main(args)
    except ImgsecError as e:
        for line in e.message.splitlines()[:30]:
            util.annotate("error", f"imgsec {args.cmd} ({e.kind}): {line}")
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
