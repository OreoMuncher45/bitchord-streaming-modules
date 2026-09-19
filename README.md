# BitChord Streaming Modules

Community modules for [BitChord](https://github.com/kushagrasinghx/BitChord) `v1.5.2` and newer.

## Install

1. Open **BitChord > Settings > Sources**.
2. Add this raw GitHub URL for [`index.json`](./index.json):

   <https://raw.githubusercontent.com/OreoMuncher45/bitchord-streaming-modules/main/index.json>

3. BitChord detects the module index and loads the listed modules in its QuickJS sandbox.

The public repository is available at <https://github.com/OreoMuncher45/bitchord-streaming-modules>.

## Modules

### Monochrome / Tidal-compatible

An adapter for Monochrome/HiFi-API instances that expose Tidal's catalogue without requiring the user's own Tidal credentials. The API instance holds its own session.

**Features:**
- Automatic failover across multiple API instances
- Handles both `/trackManifests/` (v2.5+) and `/track/` endpoints
- Supports DASH manifests (Hi-Res) and BTS JSON manifests (CD lossless)
- Reports full track metadata (bitDepth, sampleRate, mimeType) to BitChord
- Handles 202 queue responses from busy instances
- Graceful degradation when all instances are down

**API instances:** The module ships with known public instances. To prefer your own self-hosted hifi-api instance, set `monochromeApiUrl` in the module settings.

> **Note:** Public Monochrome/HiFi-API instances are community-operated and can go offline without notice. As of September 2026, most of the original qqdl.site fleet is offline and some instances report "Upstream API error" on playback endpoints. Search continues to work. If playback fails, the module returns `streamUrl: null` and BitChord falls back to YouTube Music.

### Qobuz Official API

A credential-driven adapter for the Qobuz streaming API. This module is a scaffold — it is intentionally inert in the public index until configured with valid credentials.

**Required settings** (configure via a private fork or self-hosted gateway):
- `qobuzApiBase` — e.g. `https://www.qobuz.com/api.json/0.2`
- `qobuzAppId` — Qobuz application ID
- `qobuzUserAuthToken` — User session token

This module does **not** implement subscription bypasses, credential harvesting, or DRM circumvention. Playback depends on a valid Qobuz account and the rights available to that account.

## How it works

BitChord's module system calls two JavaScript exports:

1. **`searchTracks(query, limit, context)`** → `{ tracks: [...], total: N }`
2. **`getTrackStreamUrl(id, quality, context)`** → `{ streamUrl: "...", track: { ... } }`

When you play music in BitChord (including playlists), the app's `SourceResolver` substitutes each track individually — it searches the module for a matching track and, if found, fetches its stream URL. **Playlist browsing** (viewing a Tidal/Qobuz playlist directly) is not supported by the module interface; the modules work by matching individual tracks.

The `quality` parameter uses BitChord's tier names: `LOSSLESS`, `HIGH`, or `LOW`. Modules map these to each service's own quality system internally.

## Compatibility

The module format was verified against the current BitChord source at commit `70394304ee718d160cd25e41fbcbaef39c05b45c` (`V1.5.2`, September 6, 2026). The modules use only the sandbox-provided `fetch()` function and standard JavaScript.

**Key BitChord expectations:**
- Modules are wrapped in an IIFE that assigns to `module.exports`
- `fetch()` is provided by BitChord's QuickJS sandbox (synchronous `.json()` and `.text()` methods)
- The `context` argument carries `context.settings.<key>.value` for module configuration
- `atob()` is polyfilled by BitChord for base64 decoding
- Returning `{ streamUrl: null }` signals "unavailable" and triggers YouTube fallback

## Legal and operational notes

BitChord and these modules do not host music. They request metadata and playback URLs from third-party services. Respect each service's terms, subscription requirements, rate limits, and your local law. Public service endpoints can change or disappear without notice.
