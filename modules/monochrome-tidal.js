/*
 * BitChord module – Monochrome / HiFi-API Tidal adapter (v0.2.2)
 *
 * Searches and streams through Monochrome / hifi-api / QQDL cluster instances.
 * Tested against BitChord QuickJS sandbox contract.
 *
 * Requirements:
 *   - module.exports.searchTracks(query, limit, context) → { tracks, total }
 *   - module.exports.getTrackStreamUrl(id, quality, context) → { streamUrl, track }
 *
 * Note: BitChord ModuleSource.malformed() requires all streamUrl values
 * to be valid HTTP/HTTPS URLs (url.toHttpUrlOrNull() != null). Data URIs
 * are rejected as malformed.
 */
(function () {

  /* ── API instance list ─────────────────────────────────────────────── */

  var DEFAULT_API_URLS = [
    "https://monochrome-api.samidy.com",
    "https://api.monochrome.tf",
    "https://wolf.qqdl.site",
    "https://maus.qqdl.site",
    "https://katze.qqdl.site",
    "https://vogel.qqdl.site",
    "https://hund.qqdl.site",
    "https://hifi.geeked.wtf"
  ];

  var DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept": "application/json"
  };

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

  function qualityTiers(primaryTier) {
    var norm = (primaryTier || "LOSSLESS").toUpperCase();
    if (norm === "HI_RES_LOSSLESS") {
      return ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];
    } else if (norm === "LOSSLESS") {
      return ["LOSSLESS", "HI_RES_LOSSLESS", "HIGH", "LOW"];
    } else if (norm === "HIGH") {
      return ["HIGH", "LOSSLESS", "LOW"];
    } else {
      return ["LOW", "HIGH", "LOSSLESS"];
    }
  }

  function fetchWithTimeout(url, options, ms) {
    var limit = ms || 2500;
    return Promise.race([
      fetch(url, options),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("Timeout after " + limit + "ms"));
        }, limit);
      })
    ]);
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

  async function getJson(path, context) {
    var lastError = "no API candidates";
    var urls = candidates(context);

    for (var i = 0; i < urls.length; i++) {
      var base = urls[i];
      try {
        var response = await fetchWithTimeout(base + path, {
          headers: DEFAULT_HEADERS
        }, 3000);

        if (!response.ok) {
          lastError = base + " HTTP " + response.status;
          continue;
        }

        var body = typeof response.text === "function" ? response.text() : "";
        if (body && typeof body.then === "function") {
          body = await body;
        }

        if (!body || typeof body !== "string" || body.trim().charAt(0) !== String.fromCharCode(123)) {
          lastError = base + " non-JSON response";
          continue;
        }

        var parsed;
        try {
          parsed = JSON.parse(body);
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

  function extractItems(root) {
    if (!root) return [];
    var data = root.data;
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.results)) return data.results;
    if (data.tracks && Array.isArray(data.tracks.items)) return data.tracks.items;
    return [];
  }

  function parseTrack(item) {
    if (!item || typeof item !== "object") return null;
    var id = item.id == null ? item.uuid : item.id;
    if (id == null) return null;

    var artist = item.artist;
    if (artist && typeof artist === "object") artist = artist.name;
    if (!artist && Array.isArray(item.artists) && item.artists[0]) {
      artist = item.artists[0].name;
    }

    var album = item.album;
    var albumTitle = "";
    var coverId = null;
    if (album && typeof album === "object") {
      albumTitle = album.title || "";
      coverId = album.cover || album.coverId || null;
    } else if (typeof album === "string") {
      albumTitle = album;
    }

    if (!coverId && item.cover) coverId = item.cover;

    var duration = item.duration;
    if (typeof duration === "string") {
      var num = parseFloat(duration);
      duration = isNaN(num) ? 0 : Math.round(num);
    } else if (typeof duration !== "number" || isNaN(duration)) {
      duration = 0;
    }

    return {
      id: text(id),
      title: text(item.title || item.name, "Unknown"),
      artists: [text(artist, "Unknown")],
      album: albumTitle || null,
      duration: duration,
      thumbnailUrl: cover(coverId)
    };
  }

  /* ── searchTracks ──────────────────────────────────────────────────── */

  module.exports.searchTracks = async function (query, limit, context) {
    if (!query || typeof query !== "string" || !query.trim()) {
      return { tracks: [], total: 0 };
    }

    var cap = typeof limit === "number" && limit > 0 ? Math.min(limit, 50) : 25;
    var encoded = encodeURIComponent(query.trim());
    var root = null;

    try {
      root = await getJson("/search/?s=" + encoded + "&limit=" + cap, context);
    } catch (e) {
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
   * Extract a valid HTTP(S) stream URL from manifest data.
   * Never returns data: URIs because BitChord ModuleSource.malformed() rejects them.
   */
  function decodeManifestUrl(data) {
    if (!data || !data.manifest) return null;

    var manifest = String(data.manifest);
    while (manifest.length % 4) manifest += "=";

    var mimeType = data.manifestMimeType || "";

    /* Case 1: BTS JSON manifest (standard Tidal lossless) */
    if (mimeType.indexOf("bts") >= 0 || mimeType.indexOf("json") >= 0) {
      var decoded;
      try {
        decoded = atob(manifest);
        var parsed = JSON.parse(decoded);
        var urls = parsed.urls || [];
        if (urls.length && (urls[0].indexOf("http://") === 0 || urls[0].indexOf("https://") === 0)) {
          return {
            streamUrl: urls[0],
            mimeType: parsed.mimeType || "audio/flac",
            codec: parsed.codecs || "flac"
          };
        }
      } catch (e) {}
    }

    /* Case 2: DASH XML manifest */
    if (mimeType.indexOf("dash") >= 0 || mimeType.indexOf("xml") >= 0) {
      var decodedXml = "";
      try {
        decodedXml = atob(manifest);
      } catch (e) {}

      if (decodedXml) {
        /* Extract media or initialization URL from segment template */
        var mediaMatch = decodedXml.match(/media="([^"]+)"/);
        var initMatch = decodedXml.match(/initialization="([^"]+)"/);
        var targetUrl = (mediaMatch && mediaMatch[1]) || (initMatch && initMatch[1]);
        if (targetUrl) {
          targetUrl = targetUrl.replace(/\$Number\$/, "1");
          if (targetUrl.indexOf("http://") === 0 || targetUrl.indexOf("https://") === 0) {
            return {
              streamUrl: targetUrl,
              mimeType: "audio/mp4",
              codec: "flac"
            };
          }
        }
      }
    }

    return null;
  }

  module.exports.getTrackStreamUrl = async function (id, quality, context) {
    var trackId = encodeURIComponent(id);
    var tiers = qualityTiers(quality);
    var urls = candidates(context);
    var lastPreview = null;

    /*
     * Try qualities and candidate endpoints.
     * Prioritize full streams over 30-second previews.
     */
    for (var qIdx = 0; qIdx < tiers.length; qIdx++) {
      var currentTier = tiers[qIdx];

      for (var uIdx = 0; uIdx < urls.length; uIdx++) {
        var base = urls[uIdx];
        var root = null;

        try {
          var response = await fetchWithTimeout(
            base + "/track/?id=" + trackId + "&quality=" + encodeURIComponent(currentTier),
            { headers: DEFAULT_HEADERS },
            2000
          );

          if (!response.ok) continue;

          var body = typeof response.text === "function" ? response.text() : "";
          if (body && typeof body.then === "function") {
            body = await body;
          }

          if (!body || typeof body !== "string" || body.trim().charAt(0) !== String.fromCharCode(123)) {
            continue;
          }

          root = JSON.parse(body);
        } catch (e) {
          continue;
        }

        var data = root && root.data;
        if (!data) continue;

        var isPreview = !!(data.previewReason || data.preview);

        /* Direct stream URL */
        if (data.streamUrl && (data.streamUrl.indexOf("http://") === 0 || data.streamUrl.indexOf("https://") === 0)) {
          var directResult = {
            streamUrl: data.streamUrl,
            track: {
              id: text(id),
              audioQuality: data.audioQuality || currentTier,
              mimeType: data.mimeType || "audio/flac"
            }
          };

          if (isPreview) {
            if (!lastPreview) lastPreview = directResult;
            continue;
          }
          return directResult;
        }

        /* Decoded manifest */
        var decoded = decodeManifestUrl(data);
        if (decoded && decoded.streamUrl) {
          var manifestResult = {
            streamUrl: decoded.streamUrl,
            track: {
              id: text(id),
              audioQuality: data.audioQuality || currentTier,
              mimeType: decoded.mimeType || "audio/flac",
              bitDepth: data.bitDepth || null,
              sampleRate: data.sampleRate || null,
              bitrate: null
            }
          };

          if (isPreview) {
            if (!lastPreview) lastPreview = manifestResult;
            continue;
          }
          return manifestResult;
        }
      }
    }

    /* If only a preview was found, return it as last resort */
    if (lastPreview) {
      return lastPreview;
    }

    /* Fallback: signal unavailable gracefully so BitChord falls back to YouTube */
    return {
      streamUrl: null,
      track: {
        id: text(id),
        audioQuality: quality || "LOSSLESS"
      }
    };
  };

}());
