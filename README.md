# BitChord Streaming Modules

Credentialless Tidal and Qobuz streaming modules for [BitChord](https://github.com/kushagrasinghx/BitChord) (`v1.5.2` and newer).

---

## ⚠️ Important: How to Add in BitChord

When adding a custom source in **BitChord > Settings > Sources**, you **MUST** use a **raw JSON URL**.

### ✅ Working URLs (Copy one of these into BitChord):

- **Direct Raw URL (Recommended):**
  ```text
  https://raw.githubusercontent.com/OreoMuncher45/bitchord-streaming-modules/main/index.json
  ```
- **Alternative (manifest.json format):**
  ```text
  https://raw.githubusercontent.com/OreoMuncher45/bitchord-streaming-modules/main/manifest.json
  ```
- **CDN Mirror (jsDelivr):**
  ```text
  https://cdn.jsdelivr.net/gh/OreoMuncher45/bitchord-streaming-modules@main/index.json
  ```

---

### ❌ Why `github.com` URLs cause "Unrecognised JSON — it holds meta, payload"

If you paste:
- `https://github.com/OreoMuncher45/bitchord-streaming-modules`
- `https://github.com/OreoMuncher45/bitchord-streaming-modules/blob/main/index.json`
- `https://github.com/OreoMuncher45/bitchord-streaming-modules/blob/main/manifest.json`

BitChord sends an HTTP request with `Accept: application/json`. GitHub responds with its internal web-app React SPA state instead of raw file contents:
```json
{
  "meta": { ... },
  "payload": { ... }
}
```
BitChord inspects the keys (`meta`, `payload`) and rejects it with:
> `Unrecognised JSON — it holds meta, payload` (from `SourceFormats.kt:193`)

Using `raw.githubusercontent.com` returns the actual JSON payload with `"category:music"` and manifest descriptors, allowing BitChord to correctly identify and load the modules.

---

## How BitChord Handles Playlists

BitChord does not browse external Tidal/Qobuz playlists natively. Instead, BitChord integrates streaming modules via **track substitution**:
1. When you play an album, playlist, radio station, or search result from YouTube Music, BitChord's `SourceResolver.substituteForYouTube()` checks your active sources.
2. If your custom module is ranked above YouTube (default rank 0 vs YouTube rank 3), BitChord calls `module.exports.searchTracks()` for the track's artist and title.
3. `TrackMatcher` validates whether the candidate is a genuine match.
4. BitChord calls `module.exports.getTrackStreamUrl()` to retrieve the lossless stream.
5. If the module returns a valid stream, BitChord plays the Tidal/Qobuz stream bit-exact; if unavailable or missing, it seamlessly falls back to YouTube Music.

---

## Included Modules

### 1. Tidal FLAC via tracks.monochrome.st (`bitchord-tidal-flac`)
- **Credentialless:** Public read-only Tidal index. No account, no token.
- **Stream:** Direct `/track/{id}?quality=LOSSLESS` proxy URL, claimed only after a 4-byte `fLaC` Range-probe check.
- **Timeouts:** 6s search / 6s probe, retried only on fast 5xx — timeouts fail fast so one slow link never becomes a 30s upgrade.
- **Holds:** Studio masters, including niche shoegaze (Pure Hex studio, Porch Light band, Whirr, Glixen, Fleshwater — verified Oct 2026).

### 2. Internet Archive FLAC (`archive-flac`)
- **Credentialless:** Public `advancedsearch.php` + `metadata/{id}` + `/download/{id}/{file}`. No account, no token.
- **Stream:** Direct `archive.org/download` URL, same 4-byte `fLaC` check. Range probes answer in ~0.4s vs ~3.8s for the Tidal proxy.
- **Search:** One query + parallel fan-out over 4 items (~1.5-4.7s measured). Free-text relevance ranking — fielded queries go to zero on "Artist Title" flat strings.
- **Holds:** Live tapes and bootlegs Tidal never will (Pure Hex 2022-2023 SF lives incl. "02 Still Dark", Slowdive 1993-2023 lives). Studio Porch Light is a Tidal-only miss here — by design the two modules race and cover each other.
- **App fit:** BitChord races every module in the index at once (`ModuleSource` 8s live / 25s patient budgets, round-robin interleave). Two hosts failing differently beats one host retried: when Tidal hangs past 10s, Archive wins the live budget, and vice versa.

---

## Contract Verification

Both `index.json` and `manifest.json` conform to the BitChord QuickJS and Addon specifications:

```bash
python3 test_contract.py
```
