/*
 * BitChord module API for Monochrome's documented API instances. UI hosts
 * such as monochrome.tf are intentionally excluded from this list.
 */
(function () {
  var API_URLS = [
    "https://monochrome-api.samidy.com",
    "https://api.monochrome.tf",
    "https://wolf.qqdl.site",
    "https://maus.qqdl.site",
    "https://vogel.qqdl.site",
    "https://katze.qqdl.site",
    "https://hund.qqdl.site",
    "https://tidal.kinoplus.online"
  ];

  function text(value, fallback) {
    return value == null ? (fallback || "") : String(value);
  }

  function cover(value) {
    if (!value) return null;
    if (String(value).indexOf("http") === 0) return String(value);
    return "https://resources.tidal.com/images/" + String(value).replace(/-/g, "/") + "/640x640.jpg";
  }

  function arrayAt(root, key) {
    var data = root && root.data;
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    var value = data[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.items)) return value.items;
    return Array.isArray(data.items) ? data.items : (Array.isArray(data.results) ? data.results : []);
  }

  function parseTrack(item) {
    if (!item || typeof item !== "object") return null;
    var id = item.id == null ? item.uuid : item.id;
    if (id == null) return null;
    var artist = item.artist;
    if (artist && typeof artist === "object") artist = artist.name;
    if (!artist && Array.isArray(item.artists) && item.artists[0]) artist = item.artists[0].name;
    var album = item.album;
    var albumName = album && typeof album === "object" ? album.title || album.name : album;
    var albumCover = album && typeof album === "object" ? album.cover : item.cover || item.picture || item.image;
    return {
      id: text(id),
      title: text(item.title || item.name, "Unknown"),
      artist: text(artist, "Unknown Artist"),
      album: text(albumName),
      albumCover: cover(albumCover),
      duration: Number(item.duration) || 0,
      audioQuality: "LOSSLESS",
      format: "flac",
      availableQualities: ["LOSSLESS", "HIGH", "LOW"]
    };
  }

  function candidates(context) {
    var preferred = context && context.settings && context.settings.monochromeApiUrl;
    var urls = [];
    if (preferred) urls.push(String(preferred).replace(/\/$/, ""));
    API_URLS.forEach(function (url) {
      if (urls.indexOf(url) < 0) urls.push(url);
    });
    return urls;
  }

  async function getJson(path, context) {
    var lastError = "no API candidates";
    var urls = candidates(context);
    for (var i = 0; i < urls.length; i++) {
      try {
        var response = await fetch(urls[i] + path, { headers: { "Accept": "application/json" } });
        if (!response.ok) {
          lastError = urls[i] + " returned HTTP " + response.status;
          continue;
        }
        try {
          return await response.json();
        } catch (parseError) {
          lastError = urls[i] + " returned a non-JSON response";
        }
      } catch (error) {
        lastError = urls[i] + ": " + String(error);
      }
    }
    throw new Error("All Monochrome API instances failed: " + lastError);
  }

  module.exports.searchTracks = async function (query, limit, context) {
    var encoded = encodeURIComponent(query);
    var root = await getJson("/search/?s=" + encoded + "&limit=" + (limit || 25), context);
    var tracks = arrayAt(root, "tracks").map(parseTrack).filter(function (item) { return item !== null; });
    return { tracks: tracks, total: tracks.length };
  };

  module.exports.getTrackStreamUrl = async function (id, quality, context) {
    var requested = quality || "LOSSLESS";
    var root = await getJson("/track/?id=" + encodeURIComponent(id) + "&quality=" + encodeURIComponent(requested), context);
    var data = root && root.data;
    if (!data || !data.manifest) return { streamUrl: null };
    var manifest = String(data.manifest);
    while (manifest.length % 4) manifest += "=";
    var decoded = atob(manifest);
    if (data.manifestMimeType === "application/dash+xml") {
      return { streamUrl: "data:application/dash+xml;base64," + manifest, track: { id: text(id), audioQuality: requested, mimeType: data.manifestMimeType } };
    }
    var parsed = JSON.parse(decoded);
    var urls = parsed.urls || [];
    return { streamUrl: urls.length ? urls[0] : null, track: { id: text(id), audioQuality: requested, mimeType: "audio/aac" } };
  };
}());
