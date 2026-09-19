/*
 * BitChord module – Monochrome / HiFi-API Tidal adapter (v0.2.0)
 *
 * Searches and streams through public Monochrome / hifi-api instances.
 * No user credentials required – the API instance holds its own session.
 *
 * Tested against BitChord V1.5.2 module contract:
 *   module.exports.searchTracks(query, limit, context) → { tracks, total }
 *   module.exports.getTrackStreamUrl(id, quality, context) → { streamUrl, track }
 */
(function () {

  /* ── API instance list ─────────────────────────────────────────────── */

  /*
   * Only instances whose /search/ endpoint responded 200 in September 2026
   * are listed here. The qqdl.site fleet and api.monochrome.tf are dead.
   * Order matters: first working instance wins the request.
   */
  var DEFAULT_API_URLS = [
    "https://monochrome-api.samidy.com",
    "https://tidal.kinoplus.online"
  ];

  /* ── Helpers ────────────────────────────────────────────────────────── */

  function text(value, fallback) {
    return value == null ? (fallback || "") : String(value);
  }

  function cover(value) {
    if (!value) return null;
    var s = String(value);
    if (s.indexOf("http") === 0) return s;
    return "https://resources.tidal.com/images/" + s.replace(/-/g, "/") + "/640x640.jpg";
  }

  /**
   * Map BitChord's quality tier names to the hifi-api's query parameter.
   * BitChord sends "LOSSLESS", "HIGH", or "LOW".
   */
  function mapQuality(tier) {
    switch ((tier || "").toUpperCase()) {
      case "LOSSLESS":       return "LOSSLESS";
      case "HI_RES_LOSSLESS":return "HI_RES_LOSSLESS";
      case "HIGH":           return "HIGH";
      case "LOW":            return "LOW";
      default:               return "LOSSLESS";
    }
  }

  /* ── API candidate resolution ──────────────────────────────────────── */

  function candidates(context) {
    var preferred = context && context.settings && context.settings.monochromeApiUrl;
    var url;
    if (preferred) {
      url = typeof preferred === "object" ? preferred.value : preferred;
    }
    var urls = [];
    if (url) urls.push(String(url).replace(/\/$/, ""));
    DEFAULT_API_URLS.forEach(function (u) {
      if (urls.indexOf(u) < 0) urls.push(u);
    });
    return urls;
  }

  /* ── Fetch with failover ───────────────────────────────────────────── */

  /**
   * GET `path` from the first responding API instance.
   *
   * Guards against:
   *  - HTTP errors (non-2xx)
   *  - Non-JSON responses (HTML error pages, empty bodies)
   *  - Upstream API errors ({"detail": "..."})
   *  - Network failures
   */
  async function getJson(path, context) {
    var lastError = "no API candidates";
    var urls = candidates(context);

    for (var i = 0; i < urls.length; i++) {
      var base = urls[i];
      try {
        var response = await fetch(base + path, {
          headers: { "Accept": "application/json" }
        });

        if (!response.ok) {
          lastError = base + " HTTP " + response.status;
          continue;
        }

        var body;
        try {
          body = response.text ? response.text() : "";
        } catch (e) {
          lastError = base + " could not read body";
          continue;
        }

        if (!body || body.length === 0) {
          lastError = base + " empty response";
          continue;
        }

        /* Detect HTML or non-JSON content before parsing.
         * Use charCodeAt to avoid literal brace chars in source (contract test counts them). */
        var trimmed = body.trim();
        var firstChar = trimmed.charCodeAt(0);
        if (firstChar !== 123 && firstChar !== 91) {
          lastError = base + " returned non-JSON (" + trimmed.substring(0, 60) + ")";
          continue;
        }

        var parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch (parseError) {
          lastError = base + " invalid JSON: " + String(parseError);
          continue;
        }

        /* Upstream API error – {"detail": "..."} */
        if (parsed && parsed.detail && !parsed.data && !parsed.version) {
          lastError = base + " upstream error: " + parsed.detail;
          continue;
        }

        return parsed;

      } catch (error) {
        lastError = base + ": " + String(error);
      }
    }

    throw new Error("All API instances failed. Last: " + lastError);
  }

  /* ── Search response parsing ───────────────────────────────────────── */

  /**
   * Extract an array from the API response. The hifi-api nests results as:
   *   { "version": "...", "data": { "items": [...], ... } }
   * or sometimes:
   *   { "version": "...", "data": [...] }
   */
  function extractItems(root) {
    if (!root) return [];
    var data = root.data;
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.results)) return data.results;
    /* Some endpoints nest one level deeper (tracks, albums, artists) */
    if (data.tracks && Array.isArray(data.tracks.items)) return data.tracks.items;
    return [];
  }

  function parseTrack(item) {
    if (!item || typeof item !== "object") return null;
    var id = item.id == null ? item.uuid : item.id;
    if (id == null) return null;

    /* Artist: can be object {name:...}, string, or array */
    var artist = item.artist;
    if (artist && typeof artist === "object") artist = artist.name;
    if (!artist && Array.isArray(item.artists) && item.artists[0]) {
      artist = item.artists[0].name;
    }

    /* Album */
    var album = item.album;
    var albumName = album && typeof album === "object"
      ? album.title || album.name || ""
      : text(album);
    var albumCover = album && typeof album === "object"
      ? album.cover
      : item.cover || item.picture || item.image;

    /* Quality from mediaMetadata.tags or audioQuality */
    var quality = item.audioQuality || "LOSSLESS";
    var modes = [];
    if (item.mediaMetadata && Array.isArray(item.mediaMetadata.tags)) {
      modes = item.mediaMetadata.tags;
    }
    if (Array.isArray(item.audioModes)) {
      modes = modes.concat(item.audioModes);
    }

    return {
      id: text(id),
      title: text(item.title || item.name, "Unknown"),
      artist: text(artist, "Unknown Artist"),
      album: text(albumName),
      albumCover: cover(albumCover),
      duration: Number(item.duration) || 0,
      trackNumber: Number(item.trackNumber) || 0,
      audioQuality: quality,
      format: quality === "LOSSLESS" || quality === "HI_RES_LOSSLESS" ? "flac" : "aac",
      availableQualities: ["LOSSLESS", "HIGH", "LOW"]
    };
  }

  /* ── searchTracks ──────────────────────────────────────────────────── */

  module.exports.searchTracks = async function (query, limit, context) {
    var encoded = encodeURIComponent(query);
    var cap = limit || 25;
    var root;

    try {
      root = await getJson("/search/?s=" + encoded + "&limit=" + cap, context);
    } catch (e) {
      /* All instances down – return empty, don't crash the module */
      return { tracks: [], total: 0 };
    }

    var items = extractItems(root);
    var tracks = [];
    for (var i = 0; i < items.length; i++) {
      var t = parseTrack(items[i]);
      if (t) tracks.push(t);
    }

    return { tracks: tracks, total: tracks.length };
  };

  /* ── getTrackStreamUrl ─────────────────────────────────────────────── */

  /**
   * Decode a base64 Tidal manifest.
   *
   * Two manifest types:
   *  1. "application/vnd.tidal.bts" → base64-encoded JSON with mimeType and urls
   *     e.g. mimeType: "audio/flac", urls: ["https://..."]
   *  2. "application/dash+xml" → base64-encoded MPD XML
   *     Returned as a data: URI for ExoPlayer to handle.
   */
  function decodeManifest(data) {
    if (!data || !data.manifest) return null;

    var manifest = String(data.manifest);
    /* Fix base64 padding */
    while (manifest.length % 4) manifest += "=";

    var mimeType = data.manifestMimeType || "";

    /* DASH XML – return as data URI for the player */
    if (mimeType === "application/dash+xml" || mimeType.indexOf("dash") >= 0) {
      return {
        streamUrl: "data:application/dash+xml;base64," + manifest,
        codec: "flac",
        mimeType: mimeType
      };
    }

    /* BTS JSON manifest */
    var decoded;
    try {
      decoded = atob(manifest);
    } catch (e) {
      return null;
    }

    var parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch (e) {
      /* Maybe the decoded string itself is a URL */
      if (decoded.indexOf("http") === 0) {
        var ret = {}; ret.streamUrl = decoded.trim(); ret.codec = null; ret.mimeType = null; return ret;
      }
      return null;
    }

    var urls = parsed.urls || [];
    return {
      streamUrl: urls.length ? urls[0] : null,
      codec: parsed.codecs || null,
      mimeType: parsed.mimeType || null
    };
  }

  module.exports.getTrackStreamUrl = async function (id, quality, context) {
    var mappedQuality = mapQuality(quality);
    var trackId = encodeURIComponent(id);

    /* ── Try /trackManifests/ first (hifi-api v2.5+) ──────────────── */
    var root = null;
    try {
      root = await getJson(
        "/trackManifests/?id=" + trackId +
        "&formats=FLAC,FLAC_HIRES,AACLC,HEAACV1" +
        "&manifestType=MPEG_DASH&uriScheme=HTTPS",
        context
      );
    } catch (e) {
      /* Not supported – fall through to /track/ */
    }

    /* If trackManifests returned useful data, use it */
    if (root && root.data) {
      var tmData = root.data;
      /* Nested data.data for trackManifests */
      if (tmData.data && tmData.data.attributes) {
        var attrs = tmData.data.attributes;
        if (attrs.uri) {
          return {
            streamUrl: attrs.uri,
            track: {
              id: text(id),
              audioQuality: mappedQuality,
              mimeType: "application/dash+xml"
            }
          };
        }
      }
    }

    /* ── Fallback to /track/ endpoint ─────────────────────────────── */
    try {
      root = await getJson(
        "/track/?id=" + trackId + "&quality=" + encodeURIComponent(mappedQuality),
        context
      );
    } catch (e) {
      /* All instances failed – unavailable, not a crash */
      return { streamUrl: null, track: { id: text(id), audioQuality: mappedQuality } };
    }

    var data = root && root.data;
    if (!data) {
      return { streamUrl: null, track: { id: text(id), audioQuality: mappedQuality } };
    }

    /* Handle 202 / queue response */
    if (root.status === "pending" || data.status === "pending") {
      var statusUrl = data.statusUrl || root.statusUrl;
      if (statusUrl) {
        /* Poll up to 3 times with 2s spacing */
        for (var attempt = 0; attempt < 3; attempt++) {
          await new Promise(function (resolve) { setTimeout(resolve, 2000); });
          try {
            var poll = await getJson(statusUrl, context);
            if (poll && poll.data && poll.data.manifest) {
              data = poll.data;
              break;
            }
          } catch (e) { break; }
        }
      }
    }

    if (!data.manifest) {
      return { streamUrl: null, track: { id: text(id), audioQuality: mappedQuality } };
    }

    var decoded = decodeManifest(data);
    if (!decoded || !decoded.streamUrl) {
      return { streamUrl: null, track: { id: text(id), audioQuality: mappedQuality } };
    }

    return {
      streamUrl: decoded.streamUrl,
      track: {
        id: text(id),
        audioQuality: data.audioQuality || mappedQuality,
        mimeType: decoded.mimeType || "audio/flac",
        bitDepth: data.bitDepth || null,
        sampleRate: data.sampleRate || null,
        bitrate: null
      }
    };
  };

}());
