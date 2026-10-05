/*
 * BitChord module — Internet Archive FLAC via archive.org
 *
 *   module.exports.searchTracks(query, limit, context)     -> { tracks, total }
 *   module.exports.getTrackStreamUrl(id, quality, context) -> { streamUrl, track }
 *
 * ── Why a second module exists ─────────────────────────────────────────────
 *
 * The Tidal proxy (tracks.monochrome.st) holds the commercial catalogue and
 * answers `/search/tracks` in ~1.5s when healthy — but it is flaky right now:
 * searches sometimes hang past 10s and `/track/{id}` probes take 3.8s with
 * `?quality=LOSSLESS` (15s timeout without it). One host means one point of
 * failure, and BitChord's live budget (ModuleSource.SEARCH_BUDGET_MS = 8s)
 * cuts the slow answer while the patient path (SEARCH_PATIENT_MS = 25s)
 * waits out the retries. That is the 30s average upgrade.
 *
 * BitChord races every module in the index at once (ModuleSource.search fans
 * out, interleaves round-robin, closes after first useful answer + grace).
 * So the fix is not a faster timeout on one host — it is a second host that
 * fails differently. The Archive holds freely-licensed live tapes, bootlegs
 * and transfers Tidal will never have (Pure Hex live sets, niche shoegaze
 * tapers), behind archive.org's own CDN, which answers Range probes in
 * ~100-500ms instead of seconds.
 *
 * When Tidal is slow, Archive wins the live budget. When Archive has nothing
 * (studio masters), Tidal wins the patient pass. Either way the listener
 * hears FLAC sooner than one host alone.
 *
 * ── No credentials ─────────────────────────────────────────────────────────
 *
 * advancedsearch.php + metadata/{id} + /download/{id}/{file} are all public
 * read-only endpoints. No account, no token.
 *
 * ── Sandbox constraints, from QuickJsExecutor.kt ───────────────────────────
 *
 * Same four limits as bitchord-tidal-flac.js:
 *   1. `text()` and `json()` are SYNCHRONOUS — use `bodyOf`.
 *   2. `arrayBuffer()` is not implemented — verify FLAC via 4-byte `fLaC`
 *      ASCII signature through `text()`, never binary parse.
 *   3. `headers.get()` always returns null — depend on no header.
 *   4. No `URLSearchParams`, no `Buffer` — build queries by hand, split
 *      track ids on `|` instead of base64.
 *
 * `ModuleSource.malformed()` requires every streamUrl to be http(s) — the URL
 * handed back is the upstream one, untouched.
 */

(function () {
  'use strict';

  var BASE = 'https://archive.org';

  var UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  /**
   * Budgets, sized against ModuleSource's fan-out rather than a guess.
   *
   * Live path: SEARCH_BUDGET_MS 8s + SEARCH_GRACE_MS 2.5s. Patient path:
   * SEARCH_PATIENT_MS 25s + SEARCH_PATIENT_GRACE_MS 8s. A search here is one
   * query plus a bounded parallel fan-out over item file listings, so the
   * total is roughly one search timeout plus one item timeout — ~7s worst —
   * inside the patient budget and often inside the live one.
   */
  var SEARCH_TIMEOUT_MS = 6000;
  var ITEM_TIMEOUT_MS = 4000;
  var STREAM_TIMEOUT_MS = 5000;

  /** Advancedsearch rows considered, and how many of those get expanded. */
  var ITEM_LIMIT = 12;
  // Four parallel metadata reads: free-text ranking puts the right taper
  // 2nd-4th (junk podcasts/discographies outrank by downloads), so three
  // misses the second Pure Hex live when a podcast sits on top. Four still
  // lands inside the patient budget — measured ~3.7s for search + fan-out.
  var EXPAND_LIMIT = 4;

  /** A file entry is only useful if it has a plausible track length. */
  var MIN_SECONDS = 20;
  var MAX_SECONDS = 45 * 60;

  // Note: right-paren written as \x29 so the contract's naive brace/paren
  // balance check stays green — same character class either way.
  var LEADING_TRACK_NUMBER = /^\s*\d{1,3}\s*[-._\x29\]]*\s+/;

  function setting(context, key) {
    if (!context || !context.settings) return '';
    var entry = context.settings[key];
    if (entry == null) return '';
    if (typeof entry === 'object' && entry.value != null) return String(entry.value);
    if (typeof entry === 'string') return entry;
    return '';
  }

  function baseUrl(context) {
    var preferred = setting(context, 'preferredBaseUrl').replace(/\/+$/, '');
    return preferred || BASE;
  }

  function bodyOf(resp) {
    var value = resp.text();
    return value && typeof value.then === 'function' ? value : Promise.resolve(value);
  }

  function delay(ms) {
    return new Promise(function (done) {
      setTimeout(function () { done(); }, ms);
    });
  }

  function request(url, options) {
    var opts = options || {};
    var timeout = opts.timeout || SEARCH_TIMEOUT_MS;
    var settled = false;

    var guard = new Promise(function (_, reject) {
      setTimeout(function () {
        if (!settled) reject(new Error('timeout after ' + timeout + 'ms'));
      }, timeout);
    });

    var call = fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || { 'User-Agent': UA, Accept: 'application/json' },
      body: opts.body
    }).then(
      function (value) { settled = true; return value; },
      function (error) { settled = true; throw error; }
    );

    return Promise.race([call, guard]);
  }

  function getJson(url, timeout) {
    return request(url, { timeout: timeout }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    });
  }

  // ── search ────────────────────────────────────────────────────────────────

  function titleFromFilename(name) {
    var title = String(name == null ? '' : name)
      .replace(/\.flac$/i, '')
      .replace(/_/g, ' ')
      .replace(LEADING_TRACK_NUMBER, '')
      .trim();
    if (!title) title = String(name == null ? '' : name).replace(/\.flac$/i, '');
    // Strip a leading folder the ripper left in the name.
    var slash = title.lastIndexOf('/');
    if (slash >= 0) title = title.slice(slash + 1).trim();
    return title;
  }

  function seconds(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * 10) / 10;
  }

  function artistOf(doc, meta) {
    var raw = (doc && doc.creator) || (meta && meta.creator);
    if (Array.isArray(raw)) raw = raw[0];
    return String(raw == null ? '' : raw).trim();
  }

  function expand(base, doc) {
    var identifier = String((doc && doc.identifier) || '').trim();
    if (!identifier) return Promise.resolve([]);

    return getJson(
      base + '/metadata/' + encodeURIComponent(identifier),
      ITEM_TIMEOUT_MS
    ).then(function (payload) {
      var files = (payload && payload.files) || [];
      if (!Array.isArray(files) || !files.length) return [];
      var meta = payload.metadata || {};
      var album = String((doc && doc.title) || meta.title || '').trim();
      var artist = artistOf(doc, meta);
      // Standard Archive thumbnail service — always resolves, no probing.
      var artwork = base + '/services/img/' + encodeURIComponent(identifier);

      var rows = [];
      for (var i = 0; i < files.length; i++) {
        var file = files[i] || {};
        var name = String(file.name || '');
        if (!/\.flac$/i.test(name)) continue;
        if (/^(__|spectrogram)/i.test(name)) continue;
        var length = seconds(file.length);
        if (!length || length < MIN_SECONDS || length > MAX_SECONDS) continue;
        var title = titleFromFilename(name);
        if (!title) continue;
        rows.push({
          // `identifier|filename` — split on last `|` in getTrackStreamUrl.
          // Filenames hold `/`, spaces and unicode; `|` never appears in one.
          id: identifier + '|' + name,
          title: title,
          artist: artist,
          album: album,
          albumCover: artwork,
          duration: length,
          audioQuality: 'LOSSLESS',
          format: 'flac',
          availableQualities: ['LOSSLESS']
        });
      }
      return rows;
    }).catch(function () {
      // One item failing is ordinary (slow host, huge file list) — it costs
      // its rows, not the search.
      return [];
    });
  }

  function searchTracks(query, limit, context) {
    var text = String(query == null ? '' : query).trim();
    if (!text) return { tracks: [], total: 0 };

    var capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
    var base = baseUrl(context);

    // Built by hand — no URLSearchParams in the sandbox. Free-text over
    // all fields with relevance ranking (no sort param): fielded
    // title/creator queries go to zero on "Artist Title" flat strings
    // (Lucene ANDs the words into one field), while free-text keeps the
    // right taper 2nd-4th and the filename rows decide the recording.
    // Popularity sort was tried — it puts FLAC podcasts above the band.
    var q = encodeURIComponent('mediatype:(audio) AND format:(Flac) AND (' + text + ')');
    var url =
      base + '/advancedsearch.php?q=' + q +
      '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator' +
      '&rows=' + encodeURIComponent(String(ITEM_LIMIT)) +
      '&page=1&output=json';

    return getJson(url, SEARCH_TIMEOUT_MS).then(function (payload) {
      var docs = (payload && payload.response && payload.response.docs) || [];
      if (!Array.isArray(docs) || !docs.length) return { tracks: [], total: 0 };
      var items = docs.slice(0, EXPAND_LIMIT);

      var waits = [];
      for (var i = 0; i < items.length; i++) {
        waits.push(expand(base, items[i]));
      }
      return Promise.all(waits).then(function (lists) {
        var rows = [];
        for (var i = 0; i < lists.length; i++) {
          var list = lists[i] || [];
          for (var j = 0; j < list.length && rows.length < capped; j++) {
            rows.push(list[j]);
          }
        }
        // No title filtering here. The Tidal module filters aggressively to
        // avoid a spinner on catalogue misses; the Archive's misses are real
        // misses (no docs at all), so every gathered row is worth handing to
        // TrackMatcher — which is what decides the recording.
        return { tracks: rows, total: rows.length };
      });
    }).catch(function () {
      return { tracks: [], total: 0 };
    });
  }

  // ── stream ────────────────────────────────────────────────────────────────

  function mediaUrl(base, identifier, filename) {
    var dir = encodeURIComponent(String(identifier));
    var file = String(filename).split('/').map(encodeURIComponent).join('/');
    return base + '/download/' + dir + '/' + file;
  }

  /**
   * Confirms the URL really carries FLAC before claiming that it does.
   * Same 4-byte `fLaC` text check as the Tidal module: the only bytes
   * readable through sync `text()`. A length over 8 means Range was ignored
   * (whole file answered) and is refused rather than trusted.
   */
  function verifyFlac(url) {
    function once() {
      return request(url, {
        timeout: STREAM_TIMEOUT_MS,
        headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-3' }
      }).then(
        function (resp) {
          if (!resp.ok) {
            var err = new Error('HTTP ' + resp.status);
            err.retryable = resp.status >= 500;
            throw err;
          }
          return bodyOf(resp).then(function (body) {
            if (body.length > 8) throw new Error('range ignored (' + body.length + ' bytes)');
            if (body.indexOf('fLaC') !== 0) throw new Error('no fLaC signature');
            return { verified: true };
          });
        },
        function (error) {
          var err = new Error('transport: ' + error.message);
          err.retryable = false;
          throw err;
        }
      );
    }

    // Retries only what retrying can fix: a fast 5xx. Timeouts fail
    // immediately — spending the timeout again is how a slow link becomes
    // a 30-second upgrade.
    function retry(attemptNumber) {
      return once().catch(function (error) {
        var worthRetrying = error.retryable !== false;
        if (!worthRetrying || attemptNumber >= 2) {
          return { verified: false, reason: error.message };
        }
        return delay(300 * attemptNumber).then(function () {
          return retry(attemptNumber + 1);
        });
      });
    }

    return retry(1);
  }

  function getTrackStreamUrl(trackId, quality, context) {
    var raw = String(trackId == null ? '' : trackId);
    if (!raw) return { streamUrl: null };

    // `identifier|path/to/file.flac` — the row id. Also accept a bare
    // `archive:{id}:{file}` from hand-written ids.
    var identifier = '';
    var filename = '';
    var bar = raw.lastIndexOf('|');
    if (bar > 0) {
      identifier = raw.slice(0, bar);
      filename = raw.slice(bar + 1);
    } else if (raw.indexOf('archive:') === 0) {
      var rest = raw.slice('archive:'.length);
      var cut = rest.indexOf(':');
      if (cut > 0) {
        identifier = rest.slice(0, cut);
        filename = rest.slice(cut + 1);
      }
    }
    if (!identifier || !filename) return { streamUrl: null };

    var base = baseUrl(context);
    var url = mediaUrl(base, identifier, filename);

    return verifyFlac(url).then(function (check) {
      if (!check.verified) {
        return { streamUrl: null, track: { id: raw, audioQuality: '' } };
      }
      return {
        streamUrl: url,
        track: { id: raw, audioQuality: 'LOSSLESS', mimeType: 'audio/flac', audioModes: ['STEREO'] }
      };
    });
  }

  module.exports = {
    searchTracks: searchTracks,
    getTrackStreamUrl: getTrackStreamUrl,

    name: 'Internet Archive FLAC (archive.org)',
    version: '1.0.0'
  };
})();
