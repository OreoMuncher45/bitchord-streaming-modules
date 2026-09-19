"""
Validates that the module index and manifest match the BitChord module contract.

Run:  python3 test_contract.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent

for filename in ["index.json", "manifest.json"]:
    doc_path = ROOT / filename
    assert doc_path.exists(), f"File {filename} does not exist"
    data = json.loads(doc_path.read_text())

    # ── Index structure ──────────────────────────────────────────────────
    assert "category:music" in data, f"{filename} must contain 'category:music'"
    modules = data["category:music"]
    assert isinstance(modules, list), f"'category:music' in {filename} must be a list"
    assert len(modules) == 2, f"Expected 2 modules in {filename}, got {len(modules)}"

    # Addon manifest compatibility fields
    assert data.get("id"), f"{filename} missing 'id'"
    assert data.get("name"), f"{filename} missing 'name'"
    assert data.get("version"), f"{filename} missing 'version'"
    assert "resources" in data, f"{filename} missing 'resources'"

    for module in modules:
        # Required fields
        assert module.get("id"), f"Module missing 'id': {module}"
        assert module.get("name"), f"Module missing 'name': {module}"
        assert module.get("version"), f"Module missing 'version': {module}"
        assert module.get("download", "").startswith("modules/"), \
            f"download must start with 'modules/': {module['id']}"

        # Tags should be a list
        tags = module.get("tags", [])
        assert isinstance(tags, list), f"tags must be a list: {module['id']}"

        # Code field present (integer version)
        assert isinstance(module.get("code", 0), int), \
            f"code must be an integer: {module['id']}"

        # ── JS source validation ─────────────────────────────────────────
        source_path = ROOT / module["download"]
        assert source_path.exists(), f"JS source not found: {source_path}"
        source = source_path.read_text()

        # Must export the two required functions
        assert "module.exports.searchTracks" in source, \
            f"{module['id']}: missing searchTracks export"
        assert "module.exports.getTrackStreamUrl" in source, \
            f"{module['id']}: missing getTrackStreamUrl export"

        # Balanced braces and parentheses
        assert source.count("{") == source.count("}"), \
            f"{module['id']}: unbalanced braces"
        assert source.count("(") == source.count(")"), \
            f"{module['id']}: unbalanced parentheses"

        # No hardcoded credentials
        assert not re.search(
            r"(api[_-]?secret|auth[_-]?token)\s*[:=]\s*[\"'][^\"']+[\"']",
            source, re.I
        ), f"{module['id']}: contains hardcoded credentials"

        # Must use the sandbox fetch(), not XMLHttpRequest or other
        assert "XMLHttpRequest" not in source, \
            f"{module['id']}: must use fetch(), not XMLHttpRequest"

        print(f"  ✓ [{filename}] {module['id']} ({module['version']})")

print(f"\nBitChord module contract & manifest: valid in all files.")
