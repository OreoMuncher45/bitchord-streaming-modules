/*
 * BitChord module API: monochrome.tf is Tidal-compatible, not an official
 * Tidal API. The service currently exposes search and track manifest routes.
 */
(function () {
  var BASE = "https://monochrome.tf";

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

  async function getJson(url) {
    var response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!response.ok) throw new Error("Monochrome HTTP " + response.status);
    return await response.json();
  }

  module.exports.searchTracks = async function (query, limit) {
    var encoded = encodeURIComponent(query);
    var root = await getJson(BASE + "/search/?s=" + encoded + "&limit=" + (limit || 25));
    var tracks = arrayAt(root, "tracks").map(parseTrack).filter(function (item) { return item !== null; });
    return { tracks: tracks, total: tracks.length };
  };

  module.exports.getTrackStreamUrl = async function (id, quality) {
    var requested = quality || "LOSSLESS";
    var root = await getJson(BASE + "/track/?id=" + encodeURIComponent(id) + "&quality=" + encodeURIComponent(requested));
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
