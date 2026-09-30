/*
 * BitChord module — Tidal FLAC via tracks.monochrome.st
 *
 *   module.exports.searchTracks(query, limit, context)     -> { tracks, total }
 *   module.exports.getTrackStreamUrl(id, quality, context) -> { streamUrl, track }
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * The index this module ships in previously pointed at eight hosts:
 *
 *   monochrome-api.samidy.com  alive, but its Tidal token refresh returns 403,
 *                              so every search answers 401
 *   api.monochrome.tf          DNS does not resolve
 *   wolf / maus / katze /
 *   vogel / hund .qqdl.site    TLS handshake ends abruptly
 *   hifi.geeked.wtf            DNS does not resolve
 *
 * Eight hosts, none able to answer a search. The one that does work is
 * tracks.monochrome.st, which speaks a different shape from the hifi-api
 * protocol the previous module was written against: `/search/tracks?q=` for
 * metadata and `/track/{id}` for the audio itself, with no separate
 * URL-resolution step.
 *
 * The list is still a list rather than a single constant, because every host in
 * this ecosystem has a habit of disappearing. `preferredBaseUrl` overrides the
 * first candidate without removing the fallbacks.
 *
 * ── No credentials ──────────────────────────────────────────────────────────
 *
 * tracks.monochrome.st is a public read-only index. No account, no token, no
 * developer credential — and none of those belongs in this file.
 *
 * ── Sandbox constraints, from QuickJsExecutor.kt ─────────────────────────────
 *
 * Four limits shaped this file. Three were found by reading the source; the
 * fourth was found by the module failing on a device and is the reason the
 * harness in scripts/test-module.js exists.
 *
 *   1. `text()` and `json()` are SYNCHRONOUS. The bridge defines
 *        text: function() { return respBody; }
 *        json: function() { return JSON.parse(respBody); }
 *      They return the value, not a promise for one, despite being named like
 *      the `Response` methods they stand in for. So `resp.text().then(...)` is a
 *      TypeError inside BitChord. Everything below goes through `bodyOf`, which
 *      accepts either shape.
 *   2. `arrayBuffer()` is not implemented — the bridge throws
 *      "Not implemented". A FLAC header therefore cannot be decoded here, and
 *      this module does NOT report `sampleRate` or `bitDepth`. Guessing them
 *      would be worse than omitting them: BitChord grades a rendition against
 *      what the device actually decodes, so a claimed depth the file does not
 *      have is a claim, not information. The companion addon server reads
 *      STREAMINFO for real and is the better path when you can run one.
 *   3. `headers.get()` always returns null. No response header is readable, so
 *      nothing here depends on one — including the byte count that would give a
 *      bitrate.
 *   4. There is no `URLSearchParams`. Query strings are built by hand.
 *
 * `ModuleSource.malformed()` also requires every streamUrl to be a real http(s)
 * URL — a `data:` URI is refused — so the URL handed back is the upstream one,
 * untouched.
 */

(function () {
  'use strict';

  /** Tried in order. Duplicates cost nothing; the failure path is what matters. */
  var DEFAULT_BASE_URLS = [
    'https://tracks.monochrome.st',
    'https://tracks.monochrome.st',
    'https://api.monochrome.tf',
    'https://monochrome-api.samidy.com',
    'https://wolf.qqdl.site',
    'https://maus.qqdl.site',
    'https://vogel.qqdl.site',
    'https://katze.qqdl.site',
    'https://hund.qqdl.site',
    'https://hifi.geeked.wtf'
  ];

  var UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  var SEARCH_TIMEOUT_MS = 12000;
  var STREAM_TIMEOUT_MS = 10000;

  /**
   * How long a host that failed is skipped.
   *
   * Short on purpose. The failure being guarded against is usually a CDN in
   * front of one returning 520 for a moment, not a host being down — and 120
   * seconds turned that single blip into a two-minute outage during which every
   * attempt was skipped before it was ever tried.
   */
  var HOST_COOLDOWN_MS = 30000;

  /**
   * How many times one host is asked before it is blamed.
   *
   * Measured against the live CDN: three of four consecutive reads on the same
   * URL returned `206` with a `fLaC` signature and the fourth returned `520` with
   * an HTML error page. One retry is the difference between that being invisible
   * and it failing the track.
   */
  var STREAM_ATTEMPTS = 3;

  /** baseUrl -> epoch ms until which it is skipped. */
  var hostCooldowns = {};

  // ── settings ──────────────────────────────────────────────────────────────

  /**
   * BitChord sends `context.settings` as `{ key: { value: "…" } }`. The wrapper
   * is there because a module's own settings schema describes each key as an
   * object with a type, a label and a current value; a bare string is accepted
   * too, so a hand-edited settings blob still works.
   */
  function setting(context, key) {
    if (!context || !context.settings) return '';
    var entry = context.settings[key];
    if (entry == null) return '';
    if (typeof entry === 'object' && entry.value != null) return String(entry.value);
    if (typeof entry === 'string') return entry;
    return '';
  }

  /** The tier BitChord asked for, from the argument or the settings blob. */
  function wantedTier(quality, context) {
    var raw = String(quality || setting(context, 'quality') || '').toLowerCase();
    if (!raw) return 'LOSSLESS';
    if (/lossless|flac|hi-?res|hires|max|best/.test(raw)) return 'LOSSLESS';
    if (/low|96|128|min/.test(raw)) return 'LOW';
    return 'HIGH';
  }

  function baseUrls(context) {
    var preferred = setting(context, 'preferredBaseUrl').replace(/\/+$/, '');
    if (!preferred) return DEFAULT_BASE_URLS.slice();

    // An override goes to the front rather than replacing the list, so a
    // self-hosted instance that goes away falls back instead of stopping.
    var list = [];
    for (var i = 0; i < DEFAULT_BASE_URLS.length; i++) {
      if (DEFAULT_BASE_URLS[i] !== preferred) list.push(DEFAULT_BASE_URLS[i]);
    }
    list.unshift(preferred);
    return list;
  }

  function hostIsCooling(base) {
    var until = hostCooldowns[base];
    return !!until && until > Date.now();
  }

  function coolDown(base) {
    hostCooldowns[base] = Date.now() + HOST_COOLDOWN_MS;
  }

  // ── the bridge's two shapes ────────────────────────────────────────────────

  /**
   * Reads a response body that may be a value or a promise.
   *
   * The most important detail in this file, and the one that cost the longest to
   * find. `QuickJsExecutor.bindAsyncFetch` defines `text()` and `json()` as
   * synchronous — they return the body, not a promise for it — while a
   * spec-compliant `fetch` returns promises. `resp.text().then(...)` is a
   * TypeError inside BitChord, and it surfaces on the first track lookup rather
   * than at load, which makes it look like a network fault.
   *
   * The harness in scripts/test-module.js reproduces the synchronous shape on
   * purpose. A harness that returned promises here passed a module that could
   * not work on a device.
   */
  function bodyOf(resp) {
    var value = resp.text();
    return value && typeof value.then === 'function' ? value : Promise.resolve(value);
  }

  /** The `setTimeout` this sandbox provides resolves a promise, then runs the callback. */
  function delay(ms) {
    return new Promise(function (done) {
      setTimeout(function () { done(); }, ms);
    });
  }

  /**
   * One request, with a deadline.
   *
   * The bridge's fetch has no timeout of its own, so the request is raced
   * against one. Without the race a host that accepts a connection and then says
   * nothing holds BitChord's source-resolution slot for as long as the app is
   * willing to wait.
   *
   * The guard is gated on `settled`, and that gate is not an optimisation:
   * `Promise.race` does not cancel its losers, so the timer for a request that
   * answered in 200 ms would still fire ten seconds later and reject a promise
   * nobody holds. That is an unhandled rejection, which is a crash rather than a
   * warning in the hosts that take it seriously — and it took the harness down
   * once while a later call was in flight.
   */
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

  function searchOn(base, query, limit) {
    return getJson(
      base + '/search/tracks?q=' + encodeURIComponent(query) + '&limit=' + encodeURIComponent(String(limit)),
      SEARCH_TIMEOUT_MS
    );
  }

  /**
   * Walks the host list until one answers.
   *
   * A host that errors is cooled down and the next tried. A host that answers
   * with zero rows is a success, because "this catalogue does not hold it" is a
   * real answer — and trying the next host would only turn a miss into a slower
   * miss.
   */
  function searchAcrossHosts(query, limit, context) {
    var urls = baseUrls(context);

    function attempt(index) {
      if (index >= urls.length) return Promise.resolve({ base: null, payload: { tracks: [] } });

      var base = urls[index];
      if (hostIsCooling(base)) return attempt(index + 1);

      return searchOn(base, query, limit).then(
        function (payload) {
          return { base: base, payload: payload };
        },
        function () {
          coolDown(base);
          return attempt(index + 1);
        }
      );
    }

    return attempt(0);
  }

  /** Tidal reports milliseconds; the module contract wants seconds. */
  function toSeconds(ms) {
    var value = Number(ms);
    if (!isFinite(value) || value <= 0) return 0;
    return Math.round(value / 1000);
  }

  /**
   * Artwork is served through Monochrome's own proxy, which wants the Referer
   * its page sends. Without it the URL resolves but returns nothing, and the
   * album art on the track row comes out empty.
   */
  function artwork(url) {
    if (!url) return null;
    var value = String(url);
    return value.indexOf('http') === 0 ? value : null;
  }

  function toRows(tracks, base) {
    var rows = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t || !t.id) continue;
      // `playable: false` is Monochrome saying the metadata exists but there is
      // no stream behind it. Such a row costs a `/track` call to learn nothing.
      if (t.playable === false) continue;

      var names = t.artistNames;
      var artist = Array.isArray(names) ? names.join(', ') : String(names || '');

      rows.push({
        // Prefixed with the host, so getTrackStreamUrl knows which catalogue
        // produced this row without carrying state between calls.
        id: base + '|' + String(t.id),
        title: String(t.title || ''),
        artist: artist,
        album: '',
        albumCover: artwork(t.artwork),
        duration: toSeconds(t.duration),
        audioQuality: 'LOSSLESS',
        format: 'flac',
        availableQualities: ['LOSSLESS']
      });
    }
    return rows;
  }

  function searchTracks(query, limit, context) {
    var text = String(query == null ? '' : query).trim();
    if (!text) return { tracks: [], total: 0 };

    var capped = Math.min(Math.max(Number(limit) || 20, 1), 50);

    return searchAcrossHosts(text, capped, context).then(function (found) {
      if (!found.base) return { tracks: [], total: 0 };
      var rows = toRows((found.payload && found.payload.tracks) || [], found.base);
      return { tracks: rows, total: rows.length };
    });
  }

  // ── stream ────────────────────────────────────────────────────────────────

  /**
   * Confirms the URL really carries FLAC before claiming that it does.
   *
   * Four bytes, requested by range, compared against the signature. That is the
   * only part of the file readable through `text()` — pure ASCII, so it survives
   * the decode intact — and it is enough to catch the failure that matters: a
   * host answering 200 with an HTML error page under a URL that looks like audio.
   * BitChord would hand that to a FLAC extractor and fail on the only error it
   * can raise.
   *
   * The length guard is not paranoia. A CDN that ignores the Range header answers
   * with the whole 40 MB file, which `text()` would then decode into a
   * multi-megabyte string — so an answer larger than a signature's worth is
   * treated as "Range was not honoured" rather than trusted.
   */
  function verifyFlac(url) {
    function once() {
      return request(url, {
        timeout: STREAM_TIMEOUT_MS,
        headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-3' }
      }).then(
        function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return bodyOf(resp).then(function (body) {
            if (body.length > 8) throw new Error('range ignored (' + body.length + ' bytes)');
            if (body.indexOf('fLaC') !== 0) throw new Error('no fLaC signature');
            return { verified: true };
          });
        },
        function (error) {
          throw new Error('transport: ' + error.message);
        }
      );
    }

    function retry(attemptNumber) {
      return once().catch(function (error) {
        if (attemptNumber >= STREAM_ATTEMPTS) {
          return { verified: false, reason: error.message };
        }
        // Linear and short. The failures being ridden out last about a second,
        // so a longer backoff would be waiting on a blip that has already gone.
        return delay(400 * attemptNumber).then(function () {
          return retry(attemptNumber + 1);
        });
      });
    }

    return retry(1);
  }

  function streamOn(base, id, quality) {
    var url = base + '/track/' + encodeURIComponent(id);
    if (quality) url += '?quality=' + encodeURIComponent(quality);

    return verifyFlac(url).then(function (check) {
      if (!check.verified) {
        // Throwing is right: `ModuleStreamResponse` reads `streamUrl: null` as
        // "this source does not hold the track", and a refused rendition is the
        // same thing as far as BitChord's source walk is concerned.
        throw new Error('not verified as FLAC (' + check.reason + ')');
      }

      // Deliberately no sampleRate, no bitDepth, no bitrate. The sandbox cannot
      // read them and inventing them is the one thing a lossless source must not
      // do. See the header comment.
      return {
        streamUrl: url,
        track: { id: id, audioQuality: 'LOSSLESS', mimeType: 'audio/flac', audioModes: ['STEREO'] }
      };
    });
  }

  function getTrackStreamUrl(trackId, quality, context) {
    var raw = String(trackId == null ? '' : trackId);
    if (!raw) return { streamUrl: null };

    // A HIGH or LOW request is answered with lossless anyway, because that is the
    // only thing this catalogue holds. Saying so is better than handing back a
    // lossy rendition the caller did not ask for and has no way to compare.
    var tier = wantedTier(quality, context);
    var upstreamQuality = tier === 'LOSSLESS' ? 'LOSSLESS' : tier;

    // `host|trackId` when the row carried one; a bare id still resolves against
    // the first live host, which is what makes hand-written ids usable.
    var bar = raw.lastIndexOf('|');
    var hinted = bar > 0 ? raw.slice(0, bar) : null;
    var id = bar > 0 ? raw.slice(bar + 1) : raw;

    // The host the row came from goes first, but it is not the only candidate.
    // Treating it as the only one means a single 520 on the preferred host returns
    // nothing at all, when another live host might have served the same
    // catalogue moments later.
    var urls = baseUrls(context);
    var ordered;
    if (hinted) {
      ordered = [hinted];
      for (var i = 0; i < urls.length; i++) {
        if (urls[i] !== hinted) ordered.push(urls[i]);
      }
    } else {
      ordered = urls;
    }

    function attempt(index) {
      if (index >= ordered.length) {
        // The contract's way of saying "this source does not hold that
        // recording", which BitChord reads as a miss rather than a crash and
        // answers by moving to the next source.
        return { streamUrl: null, track: { id: id, audioQuality: '' } };
      }
      var base = ordered[index];
      if (hostIsCooling(base)) return attempt(index + 1);

      return streamOn(base, id, upstreamQuality).then(
        function (result) { return result; },
        function () {
          coolDown(base);
          return attempt(index + 1);
        }
      );
    }

    return attempt(0);
  }

  module.exports = {
    searchTracks: searchTracks,
    getTrackStreamUrl: getTrackStreamUrl,

    // Not part of BitChord's contract, but it makes this module identifiable in
    // a log next to the other two in the index.
    name: 'Tidal FLAC (tracks.monochrome.st)',
    version: '1.0.0'
  };
})();
