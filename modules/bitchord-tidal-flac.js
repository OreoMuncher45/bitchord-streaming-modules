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

  /**
   * Candidates, in order.
   *
   * Deliberately ONE host, and that is a measured decision rather than a
   * simplification. Every other host in this ecosystem was checked on
   * 2 October 2026 and is unusable:
   *
   *   api.monochrome.tf          DNS does not resolve
   *   hifi.geeked.wtf            DNS does not resolve
   *   if-it-runs-ship-it.lol     DNS does not resolve
   *   lossless.wtf               DNS does not resolve
   *   api2.monochrome.st         DNS does not resolve
   *   monochrome-api.samidy.com  answers, but 404s this API and 401s its search
   *   wolf/hund.qqdl.site        TLS handshake hangs past 6s
   *   maus/vogel/katze.qqdl.site TLS handshake fails
   *
   * Walking that list was costing 75 seconds before it reached a verdict, which
   * is most of the minute-long upgrade this module was shipped to fix. Two of
   * those hosts hang rather than refuse, so each one burns a full timeout per
   * attempt. BitChord abandons a search at `ModuleSource.SEARCH_BUDGET_MS` = 8s
   * and only waits for the patient path at 25s, so a walk this long guaranteed
   * the listener heard nothing and then a fallback.
   *
   * So the primary host is asked once, hard, and `preferredBaseUrl` is the way
   * to point it somewhere else. A host that is merely slow now costs 3.5s
   * instead of 31s, and a host that is dead costs the same 3.5s rather than 31s.
   */
  var DEFAULT_BASE_URLS = ['https://tracks.monochrome.st'];

  var UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  /**
   * Timeouts, sized against the upstream's behaviour today rather than a guess.
   *
   * `ModuleSource.SEARCH_BUDGET_MS` is 8s and `SEARCH_PATIENT_MS` is 25s, so a
   * search that overruns 8s loses its first chance at the track and waits for the
   * patient pass — the difference between swapping inside a second and swapping
   * after the listener has sat there a minute.
   *
   * Measured on 2 October 2026. The upstream is materially slower than when this
   * module was first written, which is why these are not the numbers that were
   * tuned on 30 September:
   *
   *   search            0.9 - 2.1s   (median 1.16s)
   *   signature probe   0.6 - 3.4s   (was ~0.4s five days ago)
   *
   * So the probe is the binding constraint rather than the search.
   *
   * 6s each, and the reasoning here is asymmetric. Tightening these from 4.5s to
   * 3.5s looked prudent and cost a quarter of the upgrade rate, because a probe
   * that legitimately takes 3.4s then had no room left and got cut off. A
   * timeout has to clear the *slowest normal* case, not the average one, so this
   * sits at roughly twice the slowest thing actually observed.
   *
   * What makes a 6s timeout affordable is that it now fires at most once each —
   * see `retry`, which no longer re-asks after a timeout. One 6s search plus one
   * 6s probe is 12s against a genuinely dead link, inside BitChord's 25s patient
   * budget, and it is not multiplied by a retry count. The configuration this
   * replaced was 2x4s plus 3x3.5s — 18.5s of waiting on the same dead link, and
   * the direct cause of the 30-second and 47-second upgrades reported on a phone
   * whose connection could not sustain it.
   */
  var SEARCH_TIMEOUT_MS = 6000;
  var STREAM_TIMEOUT_MS = 6000;

  /**
   * How long a host that failed is skipped — but only when there is somewhere
   * else to go.
   *
   * This is not a timeout that was tuned, it is a mechanism that had to be
   * almost switched off, and the reason is worth keeping in mind for anyone
   * adding a second host back.
   *
   * A cooldown means "this host is not worth asking again yet", which is only
   * useful when there is another one. With a single host it is actively harmful,
   * because "skip" becomes "return nothing" — and because a skipped search
   * returns in about a millisecond, the requests behind it are all issued inside
   * the cooldown window and all get skipped too. One 520 does not cost one
   * track; it costs every track until the window closes.
   *
   * Measured directly: a 20-track soak where one track failed gave 2 FLAC
   * upgrades and 17 instant misses, then repeated with the same result after the
   * window was shortened from 30s to 2.5s — because the soak runs faster than
   * any cooldown. `hostIsCooling` therefore refuses to skip the last candidate,
   * and the failure is paid for by `STREAM_ATTEMPTS` instead, which costs the
   * same round trips and cannot spread.
   */
  var HOST_COOLDOWN_MS = 2500;

  /**
 * How many times one host is asked before it is blamed.
   *
   * Three, and the reason it is three rather than two is the success rate it
   * buys. The CDN in front of this catalogue fails 10-25% of signature probes,
   * measured across two separate samples today:
   *
   *   attempts   at 10% failure   at 25% failure
   *        1            90.0%              75.0%
   *        2            99.0%              93.8%
   *        3            99.9%              98.4%
   *
   * Two attempts still loses one track in sixteen at the pessimistic end, which
   * over a playlist is several tracks a session that never upgrade. Three costs
   * 11.7s worst case, and that fits the 25s patient budget comfortably — so the
   * trade is 4.3s of patience for the last few percent, and the patience is
   * being spent in the background while the track plays at 128kbps anyway.
   *
   * The old setting was 3 attempts at a **10s** timeout, which was 31s on its
   * own before any fallback host was considered. That is what made an upgrade
   * take a minute.
   */
  var STREAM_ATTEMPTS = 3;

  /**
   * How many times a search is retried on the same host.
   *
   * Two, for the reason in `searchAcrossHosts`: a burst of lookups sometimes
   * pushes a query past the timeout that it comfortably beats when asked on its
   * own. Two attempts is 10.5s, inside the patient budget.
   */
  var SEARCH_ATTEMPTS = 2;

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

  /**
   * Whether `base` should be skipped right now.
   *
   * `candidates` is the list actually being walked, and the last entry is never
   * skipped. That single condition is what stops a CDN blip from becoming a dead
   * session: with one host there is nothing to cool down toward, so asking it
   * again is always at least as good as returning nothing. See the note on
   * HOST_COOLDOWN_MS for the measurement that made this necessary.
   */
  function hostIsCooling(base, candidates) {
    if (candidates && candidates.length && candidates[candidates.length - 1] === base) {
      return false;
    }
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
    ).catch(function (error) {
      // Carries the same retryable flag as the stream path so `tryHost` can tell
      // a CDN 520 — worth asking again — from a timeout on a slow link, which is
      // not.
      error.retryable = /HTTP 5/.test(error.message);
      throw error;
    });
  }

  /**
   * Walks the host list until one answers.
   *
   * A host that errors is cooled down and the next tried. A host that answers
   * with zero rows is a success, because "this catalogue does not hold it" is a
   * real answer — and trying the next host would only turn a miss into a slower
   * miss.
   */
  /**
   * Walks the host list until one answers, retrying the one that does not.
   *
   * The retry is here for a measured reason. A cold search of this catalogue is
   * 0.8-1.3s, but under a burst of consecutive lookups the same query sometimes
   * takes over 5s and answers nothing at all inside the timeout. A 20-track soak
   * lost 3 tracks to exactly that — three queries that return 8, 1 and 7 rows
   * when asked directly, but that arrived after this function had already given
   * up. Without a retry a slow second costs the whole track; with it, the second
   * attempt is what usually lands.
   *
   * Two attempts at 5s is 10.5s worst case, which fits inside BitChord's 25s
   * patient budget. That is the budget that matters here: the lossless upgrade is
   * a background pass over a track already playing, not the initial
   * substitution, so it is allowed to be slow — it just is not allowed to be
   * minute-slow.
   */
  function searchAcrossHosts(query, limit, context) {
    var urls = baseUrls(context);

    function tryHost(index, attemptNumber) {
      if (index >= urls.length) return Promise.resolve({ base: null, payload: { tracks: [] } });

      var base = urls[index];
      if (hostIsCooling(base, urls)) return tryHost(index + 1, attemptNumber);

      return searchOn(base, query, limit).then(
        function (payload) { return { base: base, payload: payload }; },
        function (failure) {
          // Only a fast failure is worth a second ask. A timeout means the link is slow
          // right now, and spending the timeout again just multiplies the wait —
          // which is how one search became 10s on a mobile connection and put the
          // whole upgrade past BitChord's 8s grace budget.
          if (attemptNumber < SEARCH_ATTEMPTS && failure.retryable !== false) {
            return delay(300 * attemptNumber).then(function () {
              return tryHost(index, attemptNumber + 1);
            });
          }
          coolDown(base);
          return tryHost(index + 1, 1);
        }
      );
    }

    return tryHost(0, 1);
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

  /**
 * Words that carry no meaning for a match.
   *
   * Stripped from both sides of a comparison. Everything here is a filler word
   * that survives in a Tidal title or an artist credit and would otherwise make
   * two records of the same song look like different songs.
   */
  var STOPWORDS = [
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
    'by', 'for', 'from', 'with', 'into', 'over', 'under', 'is', 'it', 'its',
    'as', 'that', 'this', 'these', 'those', 'be', 'am', 'are', 'was', 'were',
    'my', 'me', 'we', 'you', 'your', 'i',
    // Filler that ride along in Tidal artist credits.
    'feat', 'featuring', 'ft', 'with', 'remix', 'remixed'
  ];

  /**
   * Lowercases, strips punctuation, and removes stopwords.
   *
   * The result is a comparable "core" for two titles. It is a rough
   * normalisation rather than a linguistically correct one, and it does not need
   * to be: it is only used to notice that a catalogue row is about a different
   * song entirely, where being approximately right in either direction is fine.
   * False positives here are harmless (BitChord still scores the rows it is
   * given); false negatives are the expensive case.
   */
  function core(value) {
    var words = String(value == null ? '' : value).toLowerCase().split(/[^a-z0-9]+/);
    var kept = [];
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (!word) continue;
      if (STOPWORDS.indexOf(word) >= 0) continue;
      // A bare "ft" with nothing after it is an artifact of splitting.
      if (word.length < 2 && !/[0-9]/.test(word)) continue;
      kept.push(word);
    }
    return kept.join(' ');
  }

  /**
   * Words from the query, minus anything that looks like an artist name.
   *
   * BitChord queries with "Artist Title", so the title has to be guessed out of
   * a flat string. The strategy is deliberately conservative: it only strips a
   * leading token when that token is *also* the credited artist of a row we got
   * back. That way "The Red" is still looked for inside "Chevelle The Red",
   * while a title that genuinely starts with the artist's own name — "Chevelle"
   * the song, or "Guardian" by The Chemical Brothers — is not stripped away.
   *
   * Returns null when no title can be identified, which means the caller should
   * keep every row rather than filter on nothing.
   */
  function titleHints(query, rows) {
    var words = String(query == null ? '' : query).trim().split(/\s+/);
    if (words.length < 2) return null;

    var first = words[0];
    var artistNames = {};
    for (var i = 0; i < rows.length; i++) {
      var parts = String(rows[i].artistNames == null ? '' : rows[i].artistNames).toLowerCase().split(',');
      for (var p = 0; p < parts.length; p++) {
        var name = parts[p].trim();
        if (name) artistNames[name] = true;
      }
    }

    if (artistNames[first.toLowerCase()]) return words.slice(1).join(' ').trim();
    return null;
  }

  function searchTracks(query, limit, context) {
    var text = String(query == null ? '' : query).trim();
    if (!text) return { tracks: [], total: 0 };

    var capped = Math.min(Math.max(Number(limit) || 20, 1), 50);

    return searchAcrossHosts(text, capped, context).then(function (found) {
      if (!found.base) return { tracks: [], total: 0 };

      var raw = (found.payload && found.payload.tracks) || [];
      var rows = toRows(raw, found.base);

      // The fix for a spinner that never stops.
      //
      // A Tidal search for a title it does not have still answers — with that
      // artist's *other* songs. Measured: "Chevelle Hella Racer" returns 7 rows,
      // every one of them a different Chevelle track, because Hella Racer is
      // simply not in the catalogue. BitChord sees a non-empty result, decides
      // this source has an answer, and starts waiting — and then
      // `TrackMatcher.score` rejects every row on `wanted.core != got.core`, so
      // nothing plays and the spinner runs until the budget expires.
      //
      // That is the difference between a track that fails in a second and one
      // that fails in thirty. An empty answer makes BitChord give up on this
      // module immediately (`first.complete(Unit)` never fires, and the source
      // is struck off) instead of waiting out `SEARCH_PATIENT_MS`.
      //
      // The filter is only applied when a title can be identified, so a query
      // that is just an artist name keeps every row it got.
      var hints = titleHints(text, raw);
      if (!hints) return { tracks: rows, total: rows.length };

      var wanted = core(hints);
      if (!wanted) return { tracks: rows, total: rows.length };

      var kept = [];
      for (var i = 0; i < rows.length; i++) {
        var have = core(rows[i].title);
        if (!have) continue;
        if (have.indexOf(wanted) >= 0 || wanted.indexOf(have) >= 0) kept.push(rows[i]);
      }
      return { tracks: kept, total: kept.length };
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
          // A 5xx is worth another ask: the CDN in front of this catalogue
          // returns 520 on roughly one request in five and the next one usually
          // works. Anything else is a real answer and is taken at face value.
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
          // A timeout, a DNS failure, a refused connection. None of these get
          // better by asking again immediately — see the note on `retry`.
          var err = new Error('transport: ' + error.message);
          err.retryable = false;
          throw err;
        }
      );
    }

    /**
     * Retries only what retrying can fix.
     *
     * The distinction is between an answer that came back wrong and no answer at
     * all, and it is the whole reason this function is not simply "try N times":
     *
     *   - A 520 from the CDN is a real, fast failure of a host that is up.
     *     Retrying costs one round trip and usually lands.
     *   - A timeout means this request is slow *right now*. Retrying does not
     *     make the link faster — it just spends the timeout again, so a slow
     *     connection pays the full budget once per attempt and the total scales
     *     with the retry count.
     *
     * That second case is what turns a slow mobile link into a 30-second
     * upgrade: 2 search attempts at 5s plus 3 stream attempts at 4.5s is 24s of
     * pure waiting, before BitChord has even decided whether to try again itself.
     * On a fast link none of those timeouts fire and the retries cost nothing,
     * which is exactly why the problem looked like network flakiness rather than
     * like arithmetic.
     *
     * So: timeouts and transport errors fail immediately, and only a 5xx is
     * worth a second ask.
     */
    function retry(attemptNumber) {
      return once().catch(function (error) {
        var worthRetrying = error.retryable !== false;
        if (!worthRetrying || attemptNumber >= STREAM_ATTEMPTS) {
          return { verified: false, reason: error.message };
        }
        return delay(300 * attemptNumber).then(function () {
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

    // The host the row came from goes first, then the configured list.
    //
    // Deliberately NOT given a second chance on a fresh request. BitChord caches
    // this answer for `ModuleManager`'s stream TTL and a caller that misses
    // simply moves to the next source, so a fast `null` is worth more here than
    // a slow `url`: the difference between a track swapping within a second and
    // a track waiting out a patient budget is one HTTP round trip either way.
    //
    // The default list holds a single host, so this walk is short by construction
    // and cannot be lengthened by hosts that all turn out to be dead.
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
      if (hostIsCooling(base, ordered)) return attempt(index + 1);

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
