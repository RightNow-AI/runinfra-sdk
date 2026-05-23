#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
import tarfile
import zipfile
from pathlib import Path


FORBIDDEN_PARTS = {
    ".env",
    "__pycache__",
    "build",
    "dist",
    "tests",
}

FORBIDDEN_SUFFIXES = (
    ".map",
    ".pyc",
    ".pyo",
)

FORBIDDEN_CONTENT_RE = re.compile(
    r"C:\\Users\\jaber|RightNow-Full|BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY|"
    r"npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{40,}|ghp_[A-Za-z0-9_]{20,}|"
    r"sk-ri-[A-Za-z0-9_-]{20,}|sourceMappingURL|sourcesContent|webpack://|\\.npmrc",
    re.IGNORECASE,
)

SDIST_ALLOWED = {
    "CHANGELOG.md",
    "LICENSE",
    "MANIFEST.in",
    "PKG-INFO",
    "README.md",
    "pyproject.toml",
    "setup.cfg",
    "runinfra/__init__.py",
    "runinfra/py.typed",
    "runinfra.egg-info/PKG-INFO",
    "runinfra.egg-info/SOURCES.txt",
    "runinfra.egg-info/dependency_links.txt",
    "runinfra.egg-info/top_level.txt",
}

WHEEL_ALLOWED_FIXED = {
    "runinfra/__init__.py",
    "runinfra/py.typed",
}

WHEEL_DIST_INFO_RE = re.compile(
    r"^runinfra-[^/]+\.dist-info/(METADATA|RECORD|WHEEL|top_level\.txt|licenses/LICENSE)$"
)


def normalize(path: str) -> str:
    return path.replace("\\", "/").strip("/")


def has_forbidden_path(path: str) -> bool:
    normalized = normalize(path)
    parts = set(normalized.split("/"))
    return bool(parts & FORBIDDEN_PARTS) or normalized.endswith(FORBIDDEN_SUFFIXES)


def fail(label: str, messages: list[str]) -> None:
    print(f"{label} verification failed", file=sys.stderr)
    for message in messages:
        print(message, file=sys.stderr)
    raise SystemExit(1)


def has_forbidden_content(content: bytes) -> bool:
    try:
        decoded = content.decode("utf-8")
    except UnicodeDecodeError:
        decoded = content.decode("utf-8", errors="ignore")
    return FORBIDDEN_CONTENT_RE.search(decoded) is not None


def verify_wheel(path: Path) -> None:
    with zipfile.ZipFile(path) as wheel:
        names = sorted(name for name in wheel.namelist() if not name.endswith("/"))
        files = [normalize(name) for name in names]
        forbidden_content = sorted(
            normalize(name)
            for name in names
            if has_forbidden_content(wheel.read(name))
        )

    missing = sorted(file for file in WHEEL_ALLOWED_FIXED if file not in files)
    unexpected = sorted(
        file
        for file in files
        if file not in WHEEL_ALLOWED_FIXED and WHEEL_DIST_INFO_RE.fullmatch(file) is None
    )
    forbidden = sorted(file for file in files if has_forbidden_path(file))

    errors: list[str] = []
    if missing:
        errors.append("Missing files:\n" + "\n".join(missing))
    if unexpected:
        errors.append("Unexpected files:\n" + "\n".join(unexpected))
    if forbidden:
        errors.append("Forbidden files:\n" + "\n".join(forbidden))
    if forbidden_content:
        errors.append("Forbidden content:\n" + "\n".join(forbidden_content))
    if errors:
        fail(str(path), errors)

    print(f"Verified Python wheel contents: {path}")


def strip_sdist_root(path: str) -> str:
    normalized = normalize(path)
    parts = normalized.split("/", 1)
    return parts[1] if len(parts) == 2 else ""


def verify_sdist(path: Path) -> None:
    with tarfile.open(path) as sdist:
        members = sorted((member for member in sdist.getmembers() if member.isfile()), key=lambda item: item.name)
        files = [strip_sdist_root(member.name) for member in members]
        forbidden_content = []
        for member in members:
            extracted = sdist.extractfile(member)
            if extracted is not None and has_forbidden_content(extracted.read()):
                forbidden_content.append(strip_sdist_root(member.name))

    files = [file for file in files if file]
    forbidden_content = sorted(file for file in forbidden_content if file)
    missing = sorted(file for file in SDIST_ALLOWED if file not in files)
    unexpected = sorted(file for file in files if file not in SDIST_ALLOWED)
    forbidden = sorted(file for file in files if has_forbidden_path(file))

    errors: list[str] = []
    if missing:
        errors.append("Missing files:\n" + "\n".join(missing))
    if unexpected:
        errors.append("Unexpected files:\n" + "\n".join(unexpected))
    if forbidden:
        errors.append("Forbidden files:\n" + "\n".join(forbidden))
    if forbidden_content:
        errors.append("Forbidden content:\n" + "\n".join(forbidden_content))
    if errors:
        fail(str(path), errors)

    print(f"Verified Python sdist contents: {path}")


def resolve_inputs(args: list[str]) -> list[Path]:
    if not args:
        args = ["dist"]

    resolved: list[Path] = []
    for arg in args:
        path = Path(arg)
        if path.is_dir():
            wheels = sorted(path.glob("runinfra-*.whl"))
            sdists = sorted(path.glob("runinfra-*.tar.gz"))
            if not wheels or not sdists:
                fail(
                    str(path),
                    ["Expected at least one runinfra-*.whl and one runinfra-*.tar.gz file."],
                )
            resolved.extend(wheels)
            resolved.extend(sdists)
        else:
            resolved.append(path)
    return resolved


def main() -> None:
    paths = resolve_inputs(sys.argv[1:])
    if not paths:
        fail("Python package", ["No wheel or sdist files found."])

    for path in paths:
        if path.suffix == ".whl":
            verify_wheel(path)
        elif path.name.endswith(".tar.gz"):
            verify_sdist(path)
        else:
            fail(str(path), ["Expected a .whl or .tar.gz file."])


if __name__ == "__main__":
    main()
