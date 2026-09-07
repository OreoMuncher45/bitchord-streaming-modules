import json
import pathlib
import re


ROOT = pathlib.Path(__file__).parent
index = json.loads((ROOT / "index.json").read_text())
modules = index["category:music"]
assert len(modules) == 2

for module in modules:
    assert module["id"]
    assert module["download"].startswith("modules/")
    source = (ROOT / module["download"]).read_text()
    assert "module.exports.searchTracks" in source
    assert "module.exports.getTrackStreamUrl" in source
    assert source.count("{") == source.count("}")
    assert source.count("(") == source.count(")")
    assert not re.search(r"(api[_-]?secret|auth[_-]?token)\s*[:=]\s*[\"'][^\"']+[\"']", source, re.I)

print("BitChord module contract: valid")
