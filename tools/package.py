"""把扩展打成可以直接解压安装的压缩包：out/gbfroge.zip（里面是一个 gbfroge 文件夹）。

用法：python tools/package.py
测试文件和开发用脚本不打进去。
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "arcarum3-ext"
OUTPUT = ROOT / "out" / "gbfroge.zip"
FOLDER = "gbfroge"

SKIP_SUFFIXES = {".py", ".pyc", ".log"}
SKIP_NAMES = {"Thumbs.db", ".DS_Store", "README.md"}


def wanted(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.name in SKIP_NAMES or path.suffix in SKIP_SUFFIXES:
        return False
    if path.name.startswith("test_") and path.suffix == ".mjs":
        return False
    if "__pycache__" in path.parts:
        return False
    return True


def main() -> int:
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    files = sorted(path for path in SOURCE.rglob("*") if wanted(path))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            archive.write(path, f"{FOLDER}/{path.relative_to(SOURCE).as_posix()}")
    size = OUTPUT.stat().st_size / 1024
    print(f"{manifest['name']} {manifest['version']}: {len(files)} files, {size:.0f} KB -> {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
