/*
 * BitChord module – Qobuz Official API adapter (v0.2.0)
 *
 * Credential-driven Qobuz integration scaffold.
 *
 * This module is intentionally inert without configuration. It requires
 * three settings to be supplied by a private host or gateway:
 *   - qobuzApiBase    (e.g. "https://www.qobuz.com/api.json/0.2")
 *   - qobuzAppId      (Qobuz application ID)
 *   - qobuzUserAuthToken (user session token)
 *
 * Never commit credentials to a public repository.
 *
 * Tested against BitChord V1.5.2 module contract:
 *   module.exports.searchTracks(query, limit, context) → { tracks, total }
 *   module.exports.getTrackStreamUrl(id, quality, context) → { streamUrl, track }
 */
(function () {

  /* ── Settings helpers ──────────────────────────────────────────────── */

  /**
   * Read a setting value from the BitChord module context.
   *
   * BitChord sends context.settings as:
   *   { "key": { "value": "..." } }
   *
   * Handle both the wrapped and unwrapped shapes for resilience.
   */
  function setting(context, key) {
    if (!context || !context.settings) return "";
    var entry = context.settings[key];
    if (entry == null) return "";
    if (typeof entry === "object" && entry.value != null) {
      return String(entry.value);
    }
    if (typeof entry === "string") return entry;
    return "";
  }

  /**
   * Whether all three required credentials are configured.
   */
  function configured(context) {
    return !!(
      setting(context, "qobuzApiBase") &&
      setting(context, "qobuzAppId") &&
      setting(context, "qobuzUserAuthToken")
    );
  }

  /* ── Quality mapping ───────────────────────────────────────────────── */

  /**
   * Map BitChord quality tier to Qobuz format_id.
   *
   *   5  = MP3 320 kbps
   *   6  = FLAC 16-bit / 44.1 kHz (CD)
   *   7  = FLAC 24-bit / up to 96 kHz
   *  27  = FLAC 24-bit / up to 192 kHz (Hi-Res)
   */
  function formatId(quality) {
    switch ((quality || "").toUpperCase()) {
      case "LOSSLESS":  return "27";
      case "HIGH":      return "6";
      case "LOW":       return "5";
      default:          return "27";
    }
  }

  /* ── HTTP request ──────────────────────────────────────────────────── */

  async function request(url, context) {
    var headers = {
      "Accept": "application/json",
      "X-App-Id": setting(context, "qobuzAppId"),
      "X-User-Auth-Token": setting(context, "qobuzUserAuthToken")
    };

    var response = await fetch(url, { headers: headers });

    if (!response.ok) {
      throw new Error("Qobuz HTTP " + response.status);
    }

    var body;
    try {
      body = response.json ? response.json() : JSON.parse(response.text());
    } catch (e) {
      throw new Error("Qobuz returned invalid JSON");
    }

    return body;
  }

  /* ── searchTracks ──────────────────────────────────────────────────── */

  module.exports.searchTracks = async function (query, limit, context) {
    if (!configured(context)) {
      return { tracks: [], total: 0 };
    }

    var base = setting(context, "qobuzApiBase");
    var url = base + "/catalog/search?query=" +
      encodeURIComponent(query) + "&limit=" + (limit || 25);

    var root;
    try {
      root = await request(url, context);
    } catch (e) {
      return { tracks: [], total: 0 };
    }

    var items = (root.tracks && root.tracks.items) ? root.tracks.items : [];

    var tracks = items.map(function (item) {
      var artist = "Unknown Artist";
      if (item.performer && item.performer.name) {
        artist = item.performer.name;
      } else if (item.artist && item.artist.name) {
        artist = item.artist.name;
      }

      var albumTitle = "";
      var albumCover = null;
      if (item.album) {
        albumTitle = item.album.title || "";
        if (item.album.image) {
          albumCover = item.album.image.large ||
                       item.album.image.small ||
                       item.album.image.thumbnail || null;
        }
      }

      return {
        id: String(item.id),
        title: item.title || "Unknown",
        artist: artist,
        album: albumTitle,
        albumCover: albumCover,
        duration: item.duration || 0,
        trackNumber: item.track_number || 0,
        audioQuality: "LOSSLESS",
        format: "flac",
        availableQualities: ["LOSSLESS", "HIGH", "LOW"]
      };
    });

    return { tracks: tracks, total: tracks.length };
  };

  /* ── getTrackStreamUrl ─────────────────────────────────────────────── */

  module.exports.getTrackStreamUrl = async function (id, quality, context) {
    if (!configured(context)) {
      return {
        streamUrl: null,
        track: { id: String(id), audioQuality: quality || "LOSSLESS" }
      };
    }

    var base = setting(context, "qobuzApiBase");
    var fid = formatId(quality);
    var url = base + "/track/getFileUrl?track_id=" +
      encodeURIComponent(id) + "&format_id=" + fid;

    var root;
    try {
      root = await request(url, context);
    } catch (e) {
      return {
        streamUrl: null,
        track: { id: String(id), audioQuality: quality || "LOSSLESS" }
      };
    }

    var streamUrl = root.url || null;
    var mimeType = root.mime_type || "audio/flac";
    var sampleRate = root.sampling_rate || null;
    var bitDepth = root.bit_depth || null;

    return {
      streamUrl: streamUrl,
      track: {
        id: String(id),
        audioQuality: quality || "LOSSLESS",
        mimeType: mimeType,
        bitDepth: bitDepth,
        sampleRate: sampleRate,
        bitrate: null
      }
    };
  };

}());
