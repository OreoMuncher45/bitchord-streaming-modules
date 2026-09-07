/*
 * Official Qobuz API adapter scaffold.
 *
 * Do not put credentials in this file. The BitChord module context can carry
 * private settings when the module is self-hosted. The public index ships this
 * adapter so its contract is reviewable, but it remains intentionally inert
 * until the required values are configured by a private host/gateway.
 */
(function () {
  function setting(context, key) {
    return context && context.settings && context.settings[key]
      ? context.settings[key].value
      : "";
  }

  function configured(context) {
    return setting(context, "qobuzApiBase") && setting(context, "qobuzAppId") && setting(context, "qobuzUserAuthToken");
  }

  async function request(url, context) {
    var response = await fetch(url, { headers: { "Accept": "application/json", "X-App-Id": setting(context, "qobuzAppId"), "X-User-Auth-Token": setting(context, "qobuzUserAuthToken") } });
    if (!response.ok) throw new Error("Qobuz HTTP " + response.status);
    return await response.json();
  }

  module.exports.searchTracks = async function (query, limit, context) {
    if (!configured(context)) return { tracks: [], total: 0 };
    var base = setting(context, "qobuzApiBase");
    var root = await request(base + "/catalog/search?query=" + encodeURIComponent(query) + "&limit=" + (limit || 25), context);
    var items = root.tracks && root.tracks.items ? root.tracks.items : [];
    return { tracks: items.map(function (item) {
      var artist = item.performer && item.performer.name ? item.performer.name : "Unknown Artist";
      return { id: String(item.id), title: item.title || "Unknown", artist: artist, album: item.album ? item.album.title || "" : "", albumCover: item.album && item.album.image ? item.album.image.small : null, duration: item.duration || 0, audioQuality: "LOSSLESS", format: "flac" };
    }), total: items.length };
  };

  module.exports.getTrackStreamUrl = async function (id, quality, context) {
    if (!configured(context)) return { streamUrl: null };
    var base = setting(context, "qobuzApiBase");
    var root = await request(base + "/track/getFileUrl?track_id=" + encodeURIComponent(id) + "&format_id=27", context);
    return { streamUrl: root.url || null, track: { id: String(id), audioQuality: quality || "LOSSLESS", mimeType: "audio/flac" } };
  };
}());
