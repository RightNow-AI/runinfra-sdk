#!/usr/bin/env python3
from __future__ import annotations

import base64
import csv
import hashlib
import io
import re
import stat
import sys
import tarfile
import zipfile
from email.parser import Parser
from pathlib import Path
from typing import Optional


FORBIDDEN_PARTS = {
    ".env",
    ".netrc",
    ".pypirc",
    "__pycache__",
    "build",
    "dist",
    "pip.conf",
    "pip.ini",
    "tests",
}

FORBIDDEN_SUFFIXES = (
    ".map",
    ".pyc",
    ".pyo",
)

FORBIDDEN_CONTENT_RE = re.compile(
    r"\b[A-Z]:\\Users\\[^\\\s\"'<>]+|/Users/[^/\s\"'<>]+|/home/[^/\s\"'<>]+|"
    r"RightNow-Full|BEGIN (?:(?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)|"
    r"npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{40,}|"
    r"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{22,})|"
    r"(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|"
    r"whsec_[A-Za-z0-9]{20,}|"
    r"eyJ[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}|"
    r"sk-ri-[A-Za-z0-9_-]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|"
    r"AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,}|"
    r"sourceMappingURL|sourceURL|sourcesContent|webpack://|"
    r"(?:^|\n)\s*(?://[^\s=]+/:_authToken|_authToken)\s*=|"
    r"(?:^|\n)\s*\[(?:pypi|distutils|server-login)\][\s\S]{0,800}(?:^|\n)\s*(?:username|password)\s*=|"
    r"(?:^|\n)\s*machine\s+\S+[\s\S]{0,400}\b(?:login|password)\s+\S+|"
    r"(?:^|\n)\s*(?:index-url|extra-index-url)\s*=\s*https?://[^/\s:@]+:[^@\s]+@|"
    r"(?:^|[\\/])\.env(?:\.[A-Za-z0-9_-]+)?(?:$|[\\/\s\"'<>])",
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
SDIST_SOURCES_EXPECTED = SDIST_ALLOWED - {"PKG-INFO", "setup.cfg"}

WHEEL_ALLOWED_FIXED = {
    "runinfra/__init__.py",
    "runinfra/py.typed",
}

WHEEL_DIST_INFO_RE = re.compile(
    r"^runinfra-[^/]+\.dist-info/(METADATA|RECORD|WHEEL|top_level\.txt|licenses/LICENSE)$"
)
INIT_VERSION_RE = re.compile(r"^__version__\s*=\s*[\"']([^\"']+)[\"']", re.MULTILINE)
REPO_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_NAME = "runinfra"


def read_expected_version() -> str:
    pyproject = REPO_ROOT.joinpath("python", "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r"(?m)^version\s*=\s*[\"']([^\"']+)[\"']", pyproject)
    if match is None:
        raise RuntimeError("Could not read project version from python/pyproject.toml.")
    return match.group(1)


EXPECTED_VERSION = read_expected_version()


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


def decode_text(content: bytes) -> str:
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("utf-8", errors="replace")


def has_forbidden_content(content: bytes) -> bool:
    return FORBIDDEN_CONTENT_RE.search(decode_text(content)) is not None


def duplicate_files(files: list[str]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for file in files:
        if file in seen:
            duplicates.add(file)
        seen.add(file)
    return sorted(duplicates)


def zip_info_is_regular_file(info: zipfile.ZipInfo) -> bool:
    mode = info.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    return file_type in (0, stat.S_IFREG)


def core_metadata_errors(label: str, content: Optional[bytes]) -> list[str]:
    if content is None:
        return [f"{label} is missing"]
    metadata = Parser().parsestr(decode_text(content))
    errors: list[str] = []
    if metadata.get("Name") != EXPECTED_NAME:
        errors.append(f"{label} Name must be {EXPECTED_NAME}")
    if metadata.get("Version") != EXPECTED_VERSION:
        errors.append(f"{label} Version must be {EXPECTED_VERSION}")
    if metadata.get_all("Requires-Dist", []):
        errors.append(f"{label} must not declare Requires-Dist runtime dependencies")
    return errors


def init_version_errors(label: str, content: Optional[bytes]) -> list[str]:
    if content is None:
        return [f"{label} is missing"]
    match = INIT_VERSION_RE.search(decode_text(content))
    if match is None:
        return [f"{label} must define __version__ = \"{EXPECTED_VERSION}\""]
    if match.group(1) != EXPECTED_VERSION:
        return [f"{label} __version__ must be {EXPECTED_VERSION}"]
    return []


def wheel_metadata_errors(files: list[str], contents: dict[str, bytes]) -> list[str]:
    errors: list[str] = []
    expected_prefix = f"{EXPECTED_NAME}-{EXPECTED_VERSION}.dist-info/"
    wrong_dist_info = sorted(
        file for file in files if ".dist-info/" in file and not file.startswith(expected_prefix)
    )
    if wrong_dist_info:
        errors.append(
            f"Wheel dist-info directory must be {expected_prefix.rstrip('/')}\n"
            + "\n".join(wrong_dist_info)
        )

    metadata_files = sorted(file for file in files if file.endswith(".dist-info/METADATA"))
    if len(metadata_files) != 1:
        errors.append("Wheel must contain exactly one dist-info METADATA file")
    elif metadata_files[0] != f"{expected_prefix}METADATA":
        errors.append(f"Wheel METADATA path must be {expected_prefix}METADATA")
    if metadata_files:
        errors.extend(core_metadata_errors("Wheel METADATA", contents.get(metadata_files[0])))
    wheel_metadata_file = f"{expected_prefix}WHEEL"
    wheel_metadata = contents.get(wheel_metadata_file)
    if wheel_metadata is None:
        errors.append(f"Wheel metadata file must be {wheel_metadata_file}")
    else:
        metadata = Parser().parsestr(decode_text(wheel_metadata))
        if metadata.get("Root-Is-Purelib") != "true":
            errors.append("Wheel WHEEL Root-Is-Purelib must be true")
        if metadata.get_all("Tag", []) != ["py3-none-any"]:
            errors.append("Wheel WHEEL must declare exactly Tag: py3-none-any")

    top_level_file = f"{expected_prefix}top_level.txt"
    top_level = contents.get(top_level_file)
    if top_level is None:
        errors.append(f"Wheel top-level metadata file must be {top_level_file}")
    else:
        top_level_names = [line.strip() for line in decode_text(top_level).splitlines() if line.strip()]
        if top_level_names != [EXPECTED_NAME]:
            errors.append("Wheel top_level.txt must contain only runinfra")
    errors.extend(init_version_errors("wheel runinfra/__init__.py", contents.get("runinfra/__init__.py")))
    return errors


def wheel_record_errors(files: list[str], contents: dict[str, bytes]) -> list[str]:
    expected_prefix = f"{EXPECTED_NAME}-{EXPECTED_VERSION}.dist-info/"
    record_file = f"{expected_prefix}RECORD"
    record_content = contents.get(record_file)
    if record_content is None:
        return [f"Wheel RECORD file must be {record_file}"]

    errors: list[str] = []
    rows: list[tuple[str, str, str]] = []
    try:
        parsed_rows = csv.reader(io.StringIO(decode_text(record_content), newline=""))
        for line_number, row in enumerate(parsed_rows, start=1):
            if len(row) != 3:
                errors.append(f"Wheel RECORD line {line_number} must contain exactly 3 fields")
                continue
            rows.append((normalize(row[0]), row[1], row[2]))
    except csv.Error as error:
        return [f"Wheel RECORD must be valid CSV: {error}"]

    record_files = [row[0] for row in rows]
    duplicate_record_files = duplicate_files(record_files)
    if duplicate_record_files:
        errors.append("Wheel RECORD must not contain duplicate file rows:\n" + "\n".join(duplicate_record_files))

    archive_files = sorted(files)
    sorted_record_files = sorted(record_files)
    missing = sorted(file for file in archive_files if file not in record_files)
    unexpected = sorted(file for file in record_files if file not in files)
    if missing:
        errors.append("Wheel RECORD is missing archive files:\n" + "\n".join(missing))
    if unexpected:
        errors.append("Wheel RECORD lists files not present in the archive:\n" + "\n".join(unexpected))
    if not missing and not unexpected and sorted_record_files != archive_files:
        errors.append("Wheel RECORD files must exactly match archive files")

    for file, hash_value, size_value in rows:
        content = contents.get(file)
        if content is None:
            continue
        if file == record_file:
            if hash_value or size_value:
                errors.append("Wheel RECORD self row must leave hash and size empty")
            continue
        if not hash_value.startswith("sha256="):
            errors.append(f"Wheel RECORD {file} must use a sha256 hash")
        else:
            expected_hash = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).decode("ascii").rstrip("=")
            actual_hash = hash_value.removeprefix("sha256=")
            if actual_hash != expected_hash:
                errors.append(f"Wheel RECORD {file} sha256 hash mismatch")
        if not size_value.isdecimal():
            errors.append(f"Wheel RECORD {file} size must be a decimal byte count")
        elif int(size_value) != len(content):
            errors.append(f"Wheel RECORD {file} size mismatch")

    return errors


def sdist_metadata_errors(root_names: set[str], contents: dict[str, bytes]) -> list[str]:
    errors: list[str] = []
    expected_root = f"{EXPECTED_NAME}-{EXPECTED_VERSION}"
    if root_names != {expected_root}:
        errors.append(
            f"sdist root directory must be exactly {expected_root}\n"
            + "\n".join(sorted(root_names or {"<empty archive>"}))
        )
    errors.extend(core_metadata_errors("PKG-INFO", contents.get("PKG-INFO")))
    errors.extend(
        core_metadata_errors(
            "runinfra.egg-info/PKG-INFO",
            contents.get("runinfra.egg-info/PKG-INFO"),
        )
    )
    errors.extend(init_version_errors("sdist runinfra/__init__.py", contents.get("runinfra/__init__.py")))
    return errors


def sdist_sources_errors(files: list[str], contents: dict[str, bytes]) -> list[str]:
    sources_content = contents.get("runinfra.egg-info/SOURCES.txt")
    if sources_content is None:
        return ["runinfra.egg-info/SOURCES.txt is missing"]

    listed = [normalize(line) for line in decode_text(sources_content).splitlines() if line.strip()]
    errors: list[str] = []
    duplicates = duplicate_files(listed)
    if duplicates:
        errors.append("SOURCES.txt must not contain duplicate file rows:\n" + "\n".join(duplicates))

    expected_sources = sorted(SDIST_SOURCES_EXPECTED)
    listed_sources = sorted(listed)
    missing_sources = sorted(file for file in expected_sources if file not in listed)
    unexpected_sources = sorted(file for file in listed_sources if file not in SDIST_SOURCES_EXPECTED)
    absent_from_archive = sorted(file for file in listed_sources if file not in files)
    if missing_sources:
        errors.append("SOURCES.txt is missing expected source files:\n" + "\n".join(missing_sources))
    if unexpected_sources:
        errors.append("SOURCES.txt lists unexpected source files:\n" + "\n".join(unexpected_sources))
    if absent_from_archive:
        errors.append("SOURCES.txt lists files not present in the sdist archive:\n" + "\n".join(absent_from_archive))
    if not missing_sources and not unexpected_sources and not absent_from_archive and listed_sources != expected_sources:
        errors.append("SOURCES.txt files must exactly match the expected sdist source file set")
    return errors


def verify_wheel(path: Path) -> None:
    with zipfile.ZipFile(path) as wheel:
        infos = sorted((info for info in wheel.infolist() if not info.is_dir()), key=lambda item: item.filename)
        files = [normalize(info.filename) for info in infos]
        contents: dict[str, bytes] = {}
        non_regular = sorted(
            normalize(info.filename)
            for info in infos
            if not zip_info_is_regular_file(info)
        )
        forbidden_content = []
        for info in infos:
            file = normalize(info.filename)
            if not zip_info_is_regular_file(info):
                continue
            content = wheel.read(info.filename)
            contents[file] = content
            if has_forbidden_content(content):
                forbidden_content.append(file)

    missing = sorted(file for file in WHEEL_ALLOWED_FIXED if file not in files)
    duplicates = duplicate_files(files)
    unexpected = sorted(
        file
        for file in files
        if file not in WHEEL_ALLOWED_FIXED and WHEEL_DIST_INFO_RE.fullmatch(file) is None
    )
    forbidden = sorted(file for file in files if has_forbidden_path(file))
    invalid_metadata = wheel_metadata_errors(files, contents)
    invalid_record = wheel_record_errors(files, contents)

    errors: list[str] = []
    if missing:
        errors.append("Missing files:\n" + "\n".join(missing))
    if duplicates:
        errors.append("Duplicate files:\n" + "\n".join(duplicates))
    if non_regular:
        errors.append("Non-regular files:\n" + "\n".join(non_regular))
    if unexpected:
        errors.append("Unexpected files:\n" + "\n".join(unexpected))
    if forbidden:
        errors.append("Forbidden files:\n" + "\n".join(forbidden))
    if forbidden_content:
        errors.append("Forbidden content:\n" + "\n".join(sorted(forbidden_content)))
    if invalid_metadata:
        errors.append("Invalid metadata:\n" + "\n".join(invalid_metadata))
    if invalid_record:
        errors.append("Invalid RECORD:\n" + "\n".join(invalid_record))
    if errors:
        fail(str(path), errors)

    print(f"Verified Python wheel contents: {path}")


def strip_sdist_root(path: str) -> str:
    normalized = normalize(path)
    parts = normalized.split("/", 1)
    return parts[1] if len(parts) == 2 else f"<archive-root>/{normalized}"


def sdist_root_names(paths: list[str]) -> set[str]:
    root_names: set[str] = set()
    for path in paths:
        normalized = path.replace("\\", "/")
        if not normalized.strip("/"):
            continue
        if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
            root_names.add(f"<absolute>/{normalize(path)}")
            continue
        root_names.add(normalized.split("/", 1)[0])
    return root_names


def verify_sdist(path: Path) -> None:
    with tarfile.open(path) as sdist:
        members = sorted(sdist.getmembers(), key=lambda item: item.name)
        root_names = sdist_root_names([member.name for member in members])
        file_members = [member for member in members if member.isfile()]
        files = [strip_sdist_root(member.name) for member in file_members]
        contents: dict[str, bytes] = {}
        non_regular = sorted(
            strip_sdist_root(member.name)
            for member in members
            if not member.isfile() and not member.isdir()
        )
        forbidden_content = []
        for member in file_members:
            extracted = sdist.extractfile(member)
            if extracted is None:
                continue
            file = strip_sdist_root(member.name)
            content = extracted.read()
            if has_forbidden_content(content):
                forbidden_content.append(file)
            if file in {"PKG-INFO", "runinfra.egg-info/PKG-INFO", "runinfra.egg-info/SOURCES.txt", "runinfra/__init__.py"}:
                contents[file] = content

    files = [file for file in files if file]
    non_regular = [file for file in non_regular if file]
    forbidden_content = sorted(file for file in forbidden_content if file)
    missing = sorted(file for file in SDIST_ALLOWED if file not in files)
    duplicates = duplicate_files(files)
    unexpected = sorted(file for file in files if file not in SDIST_ALLOWED)
    forbidden = sorted(file for file in files if has_forbidden_path(file))
    invalid_metadata = sdist_metadata_errors(root_names, contents)
    invalid_sources = sdist_sources_errors(files, contents)

    errors: list[str] = []
    if missing:
        errors.append("Missing files:\n" + "\n".join(missing))
    if duplicates:
        errors.append("Duplicate files:\n" + "\n".join(duplicates))
    if non_regular:
        errors.append("Non-regular files:\n" + "\n".join(non_regular))
    if unexpected:
        errors.append("Unexpected files:\n" + "\n".join(unexpected))
    if forbidden:
        errors.append("Forbidden files:\n" + "\n".join(forbidden))
    if forbidden_content:
        errors.append("Forbidden content:\n" + "\n".join(forbidden_content))
    if invalid_metadata:
        errors.append("Invalid metadata:\n" + "\n".join(invalid_metadata))
    if invalid_sources:
        errors.append("Invalid SOURCES.txt:\n" + "\n".join(invalid_sources))
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
