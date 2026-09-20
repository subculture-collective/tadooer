"""Read-only verification of pinned parity references; no app data is loaded."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--mcp", type=Path, required=True)
    parser.add_argument("--installed-asar", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "docs/product/super-productivity-parity.json").read_text())
    source = manifest["source"]
    failures = []

    def check(actual, expected, label):
        if actual != expected:
            failures.append(label)

    for path, key in [(args.source, "commit"), (args.mcp, "mcpCommit")]:
        commit = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
        check(commit, source[key], key)
    check(json.loads((args.source / "package.json").read_text())["version"], source["version"], "source version")
    for name, expected in source["files"].items():
        check(digest(args.source / name), expected, name)
    features = sorted(p.name for p in (args.source / "src/app/features").iterdir() if p.is_dir())
    check(features, manifest["sourceFeatureDirectories"], "feature directory inventory")
    catalog = args.mcp / "internal/catalog/tools.json"
    check(digest(catalog), source["mcpCatalogSha256"], "MCP catalog")
    if args.installed_asar:
        check(digest(args.installed_asar), source["installedAsarSha256"], "installed artifact")
    if failures:
        raise SystemExit("Reference mismatch: " + ", ".join(failures))
    print("Pinned source, model files, feature inventory and MCP catalog verified" + ("; installed artifact verified independently" if args.installed_asar else ""))


if __name__ == "__main__":
    main()
