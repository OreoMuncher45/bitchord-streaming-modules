# BitChord Streaming Modules

Community modules for BitChord `v1.5.2` and newer.

## Install

1. Open **BitChord > Settings > Sources**.
2. Add the raw GitHub URL for [`index.json`](./index.json).
3. BitChord detects the module index and loads the listed modules in its QuickJS sandbox.

The raw URL after publishing is:

```text
https://raw.githubusercontent.com/OWNER/REPOSITORY/main/index.json
```

## Modules

- **Monochrome / Tidal-compatible**: an adapter for the JSON routes used by the existing Echo Monochrome client. It requires no account in the default configuration, but it is an independent service and is not affiliated with Tidal. The public `monochrome.tf` web route currently serves an HTML shell to generic requests, so verify the route/API availability before enabling this module in a release build.
- **Qobuz official API**: included as a credential-driven module scaffold. Set `QOBUZ_APP_ID`, `QOBUZ_APP_SECRET`, and a user session token in a private fork or a self-hosted module. Never commit credentials to a public repository.

The Qobuz module intentionally does not implement subscription bypasses, credential harvesting, or DRM circumvention. Playback depends on a valid Qobuz account/session and the rights available to that account. Because BitChord's public module-index format does not provide a credential-settings UI, the Qobuz adapter is inert in the public index until you host it behind your own configured API gateway or extend BitChord's settings handling.

## Compatibility

The module format was verified against the current BitChord source at commit `70394304ee718d160cd25e41fbcbaef39c05b45c` (`V1.5.2`, September 6, 2026). BitChord runs each module as JavaScript and expects:

- `module.exports.searchTracks(query, limit, context)` returning `{ tracks: [...] }`
- `module.exports.getTrackStreamUrl(id, quality, context)` returning `{ streamUrl, track }`

The modules use only the sandbox-provided `fetch()` function.

## Legal and operational notes

BitChord and these modules do not host music. They request metadata and playback URLs from third-party services. Respect each service's terms, subscription requirements, rate limits, and your local law. Public service endpoints can change or disappear without notice.
