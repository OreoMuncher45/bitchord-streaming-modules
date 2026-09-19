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

### 1. Monochrome / Tidal-compatible (`monochrome-tidal`)
- **Credentialless:** Connects to public Monochrome/HiFi-API instances that hold their own sessions.
- **Failover:** Rotates through known healthy endpoints.
- **Playback Formats:** Parses both MPEG-DASH manifests (Hi-Res) and BTS base64 manifests (FLAC lossless).
- **Graceful degradation:** If an instance returns upstream errors or 503s, returns `{ streamUrl: null }` so playback never hangs.

### 2. Qobuz Official API (`qobuz-official`)
- Modular scaffold for official Qobuz API integration.
- Inert by default; activates when `qobuzApiBase`, `qobuzAppId`, and `qobuzUserAuthToken` are provided via settings.

---

## Contract Verification

Both `index.json` and `manifest.json` conform to the BitChord QuickJS and Addon specifications:

```bash
python3 test_contract.py
```
