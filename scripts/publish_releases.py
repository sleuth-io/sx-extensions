#!/usr/bin/env python3
"""Migrate published version archives to GitHub release assets.

For every sx.toml asset entry whose source is an in-tree
.sx/versions/<name>/<version> directory: zip that directory, upload it as
<name>-<version>.zip to the rolling "downloads" release, rewrite the entry
to [assets.source-http] (download URL + sha256 + size), and remove the
in-tree archive directory (list.txt stays — sx reads the version list from
it). The latest-at-root assets/<name>/ copies stay too: the app browses
from them, so only real installs hit the release URL — that download count
is what stats.json aggregates.

Also regenerates catalog.json from assets/*/plugin.json so the app can
render the marketplace from one file instead of unpacking bundles.

Usage: publish_releases.py [--dry-run]
  --dry-run  report what would change; no uploads, no writes, no deletes
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

REPO = os.environ.get("GITHUB_REPOSITORY", "sleuth-io/sx-extensions")
TAG = "downloads"
ROOT = Path(__file__).resolve().parent.parent


def zip_dir(d: Path) -> bytes:
    """Zip a directory's contents with entries at the archive root,
    matching the layout sx produces (plugin.json addressable at root)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(d.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(d).as_posix())
    return buf.getvalue()


def ensure_release() -> None:
    view = subprocess.run(
        ["gh", "release", "view", TAG, "-R", REPO],
        capture_output=True,
    )
    if view.returncode != 0:
        subprocess.run(
            [
                "gh", "release", "create", TAG, "-R", REPO,
                "--title", "Extension downloads",
                "--notes",
                "Version archives served to sx installs. "
                "GitHub's per-asset download counts feed stats.json.",
            ],
            check=True,
        )


def migrate_archives(dry: bool) -> bool:
    manifest_path = ROOT / "sx.toml"
    manifest = manifest_path.read_text()
    doc = tomllib.loads(manifest)
    changed = False
    for a in doc.get("assets", []):
        sp = a.get("source-path")
        if not sp:
            continue
        rel = sp["path"]
        if not rel.startswith(".sx/versions/"):
            continue
        vdir = ROOT / rel
        if not vdir.is_dir():
            print(f"WARN: {rel} missing on disk; skipping", file=sys.stderr)
            continue
        name, version = a["name"], a["version"]
        asset_file = f"{name}-{version}.zip"
        data = zip_dir(vdir)
        sha = hashlib.sha256(data).hexdigest()
        url = f"https://github.com/{REPO}/releases/download/{TAG}/{asset_file}"

        # The manifest is machine-written with a stable shape, so a
        # targeted textual replace keeps the diff to exactly the migrated
        # lines. Refuse to guess if the block isn't found verbatim.
        old = (
            f'[[assets]]\n'
            f'  name = "{name}"\n'
            f'  version = "{version}"\n'
            f'  type = "{a["type"]}"\n'
            f'  [assets.source-path]\n'
            f'    path = "{rel}"'
        )
        new = (
            f'[[assets]]\n'
            f'  name = "{name}"\n'
            f'  version = "{version}"\n'
            f'  type = "{a["type"]}"\n'
            f'  [assets.source-http]\n'
            f'    url = "{url}"\n'
            f'    size = {len(data)}\n'
            f'    hashes = {{sha256 = "{sha}"}}'
        )
        if old not in manifest:
            print(
                f"ERROR: manifest block for {name}@{version} not in the "
                f"expected shape; refusing to rewrite",
                file=sys.stderr,
            )
            sys.exit(1)

        if not dry:
            tmp = ROOT / asset_file
            tmp.write_bytes(data)
            try:
                ensure_release()
                subprocess.run(
                    ["gh", "release", "upload", TAG, str(tmp), "-R", REPO, "--clobber"],
                    check=True,
                )
            finally:
                tmp.unlink()
            manifest = manifest.replace(old, new)
            shutil.rmtree(vdir)
        else:
            manifest = manifest.replace(old, new)
        changed = True
        print(f"migrated {name}@{version} -> {asset_file} ({len(data)} bytes)")

    if changed:
        tomllib.loads(manifest)  # the rewritten manifest must still parse
        if not dry:
            manifest_path.write_text(manifest)
    return changed


def write_catalog(dry: bool) -> bool:
    exts = []
    for pj in sorted((ROOT / "assets").glob("*/plugin.json")):
        pm = json.loads(pj.read_text())
        exts.append(
            {
                "assetName": pj.parent.name,
                "id": pm.get("id", ""),
                "name": pm.get("name", ""),
                "version": pm.get("version", ""),
                "description": pm.get("description", ""),
                "author": pm.get("author", ""),
                "permissions": pm.get("permissions", []),
            }
        )
    rendered = json.dumps({"extensions": exts}, indent=2) + "\n"
    path = ROOT / "catalog.json"
    if path.exists() and path.read_text() == rendered:
        return False
    print(f"catalog.json: {len(exts)} extensions")
    if not dry:
        path.write_text(rendered)
    return True


def main() -> None:
    dry = "--dry-run" in sys.argv
    migrated = migrate_archives(dry)
    catalog = write_catalog(dry)
    if dry:
        print(f"(dry run{'' if migrated or catalog else ': nothing to do'})")


if __name__ == "__main__":
    main()
