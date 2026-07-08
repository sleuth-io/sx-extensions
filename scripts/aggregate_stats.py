#!/usr/bin/env python3
"""Aggregate release-asset download counts into stats.json.

Every install of an extension downloads its <name>-<version>.zip release
asset (the manifest's source-http URL), so GitHub's per-asset
download_count is the install counter — anonymous and free, the same way
Obsidian counts community-plugin downloads. This sums the counts across
versions per extension and writes stats.json at the repo root, which the
sx app reads (already cloned) to show counts and a "Most installed" sort.

Usage: aggregate_stats.py [--dry-run]
"""

import json
import os
import subprocess
import sys
from pathlib import Path

REPO = os.environ.get("GITHUB_REPOSITORY", "sleuth-io/sx-extensions")
ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    dry = "--dry-run" in sys.argv
    out = subprocess.run(
        [
            "gh", "api", f"repos/{REPO}/releases", "--paginate",
            "--jq", '.[].assets[] | [.name, (.download_count | tostring)] | @tsv',
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    installs: dict[str, int] = {}
    for line in out.stdout.splitlines():
        fname, _, count = line.strip().partition("\t")
        if not fname.endswith(".zip") or not count:
            continue
        # <name>-<version>.zip; vault versions carry no dashes.
        stem, _, _version = fname[: -len(".zip")].rpartition("-")
        if not stem:
            continue
        installs[stem] = installs.get(stem, 0) + int(count)

    rendered = (
        json.dumps(
            {name: {"installs": n} for name, n in sorted(installs.items())},
            indent=2,
        )
        + "\n"
    )
    path = ROOT / "stats.json"
    if path.exists() and path.read_text() == rendered:
        print("stats.json unchanged")
        return
    print(f"stats.json: {len(installs)} extensions, {sum(installs.values())} installs")
    if dry:
        print(rendered)
        return
    path.write_text(rendered)


if __name__ == "__main__":
    main()
