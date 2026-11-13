/*!
 * MBP Native Player -- movieboxpro.app on a Samsung TV, driven by the remote
 *
 * Two jobs in one page load, and no mode switch between them:
 *
 *   1. BROWSING. The site is built for touch, so nothing on it is reachable
 *      with a D-pad. This draws a highlight over the page's own controls and
 *      moves it with the arrow keys, so the site's existing pages -- sign-in,
 *      search, a series' episode list -- work from the sofa.
 *
 *   2. PLAYING. The moment the page produces player data, navigation shuts
 *      down and the screen is taken over by a plain <video> element with its
 *      own overlay: quality, subtitles, resume, next episode, diagnostics.
 *      The site's own player is never driven; it is replaced.
 *
 * The handover is the whole design: one page load, one owner of the keys at a
 * time, and no flag the viewer can see or get stuck in.
 *
 * While playing, it does its own source lookup and bookkeeping:
 *
 *   parse qualityLevels out of the page -> pick a rung -> <video src>
 *   -> <track> from /index/index/get_srt_content?...&format=vtt&delay=
 *   -> progress to /index/index/{tv,movie}_progress
 *   -> on expiry or wake, re-fetch /index/index/player and resume in place
 *
 * A TizenBrew *site mod*, not an app module, and that is deliberate: the site
 * sends no Access-Control-Allow-Origin, so a module on http://127.0.0.1:8081
 * cannot read a single API response. Running on movieboxpro.app makes every
 * call same-origin and sends the session cookies automatically. See
 * DELIVERY.md section 0.
 *
 * Plain ES5, no build step, no dependencies.
 *
 * Keys, browsing:
 *   Arrows   move the highlight        OK     activate what is highlighted
 *   Blue     help, and page size       Back   back, or leave at the first page
 *
 * Keys, playing:
 *   OK       tap to pause, HOLD for settings
 *   Up/Down  settings (the same panel -- holding OK is untested on real
 *            hardware, so nothing is reachable only that way)
 *   Left/Right  seek 10s               FF/RW  seek 60s
 *   Green    settings, on subtitles    Red    subtitles on/off
 *   Blue     diagnostics               Back   leave the player
 *
 * Settings holds quality, subtitles, subtitle delay, next episode and
 * diagnostics. Up/Down chooses a row, Left/Right changes it, Back closes.
 *
 * This header describes the shape, not the state. Anything that changes from
 * release to release -- what has been tried on a TV, what is still unverified,
 * what the open questions are -- lives in DELIVERY.md and TEST.md, because the
 * version of this comment that said "vertical slice" and "one hard-coded
 * title" stayed in the published file for six releases after both had stopped
 * being true. A status claim in a header is a status claim nobody updates.
 */
(function () {
  'use strict';

  var W = window, D = document;
  if (W.top !== W) return;              // mods are injected into every frame
  if (W.__mbpSlice) return;
  W.__mbpSlice = true;

  // Build identity, shown first on the diagnostics screen.
  //
  // The problem this solves: jsDelivr serves a `@branch` URL from cache for
  // hours, so the TV can run a build that no longer exists while the person
  // testing assumes it is current. On a one-shot test session that is the most
  // expensive possible failure -- every number on the photograph describes
  // code nobody can look at any more.
  //
  // A commit SHA would be ideal but needs a build step, and a hand-edited one
  // drifts the moment somebody forgets. So the stamp is two parts: a version
  // that a test keeps in step with package.json, and the script URL the
  // browser ACTUALLY loaded, which is not a claim at all -- it is observed,
  // and it exposes whether an immutable tag or a cache-prone branch was used.
  //
  // Must be read at top level: currentScript is null once anything async runs.
  var BUILD_VERSION = '0.4.6';
  // A commit cannot contain its own hash, so this is a placeholder in source
  // and is rewritten by tools/sync-dist.js with the SHA of the commit the
  // published copy was cut from. 'dev' therefore means "running from source",
  // which is itself worth seeing on the diagnostics screen.
  var BUILD_SHA = 'dev';
  var BUILD_SRC = (function () {
    try {
      var s = D.currentScript;
      if (s && s.src) return s.src;
      // Fall back to the last script tag pointing at our filename.
      var all = D.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && /userScript\.js/i.test(all[i].src)) return all[i].src;
      }
    } catch (e) {}
    return '(inline or unknown)';
  })();

  var CFG = {
    // What a (re)fetch should ask for. A movie's file id goes in `mfid`, an
    // episode's in `tfid` -- different parameters on the same endpoint, so the
    // kind must travel with the id; a client that only knows tfid cannot open
    // a film at all.
    //
    // DELIBERATELY EMPTY, and it must stay that way. Two reasons:
    //
    //  - No real resource id belongs in a file that executes. This slice is
    //    published, and a baked id is the user's library by implication. It is
    //    also how a placeholder quietly becomes a live call against a real
    //    title. (Two 7-digit ids used to sit here. Neither could be traced
    //    back to a capture afterwards, which is the whole argument: a bare
    //    integer literal keeps no provenance.)
    //  - Nothing needs it. The dev hatch carries its own id in the URL
    //    (`?mbpopen=tv:<id>`), and the normal path learns the id from the
    //    player page in `start()`. An id here would only ever be a wrong
    //    answer waiting to be used -- see the guard in `refreshLink`.
    open: { kind: null, id: null },
    // Deliberately conservative, and the reason is measured rather than
    // cautious by temperament. A codec string from canPlayType is the decoder
    // SAYING it can, which is not evidence that it does: project 1 climbed to
    // a 4K HEVC rung on exactly that basis on a real set, and the player then
    // buffered for good. This project's own TEST.md says the same thing --
    // only the dropped-frame count at a high rung is evidence -- and then
    // shipped a default that trusted the claim anyway.
    //
    // So the automatic choice stays at or below this, with the newer codecs
    // off. Anything above it is a deliberate choice made in the settings
    // panel, remembered, and steppable back down the same way.
    maxHeight: 1080,
    maxMbps: 40,
    allowHevc: false,
    seekStep: 10,
    seekStepBig: 60,
    progressEvery: 60000,
    osdTimeout: 4000
  };

  // ---------------------------------------------------------------- helpers
  function el(tag, css, text) {
    var n = D.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return (h > 0 ? h + ':' + z(m) : m) + ':' + z(s);
  }

  // ------------------------------------------------------- parsing the page
  // The player response is an HTML fragment whose <script> blocks hold the
  // data. qualityLevels carries the signed URLs; there is no lookup API.

  // Bracket matcher that steps over string literals, so a URL containing a
  // bracket cannot end the match early.
  function matchBracket(s, i) {
    var open = s.charAt(i), close = open === '[' ? ']' : '}';
    var depth = 0, inStr = false, quote = '', esc = false;
    for (var k = i; k < s.length; k++) {
      var c = s.charAt(k);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return k; }
    }
    return -1;
  }

  function extractJson(html, name) {
    var m = new RegExp('var\\s+' + name + '\\s*=\\s*').exec(html);
    if (!m) return null;
    var start = m.index + m[0].length;
    var ch = html.charAt(start);
    if (ch !== '[' && ch !== '{') return null;
    var end = matchBracket(html, start);
    if (end < 0) return null;
    try { return JSON.parse(html.slice(start, end + 1)); } catch (e) { return null; }
  }

  // A film's player page is ~561 KB. This runs on every play, on a TV CPU, so
  // the parse is on the critical path and the shape of it matters more than
  // micro-optimising any one step.
  //
  // The rule here: ONE pass over the response. The earlier version made 17 --
  // a separate full-string regex for each of 13 scalars, three more for the
  // JSON blocks, and one for subtitles. Now a single sweep records where every
  // `var name =` begins, and each value is read from its own offset with a
  // bounded scan. Nothing re-reads the whole string.
  //
  // Backtracking is the other hazard, and worse than slowness: a pathological
  // pattern over half a megabyte is a hang, not a delay, on any CPU. Every
  // pattern below is anchored or uses disjoint alternatives, and none has the
  // `[^x]*A[^x]*` shape that made the old subtitle scan quadratic per tag.
  var SCALAR_LIMIT = 512;          // a `var x = ...;` value is never longer

  function collectVars(html) {
    var out = {}, re = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*/g, m;
    while ((m = re.exec(html)) !== null) {
      // First declaration wins: the page re-declares some names in later
      // branches, and the first is the one the player actually used.
      if (!Object.prototype.hasOwnProperty.call(out, m[1])) {
        out[m[1]] = m.index + m[0].length;
      }
    }
    return out;
  }

  function scalarAt(html, start) {
    if (start == null) return null;
    var end = start, limit = Math.min(html.length, start + SCALAR_LIMIT), c;
    while (end < limit) { c = html.charAt(end); if (c === ';' || c === '\n') break; end++; }
    var raw = html.slice(start, end).trim().replace(/,$/, '');
    if (!raw) return null;
    // Disjoint alternatives, so linear: [^"\\] and \\. cannot both match.
    var str = /^"((?:[^"\\]|\\.)*)"$/.exec(raw) || /^'((?:[^'\\]|\\.)*)'$/.exec(raw);
    if (str) {
      try { return JSON.parse('"' + str[1].replace(/"/g, '\\"') + '"'); } catch (e) { return str[1]; }
    }
    var num = parseFloat(raw);
    return isFinite(num) ? num : raw;
  }

  function jsonAt(html, start) {
    if (start == null) return null;
    var ch = html.charAt(start);
    if (ch !== '[' && ch !== '{') return null;
    var end = matchBracket(html, start);        // forward-only, bounded by the literal
    if (end < 0) return null;
    try { return JSON.parse(html.slice(start, end + 1)); } catch (e) { return null; }
  }

  // Kept for callers that have only the html (the selftest drives these
  // directly). parsePlayerPage uses the offset map instead of re-scanning.
  function extractScalar(html, name) { return scalarAt(html, collectVars(html)[name]); }
  function extractJson(html, name) { return jsonAt(html, collectVars(html)[name]); }

  // Subtitle tracks live inside a jQuery .prepend('<div>...') string literal,
  // so they are not parseable as DOM from the response. Anchor on data-sid --
  // the one attribute that must be present -- then expand to the enclosing
  // tag. The old version scanned every <li> and backtracked inside each one
  // that lacked the attribute.
  function extractSubtitles(html) {
    var out = [], re = /\bdata-sid\s*=\s*"(\d+)"/g, m;
    while ((m = re.exec(html)) !== null) {
      var lt = html.lastIndexOf('<', m.index);
      if (lt < 0) continue;
      var gt = html.indexOf('>', m.index);
      if (gt < 0) break;
      var tag = html.slice(lt, gt);
      if (!/^<li\b/i.test(tag)) continue;
      var t = {}, aRe = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g, a;
      while ((a = aRe.exec(tag)) !== null) t[a[1]] = a[2];
      if (!t['data-sid'] || !t['data-url']) continue;
      var delay = parseFloat(t['data-delay']);
      out.push({
        sid: t['data-sid'],
        url: t['data-url'],
        delay: isFinite(delay) ? delay : 0,
        lang: t['data-lang'] || '',
        name: (t['data-name'] || '').replace(/^\[[^\]]*\]/, '') || ('Subtitle ' + out.length)
      });
    }
    return out;
  }

  // Timings the TV is the only place to learn. DELIVERY.md asks for the
  // fetch/parse/first-frame split so a bad total gets blamed on the right
  // stage; this is where those numbers come from.
  var marks = { bytes: 0, parseMs: 0, fetchMs: 0, toFirstFrame: 0, takeoverAt: 0 };
  function now() {
    try { return W.performance && W.performance.now ? W.performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }

  function parsePlayerPage(html) {
    var t0 = now();
    var out = parsePlayerPageInner(html);
    marks.parseMs = now() - t0;
    marks.bytes = html ? html.length : 0;
    return out;
  }

  // What a refresh has to re-request. NOT `tid` or `mid`: those are title ids
  // in a different space from the file ids the player endpoint takes, and
  // sending one where the other belongs is a silent wrong answer.
  //
  // `pfid` is preferred because it names its own parameter ("tfid=NNN"), so
  // the kind travels with the value instead of being inferred.
  // `currentResourceFid` is the fallback, with the kind from the tid test.
  //
  // Both are recorded as present on the player page in MILESTONE-1.md and are
  // reproduced in the fixture -- but neither is re-verifiable here without a
  // real player page, and the fixture is my own construction, so it cannot be
  // evidence for what the real page holds. **Returning null is therefore a
  // supported answer, and every caller must handle it.** Declining to refresh
  // is correct; refreshing the wrong title is not.
  function fetchTarget(pfid, fid, tid) {
    var m = /^\s*(tfid|mfid)\s*=\s*(\d+)\s*$/.exec(String(pfid == null ? '' : pfid));
    if (m) return { kind: m[1] === 'mfid' ? 'movie' : 'tv', id: m[2] };
    if (fid != null && String(fid) !== '' && /^\d+$/.test(String(fid))) {
      return { kind: tid ? 'tv' : 'movie', id: String(fid) };
    }
    return null;
  }

  function parsePlayerPageInner(html) {
    var v = collectVars(html);                  // the only full pass for scalars
    function s(name) { return scalarAt(html, v[name]); }
    var tid = s('tid');
    return {
      quality: jsonAt(html, v['qualityLevels']) || [],
      resources: jsonAt(html, v['resourceFileList']) || [],
      subs: extractSubtitles(html),
      currentSid: s('current_sid'),
      seconds: s('seconds') || 0,
      tid: tid,
      mid: s('mid'),
      season: s('current_season'),
      episode: s('current_episode'),
      nextSeason: s('next_season'),
      nextEpisode: s('next_episode'),
      mp4Id: s('mp4_id'),
      title: s('mbpPlayerTitle') || 'MovieBoxPro',
      skips: s('skips'),
      // A series page carries `tid`; a film page carries `mid`. Confirmed
      // against the live site on 11 Nov 2026: `mid` present and `tid`
      // verified absent on a film page (SITE-MARKUP.md).
      kind: tid ? 'tv' : 'movie',
      // May be null. See fetchTarget.
      target: fetchTarget(s('pfid'), s('currentResourceFid'), tid)
    };
  }

  // --------------------------------------------------------- codec / rungs
  function canPlay(mime) {
    try {
      var v = D.createElement('video');
      var r = v.canPlayType(mime);
      if (r === 'probably' || r === 'maybe') return true;
    } catch (e) {}
    try { return !!(W.MediaSource && W.MediaSource.isTypeSupported(mime)); } catch (e) {}
    return false;
  }
  var SUPPORTS_HEVC = canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
                      canPlay('video/mp4; codecs="hev1.1.6.L93.B0"');
  var SUPPORTS_EC3 = canPlay('audio/mp4; codecs="ec-3"');

  function isSamsungTv() {
    var u = (navigator.userAgent || '').toLowerCase();
    return /tizen|smart-tv|hbbtv|orsay/.test(u) || (/samsung/.test(u) && /\btv\b/.test(u));
  }
  function isHls(q) {
    var s = q && q.sources && q.sources[0];
    if (!s) return false;
    if (String(q.name).toUpperCase() === 'ORG') return false;
    var t = String(s.type || '').toLowerCase();
    return t.indexOf('mpegurl') >= 0 || /\.m3u8(\?|$)/i.test(String(s.src || ''));
  }
  // The site forces AAC on Samsung/LG because TV browsers don't decode E-AC-3.
  // Copied deliberately -- see DELIVERY.md.
  function withAac(src) {
    var u = String(src || '');
    if (!u || /[?&]audio=aac(&|$)/.test(u)) return u;
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'audio=aac';
  }
  function needsAac() { return isSamsungTv() || !SUPPORTS_EC3; }

  function rungHeight(q) {
    if (q.height) return parseInt(q.height, 10) || 0;
    var n = String(q.name || '');
    if (/4k|uhd|2160/i.test(n)) return 2160;
    var m = /(\d{3,4})p/i.exec(n);
    return m ? parseInt(m[1], 10) : 0;
  }
  function rungMbps(q) { return (parseFloat(q.bitstream) || 0) / 1000; }

  // The rung the viewer last chose for themselves, by name rather than by
  // height, so the codec travels with it and a 4K HEVC choice does not come
  // back as a 4K H.264 one on the next title.
  var SAFE_HEIGHT = 1080;
  var RUNG_KEY = 'mbp_rung_name';
  function rungPref() {
    try { return W.localStorage.getItem(RUNG_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberRung(name) {
    try { W.localStorage.setItem(RUNG_KEY, String(name || '')); } catch (e) {}
  }

  // Every rung this set can decode at all, lowest first. The HEVC test here is
  // a hard gate (the set cannot play it), not a quality ceiling -- the ceiling
  // lives in pickRung, so the panel can still offer a climb above it.
  function usableRungs() {
    var d = state.data, out = [], i;
    if (!d || !d.quality) return out;
    for (i = 0; i < d.quality.length; i++) {
      var q = d.quality[i];
      if (String(q.name || '').toUpperCase() === 'ORG') continue;
      if (!q.sources || !q.sources[0] || !q.sources[0].src) continue;
      if (q.sources[0].h265 && !SUPPORTS_HEVC) continue;
      out.push({ i: i, h: rungHeight(q), q: q });
    }
    out.sort(function (a, b) { return a.h - b.h; });
    return out;
  }

  function rungLabel(e2) {
    if (!e2) return '-';
    var q = e2.q, bits = [];
    bits.push(q.name || (e2.h ? e2.h + 'p' : '?'));
    if (q.width && q.height) bits.push(q.width + 'x' + q.height);
    if (q.codec) bits.push(q.codec);
    return bits.join('  ');
  }

  // Left is always down and Right is always up: this CLAMPS rather than wraps,
  // because the one thing a quality control on an untested panel must do is let
  // a bad choice be undone. Wrapping from the top rung to the bottom reads as a
  // glitch at the exact moment the viewer is trying to escape a stall.
  function stepRung(dir) {
    var list = usableRungs();
    if (list.length < 2) { osd('Only one quality available'); return; }
    var at = -1, i;
    for (i = 0; i < list.length; i++) if (list[i].i === state.rung) at = i;
    if (at < 0) at = 0;
    var next = at + dir;
    if (next < 0 || next >= list.length) return;
    rememberRung(list[next].q.name || '');
    playRung(list[next].i, true);
    renderSettings();
  }

  function pickRung(levels) {
    // A rung the viewer chose themselves wins, when this title has it. They
    // reached it from the panel and can step back down the same way, so this
    // is their decision rather than a guess of ours.
    var want = rungPref(), k;
    if (want) {
      for (k = 0; k < levels.length; k++) {
        var lq = levels[k];
        if (String(lq.name || '') !== want) continue;
        if (!lq.sources || !lq.sources[0] || !lq.sources[0].src) continue;
        if (lq.sources[0].h265 && !SUPPORTS_HEVC) continue;
        return k;
      }
    }
    var best = -1, bestH = -1;
    for (var i = 0; i < levels.length; i++) {
      var q = levels[i], name = String(q.name || '').toUpperCase();
      if (name === 'ORG') continue;                       // unknown codec/audio
      if (!q.sources || !q.sources[0] || !q.sources[0].src) continue;
      if (q.sources[0].h265 && !(SUPPORTS_HEVC && CFG.allowHevc)) continue;
      var h = rungHeight(q);
      if (h && h > CFG.maxHeight) continue;
      if (CFG.maxMbps && rungMbps(q) > CFG.maxMbps) continue;
      if (h > bestH || (h === bestH && name === 'AUTO')) { bestH = h; best = i; }
    }
    if (best < 0) { for (var j = 0; j < levels.length; j++) if (levels[j].sources && levels[j].sources[0]) return j; }
    return best;
  }

  function sourceFor(q) {
    var s = q.sources[0];
    var src = s.src;
    if (isHls(q) && needsAac()) src = withAac(src);
    return { src: src, type: s.type || (/\.m3u8(\?|$)/i.test(src) ? 'application/x-mpegURL' : 'video/mp4') };
  }

  // ------------------------------------------------------------------- UI
  var ui = {};
  var state = {
    // session-scoped: survives an episode change (see endEpisode)
    wired: false, progressTimer: null, subOn: true, tookOver: false,
    guard: null, hidden: 0,
    okHeld: false,
    wakeTimer: null, lastTick: 0, wasPlaying: false,
    pairing: false, pairExpired: false, pairTimer: null,
    // episode-scoped: cleared by endEpisode()
    data: null, rung: -1, sub: null, subIndex: 0, skips: null,
    panel: null, panelRow: 0, skipKind: null, skipAction: null, skipTimer: null,
    needsRefresh: false,
    stallShowTimer: null, stallGiveUpTimer: null, stallTick: null, diagTick: null,
    osdTimer: null, recovering: false, lastRecover: 0
  };

  function buildUi() {
    try { D.documentElement.innerHTML = '<head></head><body></body>'; } catch (e) {}
    D.title = 'MBP Native Player';
    var s = el('style');
    s.textContent =
      'html,body{margin:0;height:100%;background:#000;overflow:hidden;' +
      'font:16px/1.4 system-ui,Arial,sans-serif;color:#fff}' +
      // Explicit layers. buildUi() wipes the document, but the SITE'S SCRIPTS
      // ARE STILL RUNNING and keep inserting their own player chrome into the
      // fresh body. Without a z-index those late arrivals win on document
      // order alone, which is what put the site's controls over ours.
      // 1 video, 30 panes, 40 the full-screen message. The settings panel and
      // focus ring already carry their own, higher, values.
      '#v{position:fixed;inset:0;width:100%;height:100%;background:#000;object-fit:contain;z-index:1}' +
      '#v::cue{font-size:2.2vw;background:rgba(0,0,0,.55)}' +
      '.pane{position:fixed;left:0;right:0;padding:40px 60px;z-index:30;' +
      'transition:opacity .25s;background:linear-gradient(transparent,rgba(0,0,0,.85))}' +
      '#osd{bottom:0}' +
      '#bar{height:6px;background:rgba(255,255,255,.25);border-radius:3px;margin:14px 0 8px}' +
      '#fill{height:100%;width:0;background:#7fd0ff;border-radius:3px}' +
      '#msg{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;' +
      'flex-direction:column;gap:14px;text-align:center;padding:40px;background:#000}' +
      '.dim{color:#8fa3b8;font-size:14px}' +
      '.big{font-size:30px;font-weight:700;color:#7fd0ff}';
    D.head.appendChild(s);

    ui.video = el('video');
    ui.video.id = 'v';
    ui.video.setAttribute('playsinline', '');
    ui.video.preload = 'auto';
    D.body.appendChild(ui.video);

    ui.osd = el('div'); ui.osd.id = 'osd'; ui.osd.className = 'pane';
    ui.title = el('div', 'font-size:24px;font-weight:600');
    ui.bar = el('div'); ui.bar.id = 'bar';
    ui.fill = el('div'); ui.fill.id = 'fill';
    ui.bar.appendChild(ui.fill);
    ui.meta = el('div', 'display:flex;justify-content:space-between;font-size:15px;color:#cfe0ef');
    ui.time = el('span'); ui.info = el('span');
    ui.meta.appendChild(ui.time); ui.meta.appendChild(ui.info);
    ui.osd.appendChild(ui.title); ui.osd.appendChild(ui.bar); ui.osd.appendChild(ui.meta);
    D.body.appendChild(ui.osd);

    ui.msg = el('div'); ui.msg.id = 'msg';
    D.body.appendChild(ui.msg);

    markOurs();
    guardBody();
  }

  /* Tag everything this module owns, so the guard can tell ours from theirs
   * without maintaining a list that will drift the moment anyone adds a pane. */
  var OURS = 'data-mbp-own';

  function markOurs() {
    var i, kids = D.body.childNodes;
    for (i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 1) { kids[i].setAttribute(OURS, '1'); }
    }
  }

  /* Anything added to <body> after the takeover that we did not tag is site
   * chrome arriving late. Count it as well as hide it: a number on the
   * diagnostics screen turns 'the controls look wrong' into something
   * measurable, which is how the last four bugs actually got found. */
  function guardBody() {
    if (!W.MutationObserver) { return; }
    try {
      state.guard = new W.MutationObserver(function (recs) {
        var i, j, n;
        for (i = 0; i < recs.length; i++) {
          for (j = 0; j < recs[i].addedNodes.length; j++) {
            n = recs[i].addedNodes[j];
            if (n.nodeType !== 1) { continue; }
            if (n.getAttribute && n.getAttribute(OURS)) { continue; }
            try { n.style.display = 'none'; } catch (e) {}
            state.hidden++;
          }
        }
      });
      state.guard.observe(D.body, { childList: true });
    } catch (e) {}
  }

  function showMsg() {
    ui.msg.innerHTML = '';
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      ui.msg.appendChild(typeof a === 'string' ? el('div', null, a) : a);
    }
    ui.msg.style.display = 'flex';
  }
  function hideMsg() { ui.msg.style.display = 'none'; }

  function osd(note) {
    if (note) ui.info.textContent = note;
    ui.osd.style.opacity = '1';
    clearTimeout(state.osdTimer);
    state.osdTimer = setTimeout(function () { ui.osd.style.opacity = '0'; }, CFG.osdTimeout);
  }

  function tick() {
    var v = ui.video, d = v.duration || 0;
    ui.time.textContent = fmt(v.currentTime) + (d ? ' / ' + fmt(d) : '');
    ui.fill.style.width = (d ? (v.currentTime / d * 100) : 0) + '%';
  }

  // --------------------------------------------------------------- network
  function fetchPlayer(item, resumeAt) {
    var param = (item && item.kind === 'movie') ? 'mfid' : 'tfid';
    var url = '/index/index/player?' + param + '=' + encodeURIComponent(item.id);
    var fetchStart = now();
    if (resumeAt > 0) url += '&seconds=' + Math.floor(resumeAt);
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) {
      marks.fetchMs = now() - fetchStart;
      if (!r.ok) throw new Error('player ' + r.status);
      return r.text();
    }).then(function (text) {
      // An error comes back as JSON instead of the HTML fragment.
      if (isUnauthenticated(text)) {
        var e = new Error('not signed in');
        e.needsAuth = true;
        throw e;
      }
      var t = text.replace(/^\s+/, '');
      if (t.charAt(0) === '{') {
        var j = null;
        try { j = JSON.parse(t); } catch (e) {}
        if (j && j.code < 0) throw new Error(j.msg || 'player refused');
      }
      return text;
    });
  }

  // KEY2 is a Unix expiry, ~4h from issue. Worth reading rather than waiting
  // for a mid-film failure: a long title can outlive its own link.
  // An HLS master carries TWO windows: `t` (+4h) and `KEY2` (+6h). The
  // segments expire on the 4h one, so reading KEY2 off a master would be two
  // hours optimistic and the refresh would fire after playback had already
  // died. Take the earliest of whatever is present.
  function urlExpiry(src) {
    var s = String(src || ''), best = 0;
    var pats = [/[?&]t=(\d{9,})/, /[?&]KEY2=(\d{9,})/];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].exec(s);
      if (!m) continue;
      var v = parseInt(m[1], 10);
      if (!isFinite(v)) continue;
      if (!best || v < best) best = v;
    }
    return best;
  }
  function secondsUntilExpiry(src) {
    var e = urlExpiry(src);
    return e ? e - Math.floor(Date.now() / 1000) : Infinity;
  }

  function episodesFor(tid, season) {
    return fetch('/index/index/player_tv_episodes?tid=' + encodeURIComponent(tid) +
                 '&season=' + encodeURIComponent(season), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.code >= 0 && j.data) ? j.data : null; });
  }

  // --------------------------------------------------------------- pairing
  // MovieBoxPro pairs a device with an 8-digit code: show it, poll, receive
  // ui + ci. Nothing is typed on the remote. On a site mod this only runs when
  // the inherited session has expired; a packaged app would need it every time,
  // since it has no browser session to inherit.
  var PAIR = { pollMs: 1500, lifeMs: 120000 };

  function isUnauthenticated(text) {
    var t = String(text || '');
    if (/PRIVATE GARDEN|This is a private club/i.test(t)) return true;
    var head = t.replace(/^\s+/, '').charAt(0);
    if (head === '{') {
      try {
        var j = JSON.parse(t.replace(/^\s+/, ''));
        if (j && j.code < 0 && j.data && /login/i.test(String(j.data.redirect || ''))) return true;
      } catch (e) {}
    }
    return false;
  }

  function extractPairCode(html) {
    var m = /var\s+qr_code\s*=\s*'(\d{4,12})'/.exec(html);
    if (m) return m[1];
    m = /id="qrcode"[^>]*>\s*(\d{4,12})\s*</.exec(html);
    return m ? m[1] : null;
  }

  function persistAuth(ui, ci) {
    // Mirror what device_bind.js does, and set the cookies ourselves rather
    // than assuming the poll response carried Set-Cookie.
    try {
      if (ui) localStorage.setItem('mbp_ui', ui);
      if (ci) localStorage.setItem('mbp_ci', ci);
    } catch (e) {}
    try {
      var common = '; path=/; max-age=' + (400 * 24 * 3600);
      if (ui) D.cookie = 'ui=' + encodeURIComponent(ui) + common;
      if (ci) D.cookie = 'ci=' + encodeURIComponent(ci) + common;
    } catch (e) {}
  }

  function startPairing(onPaired) {
    if (state.pairing) return;
    state.pairing = true;
    showMsg(el('div', 'font-size:22px', 'Sign in to MovieBoxPro'),
            el('div', 'class', ''),
            el('div', 'color:#8fa3b8', 'Fetching a pairing code...'));

    fetch('/index/login/code_login', { credentials: 'same-origin' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var code = extractPairCode(html);
        if (!code) throw new Error('no pairing code in the login page');
        var codeEl = el('div', 'font-size:64px;font-weight:800;letter-spacing:10px;color:#7fd0ff', code);
        var note = el('div', 'color:#8fa3b8', 'Enter this code on a signed-in device. Expires in 2 minutes.');
        showMsg(el('div', 'font-size:22px', 'Sign in to MovieBoxPro'), codeEl, note);

        var started = Date.now(), inFlight = false;
        clearInterval(state.pairTimer);
        state.pairTimer = setInterval(function () {
          if (Date.now() - started > PAIR.lifeMs) {
            clearInterval(state.pairTimer);
            state.pairing = false;
            note.textContent = 'Code expired. Press OK to get a new one.';
            codeEl.style.opacity = '0.35';
            state.pairExpired = true;
            return;
          }
          if (inFlight) return;
          inFlight = true;
          fetch('/index/login/captcha_query', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: 'qr_code=' + encodeURIComponent(code)
          }).then(function (r) { return r.json(); })
            .then(function (j) {
              inFlight = false;
              if (!j || j.code !== 1) return;
              clearInterval(state.pairTimer);
              state.pairing = false;
              state.pairExpired = false;
              persistAuth(j.ui || '', j.ci || '');
              note.textContent = 'Signed in.';
              if (onPaired) onPaired();
            })['catch'](function () { inFlight = false; });
        }, PAIR.pollMs);
      })['catch'](function (err) {
        state.pairing = false;
        showMsg(el('div', 'font-size:22px', 'Could not start sign-in'),
                el('div', 'color:#ff8f8f', String(err && err.message || err)));
      });
  }

  // Persist the viewer's choices back to the account, the way the site does.
  // Both are fire-and-forget: a failure here must never interrupt playback.
  function rememberSubtitle(sub) {
    var d = state.data;
    if (!d || !d.tid || !sub) return;
    try {
      fetch('/index/index/subtitle_select', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'sid=' + encodeURIComponent(sub.sid) + '&tid=' + d.tid +
              '&season=' + d.season + '&episode=' + d.episode
      })['catch'](function () {});
    } catch (e) {}
  }

  function rememberDelay(sub) {
    if (!sub) return;
    try {
      fetch('/index/index/set_srt_delay?sid=' + encodeURIComponent(sub.sid) +
            '&delay=' + encodeURIComponent(String(sub.delay)) + '&type=2',
            { credentials: 'same-origin' })['catch'](function () {});
    } catch (e) {}
  }

  function subtitleVttUrl(sub) {
    var u = '/index/index/get_srt_content?srt_path=' + encodeURIComponent(sub.url) + '&format=vtt';
    if (sub.delay) u += '&delay=' + encodeURIComponent(String(sub.delay));
    return u;
  }

  // Series and films post to different endpoints with different fields.
  // tv_progress keys off tid+season+episode; movie_progress off mid. `mp4_id`
  // is the file id in both, and is NOT the same as mfid.
  function saveProgress() {
    var d = state.data, v = ui.video;
    if (!d || !isFinite(v.currentTime) || v.currentTime <= 0) return;
    var dur = v.duration || 0;
    var over = (dur && dur - v.currentTime < 300) ? 1 : 0;
    var secs = Math.floor(v.currentTime);
    var endpoint, body;

    if (d.kind === 'movie') {
      if (!d.mid) return;
      endpoint = '/index/index/movie_progress';
      body = 'type=movie&mid=' + d.mid + '&over=' + over + '&seconds=' + secs +
             (d.mp4Id ? '&mp4_id=' + d.mp4Id : '');
    } else {
      if (!d.tid) return;
      endpoint = '/index/index/tv_progress';
      body = 'type=tv&tid=' + d.tid + '&season=' + d.season + '&episode=' + d.episode +
             '&seconds=' + secs + '&over=' + over +
             (d.mp4Id ? '&mp4_id=' + d.mp4Id : '');
    }

    try {
      fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body
      })['catch'](function () {});
    } catch (e) {}
  }

  // ---------------------------------------------------------------- player
  function applySubtitle(sub) {
    var v = ui.video;
    var old = v.querySelectorAll('track[data-mbp]');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    if (!sub) return;
    var t = D.createElement('track');
    t.setAttribute('data-mbp', '1');
    t.kind = 'subtitles';
    t.label = sub.name;
    t.srclang = (sub.lang || 'en').toLowerCase();
    t.src = subtitleVttUrl(sub);
    t['default'] = true;
    v.appendChild(t);
    // The element's default flag is unreliable once appended late.
    setTimeout(function () {
      var tt = v.textTracks;
      for (var k = 0; k < tt.length; k++) {
        try { tt[k].mode = (state.subOn && tt[k].label === sub.name) ? 'showing' : 'disabled'; } catch (e) {}
      }
    }, 120);
  }

  function playRung(index, keepTime) {
    var d = state.data, q = d.quality[index];
    if (!q) return;
    var at = keepTime ? ui.video.currentTime : (d.seconds || 0);
    var src = sourceFor(q);
    state.rung = index;

    if (/\.m3u8(\?|$)/i.test(src.src) && !canPlay('application/vnd.apple.mpegurl')) {
      showMsg('This quality needs HLS, which this TV\'s browser cannot play.',
              el('div', null, 'Hold OK and pick a different quality.'),
              el('div', 'color:#8fa3b8;font-size:14px',
                 'Only progressive .mp4 qualities work here for now.'));
      return;
    }

    ui.video.src = src.src;
    ui.video.load();
    // Resume, clamped. Two traps here, both real:
    //  - a stale saved position past the end seeks to the final frame and
    //    fires 'ended' immediately;
    //  - duration is not always known at loadedmetadata (Infinity for some
    //    remuxed or live-ish sources), so clamping there alone is not enough.
    var resumed = false;
    function tryResume() {
      if (resumed) return true;
      var dur = ui.video.duration;
      if (!isFinite(dur) || dur <= 0) return false;      // wait for durationchange
      resumed = true;
      var want = Math.min(at, dur - 0.5);
      if (want > 0.5) { try { ui.video.currentTime = want; } catch (e) {} }
      return true;
    }
    function kickoff() {
      var p = ui.video.play();
      if (p && p['catch']) p['catch'](function () {});
    }
    var onMeta = function () {
      ui.video.removeEventListener('loadedmetadata', onMeta);
      if (at > 0.5 && !tryResume()) {
        var onDur = function () {
          if (tryResume()) ui.video.removeEventListener('durationchange', onDur);
        };
        ui.video.addEventListener('durationchange', onDur);
        // Don't stall forever if duration never resolves.
        setTimeout(function () { ui.video.removeEventListener('durationchange', onDur); }, 5000);
      }
      kickoff();
    };
    ui.video.addEventListener('loadedmetadata', onMeta);
    osd(q.name + (q.height ? '  ' + q.width + 'x' + q.height : '') +
        (q.codec ? '  ' + q.codec : '') + (rungMbps(q) ? '  ' + rungMbps(q).toFixed(1) + ' Mbps' : ''));
  }

  // ------------------------------------------------- expiry / link recovery
  // The player page is the lookup, so refreshing a dead link means fetching it
  // again and finding the same rung by NAME -- indices are not stable across
  // responses.
  function refreshLink(reason) {
    if (state.recovering) return;
    // No file id for what is playing: the player page carried neither `pfid`
    // nor `currentResourceFid` and nothing forced one. There is nothing safe
    // to fetch -- a guess would start a different title at this timestamp --
    // so say so and stop asking. needsRefresh is cleared because the
    // heartbeat and the `online` handler would otherwise re-enter here
    // forever.
    if (!CFG.open || !CFG.open.id) {
      state.needsRefresh = false;
      showMsg(el('div', 'font-size:22px;font-weight:600', 'Cannot refresh this link'),
              el('div', 'color:#8fa3b8', 'Press Back and open the title again to carry on.'));
      return;
    }
    var now = Date.now();
    if (state.lastRecover && now - state.lastRecover < 15000) return;  // no loops
    state.recovering = true;
    state.lastRecover = now;

    var at = ui.video.currentTime || 0;
    var wantName = state.data && state.data.quality[state.rung] &&
                   state.data.quality[state.rung].name;
    osd(reason || 'Refreshing link...');

    fetchPlayer(CFG.open, at).then(function (html) {
      var d = parsePlayerPage(html);
      if (!d.quality.length) throw new Error('no rungs on refresh');
      d.seconds = at;                       // resume where we actually are
      state.data = d;
      var idx = -1;
      for (var i = 0; i < d.quality.length; i++) {
        if (String(d.quality[i].name) === String(wantName)) { idx = i; break; }
      }
      if (idx < 0) idx = pickRung(d.quality);
      state.recovering = false;
      state.needsRefresh = false;
      if (idx < 0) { showMsg('No playable rung after refresh.'); return; }
      playRung(idx, false);
    })['catch'](function (err) {
      state.recovering = false;
      // We still owe a refresh. If this failed because the network was down,
      // the `online` event or the next heartbeat will retry -- otherwise the
      // player would sit dead until the viewer pressed something.
      state.needsRefresh = true;
      showMsg(el('div', 'font-size:22px;font-weight:600', 'Could not refresh the link'),
              el('div', 'color:#ff8f8f', String(err && err.message || err)),
              el('div', 'color:#8fa3b8;font-size:14px', 'Retrying when the network returns.'));
    });
  }

  function watchExpiry() {
    var src = ui.video.currentSrc || '';
    var left = secondsUntilExpiry(src);
    if (!isFinite(left)) return;                 // fixture or unsigned source
    if (left >= 300) return;
    if (!ui.video.paused) { refreshLink('Link expiring, refreshing...'); return; }
    // Paused with a dying link. Refreshing on a loop for hours would be
    // wasteful, so just record that one is owed -- the resume path and the
    // heartbeat both honour it, so the viewer never meets a dead link.
    state.needsRefresh = true;
  }

  // ------------------------------------------------------ resume after sleep
  //
  // The TV suspends. On wake the signed link may be hours dead, and the most
  // likely real failure is coming back to a paused film that will not resume.
  //
  // Deliberately NOT built on `visibilitychange`: whether that fires on a
  // Samsung set, and when, is unverified (see DELIVERY.md). The primary signal
  // is a wall-clock gap, which needs no platform event at all -- timers do not
  // run while suspended, so an interval that should tick every WAKE_TICK ms
  // and instead ticks minutes late IS the suspend. visibilitychange and
  // pageshow are wired as *hints* that run the same check sooner; if they
  // never arrive, the heartbeat still catches it.
  var WAKE_TICK = 5000;        // heartbeat period
  var WAKE_GAP = 30000;        // a gap this large means we were asleep

  function startHeartbeat() {
    if (state.wakeTimer) return;
    state.lastTick = Date.now();
    state.wakeTimer = setInterval(function () {
      var now = Date.now();
      var gap = now - (state.lastTick || now);
      state.lastTick = now;
      if (gap > WAKE_GAP) { onWake(gap); return; }
      if (state.needsRefresh && !state.recovering) { retryOwedRefresh('Network back, retrying...'); return; }
      // The gap threshold and the expiry window interact: a sleep SHORTER than
      // WAKE_GAP still outlives a link that was nearly stale when the set went
      // down, and no wake would be reported. Checking expiry on every tick
      // closes that, and also covers being paused, when `timeupdate` -- and so
      // watchExpiry -- never fires at all.
      watchExpiry();
    }, WAKE_TICK);
  }

  function onWake(gap) {
    if (!state.data || state.recovering) return;
    var v = ui.video;
    var left = secondsUntilExpiry(v.currentSrc || '');
    var dead = v.error || (isFinite(left) && left < 60);

    osd('Back after ' + Math.round(gap / 1000) + 's' + (dead ? ' - refreshing link' : ''));

    if (dead) {
      // refreshLink resumes at the current position and re-picks the same
      // rung by name, so this is the whole recovery.
      state.lastRecover = 0;             // a real wake is not a retry loop
      refreshLink('Link expired while asleep, refreshing...');
      return;
    }
    // Link still good. If it was playing when we went under, get it going
    // again -- some platforms come back paused.
    if (state.wasPlaying && v.paused) {
      var p = v.play();
      if (p && p['catch']) p['catch'](function () {
        // Could not resume on a link we believed was good: fall back to the
        // refresh path rather than leaving a stuck player.
        refreshLink('Could not resume, refreshing...');
      });
    }
  }

  // Signed URLs are IP-locked: the master carries IP=<client address>, so a
  // network change (Wi-Fi handover, VPN flip) kills the link WITHOUT the clock
  // having moved. The proactive expiry timer cannot see that, and the element
  // reports it as an ordinary network error -- which the error handler already
  // turns into a refresh. The gap this closes is the refresh ITSELF failing
  // because the network was still down: without a retry the player sits dead.
  // `force` is for triggers that mean "act now": the network returning, or the
  // viewer pressing play. Without it we only act while playing -- a film left
  // paused on a dead link must not refresh every 15s for hours; it refreshes
  // once, when someone wants it again.
  function retryOwedRefresh(why, force) {
    if (!state.needsRefresh || state.recovering || !state.data) return;
    if (!force && ui.video.paused) return;
    state.lastRecover = 0;              // a real trigger is not a retry loop
    refreshLink(why || 'Retrying...');
  }

  // Cheap hints. They only ever call the same check, so a platform that never
  // fires them loses latency, not correctness.
  function wakeHint() {
    var now = Date.now();
    var gap = now - (state.lastTick || now);
    state.lastTick = now;
    if (gap > WAKE_GAP) onWake(gap);
  }

  // --------------------------------------------------------- next episode
  /* Release the media pipeline BEFORE navigating.
   *
   * Setting location.href while <video> is still decoding can leave the
   * engine waiting on a pipeline that never tears down - the page unloads and
   * the next one never paints. On a TV that is a dead set with no way out but
   * the home key, and it is what 'Back goes to loading forever' was.
   *
   * pause -> drop the source -> load() to force the reset -> detach, then
   * navigate on the next tick so the engine has actually let go first.
   * Every step is wrapped: a failure here must not strand the user on a
   * player they cannot leave, so navigation happens regardless. */
  function leaveToSite(href) {
    try {
      var v = ui.video;
      if (v) {
        try { v.pause(); } catch (e1) {}
        try { v.removeAttribute('src'); } catch (e2) {}
        try { while (v.firstChild) { v.removeChild(v.firstChild); } } catch (e3) {}
        try { v.load(); } catch (e4) {}
        try { if (v.parentNode) { v.parentNode.removeChild(v); } } catch (e5) {}
      }
      if (state.guard) { try { state.guard.disconnect(); } catch (e6) {} }
    } catch (e) {}
    setTimeout(function () {
      try { W.location.href = href; } catch (err) {}
    }, 0);
  }

  function playNext() {
    var d = state.data;
    if (!d || !d.tid) return;
    var wantEp = d.nextEpisode, wantSeason = d.nextSeason;
    if (!wantEp || parseInt(wantEp, 10) <= 0) { osd('No next episode'); return; }
    osd('Loading next episode...');
    episodesFor(d.tid, wantSeason).then(function (data) {
      if (!data || !data.episodes) throw new Error('no episode list');
      var tfid = null;
      for (var i = 0; i < data.episodes.length; i++) {
        var e = data.episodes[i];
        if (String(e.episode) === String(wantEp) && e.has_video && e.tfid) { tfid = e.tfid; break; }
      }
      if (!tfid) throw new Error('next episode has no playable file');
      saveProgress();
      CFG.open = { kind: 'tv', id: tfid };
      return fetchPlayer(CFG.open, 0).then(start);
    })['catch'](function (err) {
      osd('Next episode failed: ' + (err && err.message || err));
    });
  }

  // ------------------------------------------------------ episode teardown
  //
  // start() is re-entrant: it runs again on every episode change. Three bugs
  // in a row came from state belonging to the PREVIOUS episode outliving the
  // switch -- stacked listeners, a stale subtitle panel, a stale skip prompt.
  // Rather than keep fixing instances, the lifetime of every piece of state is
  // declared here, in one place.
  //
  //   SESSION-scoped  survives an episode change. Listener wiring, the
  //                   progress timer, pairing state, and `subOn` -- which is a
  //                   viewer preference, not a property of the episode.
  //   EPISODE-scoped  must not. Everything below.
  //
  // Anything added to `state` belongs in one of those two lists. If it is
  // episode-scoped, it is cleared here and nowhere else.
  function endEpisode() {
    if (state.panel) closeSubPanel();
    hideSkip();

    clearTimeout(state.osdTimer);
    state.osdTimer = null;

    state.rung = -1;
    state.sub = null;
    state.subIndex = 0;
    state.skips = null;
    state.recovering = false;
    state.lastRecover = 0;
    state.needsRefresh = false;
    onStallEnd();
  }

  function start(html) {
    var d = parsePlayerPage(html);
    state.data = d;
    if (!d.quality.length) { showMsg('No playable rungs in the player page.'); return; }

    // Keep the refresh target pointing at what is actually playing. Without
    // this, CFG.open still held whatever boot put there, and refreshLink --
    // the sleep/wake, source-error and stall-escalation path -- re-fetched
    // THAT. On the normal takeover path, where nothing ever set it, waking
    // the TV would load a different title than the one on screen.
    if (d.target) CFG.open = d.target;

    // start() re-runs on every episode change, and the subtitle list belongs
    // to the old episode. Leaving the panel open would show stale rows and
    // index into the wrong array.
    endEpisode();
    state.skips = parseSkips(d.skips);

    ui.title.textContent = d.title;
    var idx = pickRung(d.quality);
    if (idx < 0) { showMsg('No rung this TV can play.'); return; }

    hideMsg();
    playRung(idx, false);

    var sub = null;
    for (var i = 0; i < d.subs.length; i++) {
      if (String(d.subs[i].sid) === String(d.currentSid)) { sub = d.subs[i]; break; }
    }
    if (!sub && d.subs.length) sub = d.subs[0];
    state.sub = sub;
    state.subIndex = 0;
    for (var si = 0; si < d.subs.length; si++) if (d.subs[si] === sub) state.subIndex = si;
    applySubtitle(sub);

    // Wire listeners once: start() runs again on every episode change, and
    // re-adding these would stack duplicate handlers and timers.
    if (!state.wired) {
      state.wired = true;
      var lastExpiryCheck = 0;
      ui.video.addEventListener('timeupdate', function () {
        tick();
        var now = Date.now();
        if (now - lastExpiryCheck > 10000) { lastExpiryCheck = now; watchExpiry(); }
        checkSkips();
      });
      ui.video.addEventListener('waiting', onStallStart);
      ui.video.addEventListener('stalled', onStallStart);
      ui.video.addEventListener('playing', function () {
        if (!marks.toFirstFrame && marks.takeoverAt) marks.toFirstFrame = now() - marks.takeoverAt;
        state.wasPlaying = true; onStallEnd(); osd();
      });
      ui.video.addEventListener('canplay', onStallEnd);
      ui.video.addEventListener('seeked', onStallEnd);
      ui.video.addEventListener('pause', function () { state.wasPlaying = false; onStallEnd(); });
      ui.video.addEventListener('ended', function () {
        if (state.data && parseInt(state.data.nextEpisode, 10) > 0) playNext();
        else osd('Finished');
      });
      ui.video.addEventListener('error', function () {
        var e = ui.video.error;
        // A network/src failure on a signed URL is nearly always expiry, and
        // the fix is to fetch the player page again rather than to give up.
        if (e && (e.code === 2 || e.code === 4) && !state.recovering) {
          refreshLink('Source failed, refreshing link...');
          return;
        }
        showMsg('Playback failed' + (e ? ' (code ' + e.code + ')' : ''),
                el('div', 'color:#8fa3b8;font-size:14px',
                   'Hold OK for settings, then change Quality with Left/Right.'));
      });
      state.progressTimer = setInterval(saveProgress, CFG.progressEvery);
      startHeartbeat();
      try {
        D.addEventListener('visibilitychange', function () { if (!D.hidden) wakeHint(); });
        W.addEventListener('pageshow', wakeHint);
        W.addEventListener('focus', wakeHint);
        W.addEventListener('online', function () { retryOwedRefresh('Network back, refreshing link...', true); });
      } catch (e) {}
      W.addEventListener('beforeunload', saveProgress);
    }
    osd();
  }

  // ------------------------------------------------------------ diagnostics
  //
  // One screen the viewer can photograph. Everything here is a question only
  // the TV can answer, and the test session is the one chance to ask: the real
  // engine version, whether this panel decodes 4K HEVC, what the parse of a
  // 561 KB page actually costs, and whether frames are being dropped.
  //
  // Folding it into the player rather than leaving it in probe/ means one run
  // produces all of it, instead of asking for a second module to be installed.
  function canPlayLabel(mime) {
    var el2 = D.createElement('video'), r = '';
    try { r = el2.canPlayType(mime); } catch (e) {}
    var mse = false;
    try { mse = !!(W.MediaSource && W.MediaSource.isTypeSupported(mime)); } catch (e) {}
    return (r === 'probably' || r === 'maybe' ? 'elem' : '----') + '/' + (mse ? 'mse' : '---');
  }

  function frameStats() {
    var v = ui.video, d = null, t = null;
    try {
      if (typeof v.getVideoPlaybackQuality === 'function') {
        var q = v.getVideoPlaybackQuality();
        if (q && typeof q.droppedVideoFrames === 'number') { d = q.droppedVideoFrames; t = q.totalVideoFrames; }
      }
    } catch (e) {}
    if (d === null && typeof v.webkitDroppedFrameCount === 'number') {
      d = v.webkitDroppedFrameCount; t = v.webkitDecodedFrameCount;
    }
    if (d === null) return 'no counter';
    var pct = t > 0 ? (d / t * 100).toFixed(2) + '%' : '-';
    return d + ' of ' + t + '  (' + pct + ')';
  }

  function bufferAhead() {
    var v = ui.video, ahead = null;
    try {
      var b = v.buffered;
      for (var i = 0; i < b.length; i++) {
        if (v.currentTime >= b.start(i) && v.currentTime <= b.end(i)) ahead = b.end(i) - v.currentTime;
      }
    } catch (e) {}
    return ahead == null ? '-' : ahead.toFixed(1) + 's';
  }

  function diagLines() {
    var v = ui.video, d = state.data || {};
    var ua = navigator.userAgent || '';
    var chrome = /Chrome\/(\d+)/.exec(ua);
    var de = D.documentElement || {};
    var vw = W.innerWidth || de.clientWidth || 0, vh = W.innerHeight || de.clientHeight || 0;
    var q = (d.quality && d.quality[state.rung]) || null;
    // Show the part that identifies the BUILD, never a whole URL. The leak
    // guard caught the first version of this row for printing a full address,
    // and it was right to: a URL row is how a signed media URL would end up on
    // a photograph later. The scheme and host are dropped, which also makes
    // the row shorter and easier to read off a picture.
    var src = BUILD_SRC;
    var origin = '';
    var jd = /cdn\.jsdelivr\.net\/(.+)$/.exec(src);
    if (jd) { origin = 'jsDelivr  ' + jd[1]; }
    else if (/^https?:\/\//i.test(src)) {
      var tail = /\/([^/?#]+)(?:[?#]|$)/.exec(src);
      origin = 'local  ' + (tail ? tail[1] : 'userScript.js');
    } else { origin = src; }
    var cachey = /@(main|master|latest)\b/i.test(src) ||
                 (/jsdelivr/.test(src) && !/@[^/]*\d/.test(src));

    return [
      ['Build', BUILD_VERSION + '  ' + BUILD_SHA +
               (cachey ? '   (branch URL - may be cached)' : '')],
      ['Loaded from', origin],
      ['-', ''],
      ['Chromium', chrome ? chrome[1] : '(not in UA)'],
      ['Canvas', Math.round(vw * (W.devicePixelRatio || 1)) + 'x' +
                 Math.round(vh * (W.devicePixelRatio || 1)) +
                 '   screen ' + (screen.width || '?') + 'x' + (screen.height || '?')],
      ['webapis / tizen', (typeof W.webapis !== 'undefined' ? 'yes' : 'no') + ' / ' +
                          (typeof W.tizen !== 'undefined' ? 'yes' : 'no')],
      ['-', ''],
      ['Page bytes', marks.bytes ? (marks.bytes / 1024).toFixed(0) + ' KB' : '(from page, not fetched)'],
      ['Parse', marks.parseMs ? marks.parseMs.toFixed(1) + ' ms' : '-'],
      ['Fetch', marks.fetchMs ? marks.fetchMs.toFixed(0) + ' ms' : '(none - read from page)'],
      ['To first frame', marks.toFirstFrame ? marks.toFirstFrame.toFixed(0) + ' ms' : '-'],
      ['-', ''],
      ['Playing', q ? (q.name + '  ' + (q.width || '?') + 'x' + (q.height || '?') +
                       '  ' + (q.codec || '?')) : '-'],
      ['Actual video', v.videoWidth + 'x' + v.videoHeight],
      ['Dropped frames', frameStats()],
      ['Buffer ahead', bufferAhead()],
      ['-', ''],
      ['H.264 1080p', canPlayLabel('video/mp4; codecs="avc1.640028"')],
      ['H.264 4K', canPlayLabel('video/mp4; codecs="avc1.640033"')],
      ['HEVC 4K', canPlayLabel('video/mp4; codecs="hvc1.1.6.L153.B0"')],
      ['HEVC 4K 10bit', canPlayLabel('video/mp4; codecs="hvc1.2.4.L153.B0"')],
      ['AV1 4K', canPlayLabel('video/mp4; codecs="av01.0.08M.08"')],
      ['E-AC-3 audio', canPlayLabel('audio/mp4; codecs="ec-3"')]
    ];
  }

  function toggleDiag() {
    if (ui.diag) { try { ui.diag.parentNode.removeChild(ui.diag); } catch (e) {} ui.diag = null;
                   clearInterval(state.diagTick); state.diagTick = null; return; }
    var box = el('div', 'position:fixed;inset:0;z-index:70;background:rgba(6,8,12,.96);' +
      'padding:30px 44px;overflow:auto;font:15px/1.5 monospace;color:#e8eef6');
    ui.diag = box;
    D.body.appendChild(box);
    function render() {
      box.innerHTML = '';
      box.appendChild(el('div', 'font-size:22px;font-weight:700;color:#7fd0ff;margin-bottom:2px',
                         'Diagnostics'));
      box.appendChild(el('div', 'font-size:13px;color:#8fa3b8;margin-bottom:16px',
                         'Photograph this screen.  Blue or Back closes.'));
      var rows = diagLines();
      for (var i = 0; i < rows.length; i++) {
        if (rows[i][0] === '-') { box.appendChild(el('div', 'height:10px')); continue; }
        var r = el('div', 'display:flex;gap:14px;padding:1px 0');
        r.appendChild(el('span', 'flex:0 0 190px;color:#9fb4c9', rows[i][0]));
        r.appendChild(el('span', 'flex:1 1 auto', String(rows[i][1])));
        box.appendChild(r);
      }
    }
    render();
    state.diagTick = setInterval(render, 1000);   // dropped frames keep moving
  }

  // ----------------------------------------------------------- stall state
  //
  // A slow link and a dead one look identical for the first few seconds. The
  // point of this is mostly legibility -- show that something is happening,
  // and how much buffer is left -- but it earns its place at the end: a stall
  // that never clears is usually an expired or IP-invalidated link, and the
  // fix for that already exists. So the indicator escalates into a refresh
  // rather than spinning forever.
  var STALL_SHOW = 700;        // don't flash on a blink of rebuffering
  var STALL_GIVE_UP = 20000;   // a stall this long is probably a dead link

  function stallText() {
    var v = ui.video, ahead = 0;
    try {
      var b = v.buffered;
      for (var i = 0; i < b.length; i++) {
        if (v.currentTime >= b.start(i) && v.currentTime <= b.end(i)) ahead = b.end(i) - v.currentTime;
      }
    } catch (e) {}
    return ahead > 0.3 ? ('Buffering  ' + ahead.toFixed(1) + 's ready') : 'Buffering';
  }

  function showStall() {
    if (ui.stall) { ui.stall.textContent = stallText(); return; }
    var box = el('div', 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'z-index:55;padding:16px 26px;border-radius:10px;background:rgba(8,10,14,.86);' +
      'font-size:20px;color:#cfe0ef', stallText());
    D.body.appendChild(box);
    ui.stall = box;
  }

  function hideStall() {
    clearTimeout(state.stallShowTimer);
    clearTimeout(state.stallGiveUpTimer);
    state.stallShowTimer = null;
    state.stallGiveUpTimer = null;
    if (ui.stall) { try { ui.stall.parentNode.removeChild(ui.stall); } catch (e) {} ui.stall = null; }
  }

  function onStallStart() {
    if (state.stallShowTimer || ui.stall) return;
    state.stallShowTimer = setTimeout(function () {
      state.stallShowTimer = null;
      if (ui.video.paused) return;             // a pause is not a stall
      showStall();
      // Keep the buffer figure moving so a slow-but-alive link looks alive.
      state.stallTick = setInterval(function () { if (ui.stall) ui.stall.textContent = stallText(); }, 500);
    }, STALL_SHOW);

    clearTimeout(state.stallGiveUpTimer);
    state.stallGiveUpTimer = setTimeout(function () {
      state.stallGiveUpTimer = null;
      if (ui.video.paused || state.recovering) return;
      // Stalled far too long: treat it as a dead source, which is the most
      // likely cause, and let the existing recovery do its job.
      hideStall();
      refreshLink('Stalled - refreshing link...');
    }, STALL_GIVE_UP);
  }

  function onStallEnd() {
    clearInterval(state.stallTick);
    state.stallTick = null;
    hideStall();
  }

  // ------------------------------------------------------- skip intro/outro
  // `skips` arrives as a JSON *string* in the page, with crowd-voted points.
  // start = where the content begins; end = seconds-from-the-end at which the
  // outro starts, which is how the site's own skip_end() reads it.
  function parseSkips(raw) {
    if (!raw) return null;
    var o = raw;
    if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch (e) { return null; } }
    if (!o || typeof o !== 'object') return null;
    var start = parseFloat(o.start), end = parseFloat(o.end);
    return {
      start: isFinite(start) && start > 0 ? start : 0,
      end: isFinite(end) && end > 0 ? end : 0
    };
  }

  function showSkip(kind, label, action) {
    if (state.skipKind === kind) return;            // already offering this one
    hideSkip();
    state.skipKind = kind;
    state.skipAction = action;
    var box = el('div', 'position:fixed;right:60px;bottom:160px;z-index:60;padding:14px 22px;' +
      'border-radius:10px;background:rgba(28,28,30,.92);border:1px solid rgba(255,255,255,.18);' +
      'font-size:18px;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45)');
    box.appendChild(el('span', null, label + '  '));
    box.appendChild(el('span', 'color:#7fd0ff;font-weight:700', 'OK'));
    D.body.appendChild(box);
    ui.skip = box;
    clearTimeout(state.skipTimer);
    state.skipTimer = setTimeout(hideSkip, 12000);
  }

  function hideSkip() {
    clearTimeout(state.skipTimer);
    if (ui.skip) { try { ui.skip.parentNode.removeChild(ui.skip); } catch (e) {} ui.skip = null; }
    state.skipKind = null;
    state.skipAction = null;
  }

  function checkSkips() {
    var s = state.skips, v = ui.video;
    if (!s || state.panel) return;
    var t = v.currentTime, dur = v.duration;
    if (!isFinite(t)) return;

    if (s.start && t > 0.3 && t < s.start) {
      showSkip('intro', 'Skip intro', function () {
        try { v.currentTime = s.start; } catch (e) {}
      });
      return;
    }
    if (s.end && isFinite(dur) && dur > 0 && (dur - t) < s.end && (dur - t) > 0.6) {
      var hasNext = state.data && parseInt(state.data.nextEpisode, 10) > 0;
      showSkip('outro', hasNext ? 'Next episode' : 'Skip outro', function () {
        if (hasNext) playNext();
        else { try { v.currentTime = Math.max(0, dur - 0.4); } catch (e) {} }
      });
      return;
    }
    if (state.skipKind) hideSkip();
  }

  // -------------------------------------------------------- subtitle panel
  // A TV-shaped chooser: language list plus a delay row. Delay is free here --
  // the server bakes the offset into the VTT, so changing it is just a new
  // track URL, no client-side timing at all.
  // --------------------------------------------------------- settings panel
  // One panel, one gesture to reach it, and every playback setting inside it.
  //
  // The colour keys stay as shortcuts, but nothing lives ONLY on a colour key
  // any more. That was the actual complaint -- "very wonky to go to the
  // settings of the player, like the quality and stuff like that" -- and it
  // was about reach, not about which key did what. Making two key maps agree
  // would only have made them consistently unmemorable.
  //
  // One rule for the whole panel: Up/Down move, Left/Right change the value on
  // the row, OK acts. No nesting, so there is never a question of which level
  // a press applies to.
  //
  // Rows are descriptors rather than index arithmetic on purpose. The old
  // subtitle panel computed `rows = subs.length + 2` and indexed into it, and
  // that shape is what let a stale panel point at the previous episode's
  // tracks. A row now carries its own behaviour.
  function settingsRows() {
    var d = state.data, rows = [], i;
    if (!d) return rows;

    var list = usableRungs(), at = -1;
    for (i = 0; i < list.length; i++) if (list[i].i === state.rung) at = i;
    var cur = at >= 0 ? list[at] : null;
    rows.push({
      label: 'Quality',
      value: rungLabel(cur),
      // Flagged, not blocked. Above this nothing has been shown to decode on a
      // real set; saying so is more use to the viewer than refusing to offer it.
      note: (cur && cur.h > SAFE_HEIGHT) ? 'not proven on this set' : '',
      lo: at <= 0,
      hi: at >= 0 && at >= list.length - 1,
      left: function () { stepRung(-1); },
      right: function () { stepRung(1); }
    });

    if (d.subs && d.subs.length) {
      rows.push({
        label: 'Subtitles',
        value: (state.subOn && d.subs[state.subIndex]) ? d.subs[state.subIndex].name : 'Off',
        left: function () { cycleSub(-1); },
        right: function () { cycleSub(1); }
      });
      if (state.subOn && d.subs[state.subIndex]) {
        var dl = d.subs[state.subIndex].delay || 0;
        rows.push({
          label: 'Subtitle delay',
          value: (dl > 0 ? '+' : '') + dl.toFixed(1) + 's',
          left: function () { nudgeDelay(-0.5); },
          right: function () { nudgeDelay(0.5); }
        });
      }
    }

    // The PARSED kind, not CFG.open's. CFG.open is a fetch target and starts
    // empty; reading the kind off it showed a Next-episode row on films.
    if (state.data && state.data.kind === 'tv') {
      rows.push({ label: 'Next episode', value: 'OK',
                  ok: function () { closeSettings(); playNext(); } });
    }
    rows.push({ label: 'Diagnostics', value: 'OK',
                ok: function () { closeSettings(); toggleDiag(); } });
    return rows;
  }

  function cycleSub(dir) {
    var subs = state.data.subs, n = subs.length + 1;      // tracks, then Off
    var at = state.subOn ? state.subIndex : subs.length;
    chooseSub((at + dir + n) % n);
  }

  function openSettings(row) {
    if (!state.data) { osd('Nothing to configure yet'); return; }
    state.panel = 'settings';
    state.panelRow = row || 0;
    renderSettings();
  }

  function closeSettings() {
    state.panel = null;
    if (ui.panel) { try { ui.panel.parentNode.removeChild(ui.panel); } catch (e) {} ui.panel = null; }
    osd();
  }

  function renderSettings() {
    if (state.panel !== 'settings') return;
    var rows = settingsRows();
    if (!rows.length) { closeSettings(); return; }
    if (state.panelRow >= rows.length) state.panelRow = rows.length - 1;
    if (state.panelRow < 0) state.panelRow = 0;
    if (ui.panel) { try { ui.panel.parentNode.removeChild(ui.panel); } catch (e) {} }

    var p = el('div', 'position:fixed;right:0;top:0;bottom:0;width:min(52vw,680px);' +
      'background:rgba(8,10,14,.94);padding:36px 32px;overflow:auto;z-index:50');
    p.appendChild(el('div', 'font-size:22px;font-weight:700;color:#7fd0ff;margin-bottom:4px', 'Settings'));
    p.appendChild(el('div', 'font-size:13px;color:#8fa3b8;margin-bottom:20px',
      'Up/Down choose  \u00b7  Left/Right change  \u00b7  Back closes'));

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], sel = (i === state.panelRow);
      var row = el('div', 'display:flex;justify-content:space-between;align-items:center;' +
        'gap:14px;padding:12px 14px;border-radius:8px;margin-bottom:4px;' +
        (sel ? 'background:#1d4f6b;color:#fff;' : 'color:#cfe0ef;'));
      row.appendChild(el('span', 'flex:0 0 40%', r.label));
      var right = el('div', 'text-align:right');
      var stepper = !!(r.left || r.right);
      var txt = stepper
        ? (r.lo ? '     ' : '\u25c0  ') + r.value + (r.hi ? '     ' : '  \u25b6')
        : r.value;
      right.appendChild(el('div', 'color:' + (sel ? '#7fd0ff' : '#9fb4c8') + ';font-weight:600', txt));
      if (r.note) right.appendChild(el('div', 'font-size:12px;color:#ffd479', r.note));
      row.appendChild(right);
      p.appendChild(row);
    }
    D.body.appendChild(p);
    ui.panel = p;
  }

  // Green still means subtitles, but now as a shortcut INTO the panel rather
  // than a separate screen: one place where settings live, with the colour key
  // as a convenience instead of the only route.
  function openSubPanel() {
    var d = state.data;
    if (!d || !d.subs || !d.subs.length) { osd('No subtitles for this title'); return; }
    var rows = settingsRows(), i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].label === 'Subtitles') { openSettings(i); return; }
    }
    openSettings(0);
  }
  function closeSubPanel() { closeSettings(); }

  function chooseSub(i) {
    var subs = state.data.subs;
    if (i < subs.length) {
      state.subIndex = i;
      state.subOn = true;
      state.sub = subs[i];
      applySubtitle(subs[i]);
      rememberSubtitle(subs[i]);
    } else {
      state.subOn = false;
      var tt = ui.video.textTracks;
      for (var k = 0; k < tt.length; k++) { try { tt[k].mode = 'disabled'; } catch (e) {} }
    }
    renderSettings();
  }

  function nudgeDelay(by) {
    var sub = state.data.subs[state.subIndex];
    if (!sub) return;
    sub.delay = Math.round((sub.delay + by) * 10) / 10;
    // Re-point the track: the server returns VTT with the new offset applied.
    if (state.subOn) applySubtitle(sub);
    rememberDelay(sub);
    renderSettings();
  }

  // Returns true if the panel consumed the key. Navigation and OK belong to
  // the menu; transport keys do not -- on a TV, play/pause, skip and next are
  // expected to keep working while a menu is open, and swallowing them makes
  // the remote feel broken.
  function panelKey(a) {
    var rows = settingsRows();
    if (!rows.length) { closeSettings(); return false; }
    if (state.panelRow >= rows.length) state.panelRow = rows.length - 1;
    var r = rows[state.panelRow];
    if (a === 'up') { state.panelRow = (state.panelRow - 1 + rows.length) % rows.length; renderSettings(); return true; }
    if (a === 'down') { state.panelRow = (state.panelRow + 1) % rows.length; renderSettings(); return true; }
    if (a === 'left') { if (r.left) r.left(); return true; }
    if (a === 'right') { if (r.right) r.right(); return true; }
    if (a === 'ok') {
      if (r.ok) r.ok();
      else if (r.right) r.right();    // a value row: OK nudges it rather than doing nothing
      return true;
    }
    if (a === 'back' || a === 'green') { closeSettings(); return true; }
    // Anything else (play, pause, ff, rw, next, prev, red) falls through to
    // playback. A transport key also dismisses the menu, since the viewer has
    // clearly moved on from it.
    if (a === 'next' || a === 'prev') closeSettings();
    return false;
  }

  // ------------------------------------------------------------------ keys
  var KEYS = {
    13: 'ok', 32: 'ok', 10252: 'ok', 415: 'play', 19: 'pause',
    37: 'left', 39: 'right', 38: 'up', 40: 'down',
    412: 'rw', 417: 'ff', 227: 'rw', 228: 'ff',
    10009: 'back', 27: 'back', 8: 'back',
    403: 'red', 82: 'red',
    404: 'green', 71: 'green',
    406: 'blue', 66: 'blue',
    405: 'next', 10233: 'next', 78: 'next',
    10232: 'prev'
  };

  function seek(by) {
    var v = ui.video, d = v.duration || 0;
    var t = v.currentTime + by;
    if (t < 0) t = 0;
    if (d && t > d - 1) t = d - 1;
    v.currentTime = t;
    tick(); osd();
  }


  function toggleSubs() {
    state.subOn = !state.subOn;
    var tt = ui.video.textTracks;
    for (var i = 0; i < tt.length; i++) {
      try { tt[i].mode = state.subOn ? 'showing' : 'disabled'; } catch (e) {}
    }
    osd('Subtitles ' + (state.subOn ? 'on' : 'off') +
        (state.sub && state.subOn ? '  ' + state.sub.name : ''));
  }

  // OK does two jobs, so they have to be told apart, and a TV remote gives no
  // held-key event to do it with: keydown fires once, then AUTO-REPEATS at the
  // set's own rate after the set's own delay, and keyup arrives on release.
  //
  // So settings open on the first REPEAT rather than on a timer of mine. The
  // threshold is then the set's repeat delay -- the same delay the viewer
  // already feels everywhere else on their own TV -- instead of a number I
  // guessed at and could not test on hardware. And play/pause moves to
  // RELEASE, so a short press never waits to find out whether a long press was
  // coming.
  function okShortPress() {
    var v = ui.video;
    if (state.skipAction) { var act = state.skipAction; hideSkip(); act(); return; }
    if (state.pairExpired) { state.pairExpired = false; startPairing(function () { boot(); }); return; }
    if (v.paused) {
      if (state.needsRefresh) { retryOwedRefresh('Refreshing link...', true); osd(); return; }
      var p = v.play(); if (p && p['catch']) p['catch'](function () {});
    } else v.pause();
    osd();
  }

  function onKeyUp(e) {
    if (KEYS[e.keyCode] !== 'ok') return;
    e.preventDefault(); e.stopPropagation();
    if (state.okHeld) { state.okHeld = false; return; }   // the hold already acted
    okShortPress();
  }

  function onKey(e) {
    var a = KEYS[e.keyCode];
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    // A lost keyup would otherwise leave OK dead for good, so any other key
    // clears the held flag.
    if (a !== 'ok') state.okHeld = false;
    if (ui.diag && (a === 'blue' || a === 'back')) { toggleDiag(); return; }
    // Still holding the press that opened the panel. Without this the hold
    // would open settings and then immediately act on its first row.
    if (a === 'ok' && state.okHeld) return;
    if (state.panel && panelKey(a)) { if (a === 'ok') state.okHeld = true; return; }
    if (a === 'ok') {
      if (e.repeat) { state.okHeld = true; openSettings(); }
      return;                           // the short press is handled on release
    }
    var v = ui.video;
    if (a === 'play') { var p2 = v.play(); if (p2 && p2['catch']) p2['catch'](function () {}); osd(); }
    else if (a === 'pause') { v.pause(); osd(); }
    else if (a === 'left') seek(-CFG.seekStep);
    else if (a === 'right') seek(CFG.seekStep);
    else if (a === 'rw') seek(-CFG.seekStepBig);
    else if (a === 'ff') seek(CFG.seekStepBig);
    // Up and Down open settings as well. Holding OK is what was asked for, but
    // it is an untested gesture on this hardware and it depends on the set's
    // repeat behaviour, so it is deliberately not the only way in.
    else if (a === 'up' || a === 'down') openSettings();
    else if (a === 'red') toggleSubs();
    else if (a === 'blue') toggleDiag();
    else if (a === 'green') openSubPanel();
    else if (a === 'next') playNext();
    else if (a === 'prev') osd('Previous episode is not wired up -- press Back for the list');
    else if (a === 'back') { saveProgress(); leaveToSite('/'); }
  }

  /* ================================================================ navigation
   * D-pad navigation over the site's OWN pages: sign-in, browse, search and
   * opening a title.
   *
   * Why this has to exist. The player wakes only once a page already contains
   * the site's player script, and on a TV nothing can put one there:
   * TizenBrew runs one module at a time, so the module that could navigate is
   * not running. Measured on hardware -- with this module enabled the user
   * reached the signed-out gate page and reported no selectable element at
   * all, up and down merely scrolling the page. The player was never
   * unreachable because of a bug; it was unreachable because nothing could
   * reach it.
   *
   * Lifted from MBP-STV (same author, MIT) rather than rediscovered, because
   * the parts that matter are the ones that took real pages to find:
   *   - the explicit selector set. This site makes things clickable with a
   *     jQuery handler bound to an <img>: no href, no onclick, no tabindex,
   *     computed cursor:auto. No generic focusable sweep can see them, which
   *     is why a signed-out screen offers the Google button and nothing else.
   *   - the direction scoring in navFindNext, which has to cope with a phone
   *     layout stretched across a 16:9 panel.
   *   - the page-scale fix, and the two traps in it recorded below.
   *
   * How it hands over to the player: by doing nothing special. It clicks the
   * title, the site loads its own player, playerDataInPage() sees the script
   * and takeOver() runs. There is no mode for anyone to understand or switch,
   * and no second code path -- the handover is the one already there.
   */
  // 'a:not([href])' is there because project 1's second hardware run found
  // episode rows to be anchors with no href at all -- 'a[href]' walks past
  // them, and episode rows are the one thing a series page exists for.
  var NAV_SEMANTIC = 'a[href],a:not([href]),button,input,select,textarea,summary,[tabindex],' +
    '[onclick],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"]';

  // Clickable on this site through a jQuery handler and nothing else.
  // '.login_more img' is the one that matters most: it reveals QR and code
  // sign-in on the gate page, and the handler is bound to the image rather
  // than the <p>, which spans the whole row.
  var NAV_EXTRA = [
    // The IMG only, never the <p>. Measured on the fixture: the <p> is
    // 1291px wide and the img 154px at its left edge, so a click aimed at
    // the <p>'s centre lands on the <p> -- which carries no handler. Listing
    // the <p> put a selectable item on the gate page that did nothing when
    // you pressed OK, which is precisely the dead-remote feel this whole
    // change exists to remove. Project 1's selector set says the same thing
    // in a comment; I added both anyway and the fixture caught it.
    '.login_more img',
    '.left', '.left_show', '.right', '.right2', '.right_show', '.lower',
    '.filter', '.elect', '.elected', '.operation', '.tab_con li',
    '.watch_plan', '.favorite', '.comment', '.like2', '.dislike',
    '.open2', '.hide', '.lang_btn', '.lang_list p', '.sidebarbg2 li',
    '.episode', '.spread_episode', '.off_episode', '.popup_close', '.fav_close',
    '.tips_close', '.search_close', '.search_submit', '.search_submit2',
    '.letter_list a', '.sort', '.back', '.more', '.watch_status',
    '.operation_list p', '.play_btn', '.start_app', '.season_info .episode'
  ].join(',');

  // Divs and spans that only admit to being buttons through cursor:pointer.
  // The style lookup is the expensive part, so this sweep is bounded to near
  // the viewport -- see navHarvest.
  var NAV_POINTER_TAGS = 'div,span,li,p,img,td,h1,h2,h3,h4,label,i,b,strong,em';

  var nav = {
    on: false, focus: null, ring: null, scaleEl: null, help: null,
    stamp: 0, cache: null, cacheAt: 0, cacheY: 0, dirty: true,
    lastMove: 0, obs: null, pick: null, scrollFn: null, resizeFn: null,
    harvestMs: 0, harvestN: 0,
    // the stranded-page watch: when we first noticed nothing was selectable,
    // and the overlay that says so. Cleared the moment the page becomes usable.
    stuckSince: 0, stuckBox: null,
    // the viewport tag that magnifies the px catalogue, and the width the
    // page had BEFORE we touched it -- every sum has to use that, not the
    // live innerWidth, which our own tag changes
    vpEl: null, baseW: 0
  };

  function navRect(n) {
    var r = n.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  }
  function navCss(n) { return W.getComputedStyle(n) || {}; }
  function navAttached(n) { return !!n && n.nodeType === 1 && D.documentElement.contains(n); }
  function navMine(n) {
    if (typeof ui !== 'undefined' && ui && ui.root && ui.root.contains(n)) return true;
    if (nav.ring && nav.ring === n) return true;
    if (nav.help && nav.help.contains && nav.help.contains(n)) return true;
    return false;
  }
  function navHiddenUp(n) {
    while (n && n.nodeType === 1) {
      var s = navCss(n);
      if (s.display === 'none' || parseFloat(s.opacity) < 0.05) return true;
      n = n.parentElement;
    }
    return false;
  }
  function navShown(n, r) {
    r = r || navRect(n);
    if (r.w < 4 || r.h < 4) return false;
    var v = navCss(n).visibility;
    if (v === 'hidden' || v === 'collapse') return false;
    return !navHiddenUp(n);
  }

  function navHarvest() {
    var t0 = now(), list = [], stamp = ++nav.stamp, vh = W.innerHeight;
    function add(sel, needPointer) {
      var els, i, n, r, p;
      try { els = D.querySelectorAll(sel); } catch (err) { return; }
      for (i = 0; i < els.length; i++) {
        n = els[i];
        if (n.__navAt === stamp || navMine(n)) continue;
        if (needPointer) {
          // Bounded on purpose: a style lookup for every div on a catalogue
          // page is the one thing here that could be slow on a TV CPU.
          r = n.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) continue;
          if (r.bottom < -vh * 1.5 || r.top > vh * 2.5) continue;
          if (navCss(n).cursor !== 'pointer') continue;
          p = n.parentElement;
          if (p && navCss(p).cursor === 'pointer') continue;   // same button twice
        }
        n.__navAt = stamp;
        list.push(n);
      }
    }
    add(NAV_SEMANTIC, false);
    add(NAV_EXTRA, false);
    add(NAV_POINTER_TAGS, true);
    list = navCollapseDuplicateLinks(list, stamp);
    nav.harvestMs = now() - t0;
    nav.harvestN = list.length;
    return list;
  }

  // Two anchors to the same place inside one container is one of the most
  // common patterns on the web -- a thumbnail link beside a title link -- and
  // it doubles the presses needed to cross a list. Confirmed in this site's
  // real markup: each `div.tv_episode` holds
  //
  //   <a class="start_app_episode"           href=X tid= season= episode= play=>
  //   <a class="start_app_episode watch_tab" href=X tid= season= episode= play=>
  //
  // Same href, same episode, same handler. Without this, a 20-episode season
  // costs 40 stops and every second one is a repeat.
  //
  // The existing duplicate check does not reach these: it lives in the
  // cursor:pointer sweep and tests the PARENT, which catches a button wrapped
  // round its own label but not two siblings.
  //
  // Three deliberate limits, because this only ever REMOVES focus stops and a
  // wrong removal makes something unreachable:
  //  - anchors only, and only with the same non-empty href. A different href
  //    is a different destination and both must stay.
  //  - same parent only. Two links to one place in different parts of a page
  //    are genuinely two routes there.
  //  - placeholder hrefs are never keys. `javascript:;` and `#` are shared by
  //    unrelated buttons all over this site -- the film's own Play button is
  //    `href="javascript:;"` -- so keying on them would collapse controls that
  //    have nothing to do with each other. That would be the dead-remote bug
  //    this navigation exists to avoid, caused by the fix for a lesser one.
  //
  // The survivor is the LARGER of the two, since the focus ring is easier to
  // see on it. Rects are measured only when a collision is found, so the
  // common path adds no layout reads -- the thing that would actually cost
  // something on a TV CPU.
  function navCollapseDuplicateLinks(list, stamp) {
    var byKey = {}, out = [], pid = 0, i, n, href, p, key, at, cur;
    function area(el) {
      try { var r = el.getBoundingClientRect(); return (r.width || 0) * (r.height || 0); }
      catch (e) { return 0; }
    }
    for (i = 0; i < list.length; i++) {
      n = list[i];
      href = (n.tagName && n.tagName.toUpperCase() === 'A')
        ? String(n.getAttribute('href') || '') : '';
      p = n.parentElement;
      if (!href || !p || /^\s*(javascript:|#)/i.test(href)) { out.push(n); continue; }
      if (p.__navDupAt !== stamp) { p.__navDupAt = stamp; p.__navDupId = ++pid; }
      key = p.__navDupId + '|' + href;
      at = byKey[key];
      if (at == null) { byKey[key] = out.length; out.push(n); continue; }
      cur = out[at];
      if (area(n) > area(cur)) out[at] = n;        // keep the bigger target
    }
    return out;
  }

  function navCandidates() {
    var y = W.pageYOffset;
    var fresh = nav.cache && !nav.dirty &&
      Math.abs(y - nav.cacheY) < W.innerHeight * 0.5 && now() - nav.cacheAt < 4000;
    if (!fresh) {
      nav.cache = navHarvest();
      nav.cacheAt = now(); nav.cacheY = y; nav.dirty = false;
    }
    var out = [], vh = W.innerHeight, vw = W.innerWidth, i, n, r;
    for (i = 0; i < nav.cache.length; i++) {
      n = nav.cache[i];
      if (!navAttached(n)) continue;
      r = navRect(n);
      if (r.w < 4 || r.h < 4) continue;
      if (r.b < -vh || r.t > vh * 2 || r.r < 0 || r.l > vw) continue;
      if (!navShown(n, r)) continue;
      out.push({ el: n, r: r });
    }
    return out;
  }

  // Direction scoring, lifted. Left/Right stay on the same row; Up/Down prefer
  // the same column, then fall back to anything below or above, so you can
  // always get out of a header or a short row.
  function navFindNext(cur, dir, cands) {
    var c = navRect(cur), ccx = c.l + c.w / 2, ccy = c.t + c.h / 2;
    var horiz = dir === 'left' || dir === 'right';
    var best = [null, null], bestScore = [Infinity, Infinity], i;
    for (i = 0; i < cands.length; i++) {
      var n = cands[i].el, r = cands[i].r;
      if (n === cur || n.contains(cur) || cur.contains(n)) continue;
      var cx = r.l + r.w / 2, cy = r.t + r.h / 2, primary, overlap;
      if (dir === 'right') {
        if (r.l < c.r - 4 && !(cx > c.r && r.l > c.l + 4)) continue;
        primary = Math.max(0, r.l - c.r);
        overlap = Math.min(c.b, r.b) - Math.max(c.t, r.t);
      } else if (dir === 'left') {
        if (r.r > c.l + 4 && !(cx < c.l && r.r < c.r - 4)) continue;
        primary = Math.max(0, c.l - r.r);
        overlap = Math.min(c.b, r.b) - Math.max(c.t, r.t);
      } else if (dir === 'down') {
        if (r.t < c.b - 4 && !(cy > c.b && r.t > c.t + 4)) continue;
        primary = Math.max(0, r.t - c.b);
        overlap = Math.min(c.r, r.r) - Math.max(c.l, r.l);
      } else {
        if (r.b > c.t + 4 && !(cy < c.t && r.b < c.b - 4)) continue;
        primary = Math.max(0, c.t - r.b);
        overlap = Math.min(c.r, r.r) - Math.max(c.l, r.l);
      }
      var ortho = overlap > 0 ? 0 : -overlap;
      var dPri = horiz ? Math.abs(cx - ccx) : Math.abs(cy - ccy);
      var dOrt = horiz ? Math.abs(cy - ccy) : Math.abs(cx - ccx);
      var tier;
      if (horiz) {
        if (!(overlap > 0 || ortho <= Math.max(20, c.h * 0.5))) continue;
        tier = 0;
      } else {
        tier = (overlap > 0 || dPri >= dOrt * 0.3) ? 0 : 1;
      }
      var score = primary + ortho * 4 + dOrt * 0.15 -
        (overlap > 0 ? Math.min(overlap, 40) * 0.5 : 0);
      if (score < bestScore[tier]) { bestScore[tier] = score; best[tier] = n; }
    }
    return best[0] || best[1];
  }

  function navPickFirst(cands) {
    var best = null, bs = Infinity, i, c, score;
    for (i = 0; i < cands.length; i++) {
      c = cands[i];
      if (c.r.b < 0 || c.r.t > W.innerHeight) continue;
      score = c.r.t * 2 + c.r.l;
      if (score < bs) { bs = score; best = c.el; }
    }
    return best || (cands[0] ? cands[0].el : null);
  }

  // ---------------------------------------------------------------- ring
  function navRingEl() {
    if (nav.ring && navAttached(nav.ring)) return nav.ring;
    var r = D.createElement('div');
    r.setAttribute('data-mbp-nav', 'ring');
    r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;' +
      'border:4px solid #3ea6ff;border-radius:8px;display:none;' +
      'box-shadow:0 0 0 3px rgba(0,0,0,.55),0 0 18px rgba(62,166,255,.85);';
    (D.body || D.documentElement).appendChild(r);
    nav.ring = r;
    return r;
  }
  function navDrawRing() {
    var r = navRingEl();
    if (!nav.on || !nav.focus || !navAttached(nav.focus) || !navShown(nav.focus)) {
      r.style.display = 'none';
      return;
    }
    var b = navRect(nav.focus);
    r.style.display = 'block';
    r.style.left = Math.round(b.l - 3) + 'px';
    r.style.top = Math.round(b.t - 3) + 'px';
    r.style.width = Math.round(b.w + 6) + 'px';
    r.style.height = Math.round(b.h + 6) + 'px';
  }

  // ---------------------------------------------------------------- clicking
  function navFire(n, type, x, y) {
    var ev, init = { bubbles: true, cancelable: true, view: W,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: /down/.test(type) ? 1 : 0 };
    if (type.indexOf('pointer') === 0) {
      init.pointerId = 1; init.pointerType = 'mouse'; init.isPrimary = true;
      try { ev = new W.PointerEvent(type, init); } catch (e) { return; }
    } else {
      try { ev = new W.MouseEvent(type, init); } catch (e2) { return; }
    }
    try { n.dispatchEvent(ev); } catch (e3) {}
  }
  function navHover(n) {
    var r = navRect(n), x = r.l + r.w / 2, y = r.t + r.h / 2;
    navFire(n, 'pointerover', x, y);
    navFire(n, 'mouseover', x, y);
    navFire(n, 'mousemove', x, y);
  }
  function navClick(n) {
    if (!n || !navAttached(n)) return;
    var r = navRect(n), x = r.l + r.w / 2, y = r.t + r.h / 2, t = n;
    // Aim at the innermost child under the centre, so a handler bound to a
    // child of what we focused still sees the click.
    try {
      var hit = D.elementFromPoint(x, y);
      if (hit && hit !== n && n.contains(hit)) t = hit;
    } catch (e) {}
    navFire(t, 'pointerover', x, y); navFire(t, 'mouseover', x, y);
    navFire(t, 'pointerdown', x, y); navFire(t, 'mousedown', x, y);
    navFire(t, 'pointerup', x, y);   navFire(t, 'mouseup', x, y);
    if (t === n && typeof n.click === 'function' &&
        /^(A|BUTTON|INPUT|SUMMARY|LABEL)$/.test(n.tagName)) n.click();
    else navFire(t, 'click', x, y);
  }
  function navTyping() {
    var a = D.activeElement;
    if (!a || a === D.body) return false;
    if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
    if (a.tagName !== 'INPUT') return false;
    return /^(text|search|email|password|number|tel|url)$/.test((a.type || 'text').toLowerCase());
  }
  function navSetFocus(n) {
    if (!n) return;
    nav.focus = n;
    try { n.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    catch (e) { try { n.scrollIntoView(); } catch (e2) {} }
    navHover(n);
    if (/^(A|BUTTON)$/.test(n.tagName)) { try { n.focus({ preventScroll: true }); } catch (e3) {} }
    navDrawRing();
  }
  function navMove(dir) {
    if (now() - nav.lastMove < 80) return;
    nav.lastMove = now();
    var cands = navCandidates();
    if (!cands.length) { navScroll(dir); return; }
    var cur = nav.focus && navAttached(nav.focus) && navShown(nav.focus) ? nav.focus : null;
    if (!cur) { navSetFocus(navPickFirst(cands)); return; }
    var next = navFindNext(cur, dir, cands);
    if (next) navSetFocus(next);
    else navScroll(dir);    // nothing that way: pan the page rather than dead-end
  }
  function navScroll(dir) {
    if (dir !== 'up' && dir !== 'down') return;
    W.scrollBy(0, (dir === 'down' ? 1 : -1) * Math.round(W.innerHeight * 0.4));
    nav.dirty = true;
    navDrawRing();
  }
  function navActivate(n) {
    if (!n || !navAttached(n)) return;
    var tag = n.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || n.isContentEditable) {
      if (/^(checkbox|radio|submit|button|reset|image)$/i.test(n.type || '')) { navClick(n); return; }
      try { n.focus(); } catch (e) {}       // the set's own keyboard comes up
      return;
    }
    if (tag === 'A') {
      var tg = n.getAttribute('target');
      if (tg && tg !== '_self') n.setAttribute('target', '_self');  // a new tab is unreachable here
    }
    nav.dirty = true;
    navClick(n);
    setTimeout(function () { nav.dirty = true; navDrawRing(); }, 400);
  }

  // ---------------------------------------------------------------- page scale
  // The site is a 750px phone design: its own index.js does
  //   var w = innerWidth; if (w > 750) w = 750;  html.style.fontSize = w / 7.5
  // so on a 1920 panel the page renders 750px wide and everything is tiny.
  // This re-does that sum without the cap.
  //
  // Two traps, both already paid for:
  //   - it must be a STYLESHEET rule carrying !important. The site re-applies
  //     its inline font-size on resize, and an inline value loses to nothing
  //     short of an !important rule.
  //   - do NOT use CSS zoom. Measured on this site, getBoundingClientRect
  //     reports unzoomed coordinates while elementFromPoint wants visual
  //     pixels, so every synthetic click's hit test returns null and nothing
  //     is clickable at all.
  var NAV_SCALE_KEY = 'mbp_scale', NAV_SCALE_MIN = 0.5, NAV_SCALE_MAX = 2.5;
  function navScaleClamp(v) {
    return Math.max(NAV_SCALE_MIN, Math.min(NAV_SCALE_MAX, Math.round(v * 20) / 20));
  }
  function navScaleGet() {
    var v = NaN;
    try { v = parseFloat(W.localStorage.getItem(NAV_SCALE_KEY)); } catch (e) {}
    return navScaleClamp(v > 0 ? v : 1);    // 1 == the design filling the screen width
  }
  /* THE CATALOGUE IS NOT THE PHONE DESIGN, and that is why this page stayed
   * tiny while the sign-in page grew.
   *
   * The font-size rule below is a rem fix: it undoes the site's 750px cap so
   * the phone-design pages fill the screen. It works, and it is kept. But the
   * catalogue is a DESKTOP layout sized in px -- measured on the site: 1028
   * px declarations against 331 rem, no vw at all, and two @media blocks
   * holding 66 bytes between them. Nothing about a root font-size can move a
   * px box, which is exactly what 'everything was still tiny' is.
   *
   * A viewport tag can. Ask the engine to lay the page out in fewer CSS
   * pixels and it scales the result up to the panel: px boxes, rem boxes and
   * images all grow together. Proven on project 1 (MBP-STV v1.8.x), where the
   * same root-font-size approach failed on the same page for the same reason.
   *
   * Two traps paid for there, both avoided here:
   *   - every sum must use the width the page had BEFORE our tag, because our
   *     own tag changes innerWidth. Using the live value applies the factor
   *     twice and the page scales by the square of what the menu says.
   *   - the font-size sum must NOT also carry the factor. The viewport scales
   *     rem boxes too, so multiplying here would magnify them twice while the
   *     px boxes around them grew once, and the layout would come apart.
   */
  function navVpApply() {
    if (!nav.baseW) { nav.baseW = W.innerWidth; }
    if (!(nav.baseW > 240)) { return; }
    var f = navScaleGet();

    if (f === 1) {
      // 1 means the page as the site lays it out. One press of Left from a
      // misbehaving set is the page exactly as it shipped.
      if (nav.vpEl && nav.vpEl.parentNode) {
        nav.vpEl.parentNode.removeChild(nav.vpEl);
        nav.dirty = true;
      }
      nav.vpEl = null;
      return;
    }

    var w = Math.round(nav.baseW / f);
    if (!(w > 240)) { return; }

    if (!nav.vpEl || !navAttached(nav.vpEl)) {
      nav.vpEl = D.createElement('meta');
      nav.vpEl.setAttribute('name', 'viewport');
      nav.vpEl.setAttribute('data-mbp-nav', 'viewport');
      // Appended last: where several viewport tags exist the last one wins,
      // so the site's own cannot override ours.
      (D.head || D.documentElement).appendChild(nav.vpEl);
      nav.dirty = true;
    }
    var want = 'width=' + w + ',initial-scale=' + (nav.baseW / w).toFixed(3);
    if (nav.vpEl.getAttribute('content') !== want) {
      nav.vpEl.setAttribute('content', want);
      nav.dirty = true;
    }
  }

  function navScaleApply() {
    navVpApply();

    // Deliberately nav.baseW and NOT the factor: see navVpApply's note on
    // applying it twice.
    var px = (nav.baseW || W.innerWidth) / 7.5;
    if (!(px > 0)) return;                  // a zero-width viewport: leave the site alone
    if (!nav.scaleEl || !navAttached(nav.scaleEl)) {
      nav.scaleEl = D.createElement('style');
      nav.scaleEl.setAttribute('data-mbp-nav', 'scale');
      (D.head || D.documentElement).appendChild(nav.scaleEl);
    }
    var want = 'html{font-size:' + px.toFixed(2) + 'px !important;}';
    if (nav.scaleEl.textContent !== want) { nav.scaleEl.textContent = want; nav.dirty = true; }
  }
  function navScaleNudge(dir) {
    var v = navScaleClamp(navScaleGet() + dir * 0.05);
    try { W.localStorage.setItem(NAV_SCALE_KEY, String(v)); } catch (e) {}
    navScaleApply();
    nav.dirty = true;
    navRenderHelp();
    setTimeout(function () { nav.dirty = true; navDrawRing(); }, 60);
    return v;
  }

  // ---------------------------------------------------------------- help card
  // One key, and it says what every other key does. The colour keys are
  // otherwise undiscoverable without the README, which is no use on a sofa.
  /* ------------------------------------------------- why did it not take over
   *
   * Reported from hardware, 12 November 2026: a title played, but in the
   * SITE'S player - spinner in the middle, a small x top-left, no title and no
   * progress bar. Ours has no spinner and always shows both. So the takeover
   * never fired on the live site, and pressing OK reached the site's own
   * control instead of our pause.
   *
   * takeOver() waits for one inline <script> carrying BOTH `qualityLevels`
   * and `sources`. Something about that is wrong for the live page, and the
   * stranded-page banner cannot report it: that page HAS something selectable
   * (the x), so the banner correctly stays quiet.
   *
   * Rather than guess at the shape of a page nobody here can load - the site
   * is signed-in-only and a developer machine gets the gate page - ask the
   * page itself, on a key the user already presses.
   *
   * NAMES ONLY, NEVER VALUES. A player page's variables hold signed URLs and
   * account identifiers, and this screen gets photographed and sent to me.
   * Counting a name is enough to say which branch of the parser should run;
   * printing its value would put a session on a photograph. */
  var DETECT_MARKERS = ['qualityLevels', 'sources', 'playerData', 'player_data',
                        'videoUrl', 'video_url', 'mp4_id', 'srt_path', 'playlist',
                        'hls', 'm3u8'];

  function navDetectReport() {
    var tags = D.getElementsByTagName('script');
    var inline = 0, bytes = 0, both = 0, i, j, txt;
    var hits = {};
    for (j = 0; j < DETECT_MARKERS.length; j++) { hits[DETECT_MARKERS[j]] = 0; }

    for (i = 0; i < tags.length; i++) {
      if (tags[i].src) { continue; }
      txt = tags[i].textContent || '';
      inline++; bytes += txt.length;
      for (j = 0; j < DETECT_MARKERS.length; j++) {
        if (txt.indexOf(DETECT_MARKERS[j]) >= 0) { hits[DETECT_MARKERS[j]]++; }
      }
      if (txt.indexOf('qualityLevels') >= 0 && txt.indexOf('sources') >= 0) { both++; }
    }

    return { inline: inline, bytes: bytes, both: both, hits: hits,
             external: tags.length - inline,
             video: D.getElementsByTagName('video').length,
             tookOver: !!state.tookOver };
  }

  function navDetectHtml() {
    var d = navDetectReport(), j, name, line = '';
    for (j = 0; j < DETECT_MARKERS.length; j++) {
      name = DETECT_MARKERS[j];
      if (d.hits[name]) { line += name + ' x' + d.hits[name] + '   '; }
    }
    if (!line) { line = '(none of the markers appear in any inline script)'; }

    return '<div style="margin-top:22px;padding-top:16px;' +
      'border-top:1px solid rgba(255,255,255,.18)">' +
      '<div style="font-size:21px;font-weight:600;margin-bottom:8px">Player detection</div>' +
      '<div style="font:15px/1.6 monospace;color:#cfe0ef;white-space:pre-wrap">' +
      'took over       ' + (d.tookOver ? 'YES' : 'no') + '\n' +
      'inline scripts  ' + d.inline + '  (' + d.bytes + ' bytes)\n' +
      // NO ANGLE BRACKETS IN ANY OF THIS TEXT. It goes in through innerHTML,
      // and the first cut wrote a literal <script> here: that opens a script
      // element, so everything after it became raw script content and the rest
      // of the card rendered as visible markup instead of a report.
      'external scripts  ' + d.external + '\n' +
      'video elements  ' + d.video + '\n' +
      'both markers in one script  ' + d.both + '   (takeover needs 1 or more)\n' +
      'markers seen    ' + line +
      '</div>' +
      '<div style="font-size:15px;color:rgba(255,255,255,.5);margin-top:8px">' +
      'Names only - never values. A player page holds signed URLs.</div></div>';
  }

  function navRenderHelp() {
    if (!nav.help) return;
    var rows = [
      ['Up / Down / Left / Right', 'Move the selection'],
      ['OK', 'Open what is selected'],
      ['Back', 'Back a page'],
      ['Blue', 'This screen'],
      ['', ''],
      ['Screen size', Math.round(navScaleGet() * 100) + '%   ◀  ▶']
    ], h = '', i;
    h += '<div style="font-size:30px;font-weight:600;margin-bottom:18px">Remote keys</div>';
    for (i = 0; i < rows.length; i++) {
      if (!rows[i][0]) { h += '<div style="height:14px"></div>'; continue; }
      h += '<div style="display:flex;margin:9px 0;font-size:23px;line-height:1.35">' +
        '<div style="flex:0 0 330px;color:#8fa3b8">' + rows[i][0] + '</div>' +
        '<div style="color:#fff">' + rows[i][1] + '</div></div>';
    }
    h += '<div style="margin-top:20px;font-size:19px;color:rgba(255,255,255,.55)">' +
      'Pick a title and the player takes over by itself.</div>';
    h += navDetectHtml();
    nav.help.innerHTML = h;
  }
  function navToggleHelp() {
    if (nav.help) { navCloseHelp(); return; }
    var d = D.createElement('div');
    d.setAttribute('data-mbp-nav', 'help');
    d.style.cssText = 'position:fixed;right:48px;top:50%;transform:translateY(-50%);' +
      'z-index:2147483647;width:720px;max-width:84vw;padding:34px 38px;border-radius:18px;' +
      'background:rgba(16,18,22,.96);color:#fff;box-shadow:0 10px 40px rgba(0,0,0,.6);' +
      'font-family:SamsungOne,Roboto,Arial,sans-serif;box-sizing:border-box;';
    (D.body || D.documentElement).appendChild(d);
    nav.help = d;
    navRenderHelp();
  }
  function navCloseHelp() {
    if (!nav.help) return;
    try { nav.help.parentNode.removeChild(nav.help); } catch (e) {}
    nav.help = null;
  }

  // ---------------------------------------------------------------- keys
  function navKey(e) {
    var a = KEYS[e.keyCode];
    if (!a) return;
    // A text field has focus, so the set's own keyboard is up and owns the
    // keys. Back still has to work or there is no way out of the field.
    if (navTyping()) {
      if (a !== 'back') return;
      e.preventDefault(); e.stopPropagation();
      try { D.activeElement.blur(); } catch (err) {}
      navDrawRing();
      return;
    }
    if (nav.help) {
      e.preventDefault(); e.stopPropagation();
      if (a === 'left') navScaleNudge(-1);
      else if (a === 'right') navScaleNudge(1);
      else if (a === 'blue' || a === 'back' || a === 'ok') navCloseHelp();
      return;
    }
    if (a === 'up' || a === 'down' || a === 'left' || a === 'right') {
      e.preventDefault(); e.stopPropagation();
      navMove(a);
    } else if (a === 'ok') {
      if (!nav.focus) return;              // nothing selected: let the site have it
      e.preventDefault(); e.stopPropagation();
      navActivate(nav.focus);
    } else if (a === 'blue') {
      e.preventDefault(); e.stopPropagation();
      navToggleHelp();
    } else if (a === 'back') {
      // On a stranded page Back MUST do something. history.back() can land on
      // the same dead page, so from here go to the catalogue outright -- the
      // one place known to work.
      // The banner takes the page's word for nothing: Back keeps its normal
      // meaning. The trigger can be a false alarm, so the escape must be
      // correct in both cases - and history.back() from a stranded player
      // page lands on the detail page, which is a fine way out.
      navStuckHide();
      // Do NOT swallow Back at the bottom of the history stack: on Tizen that
      // is how someone leaves the app, and eating it traps them in the browser.
      if (W.history.length > 1) {
        e.preventDefault(); e.stopPropagation();
        W.history.back();
      }
    }
  }

  /* ----------------------------------------------------- the stuck-page watch
   *
   * Reported from hardware 12 November 2026: pressing OK on a title opened the
   * site's own player page, which then sat on a spinner forever.
   *
   * The module takes over only once an inline script carrying both
   * `qualityLevels` and `sources` appears. When that page never produces one
   * there is nothing to take over - and the module said NOTHING, so the site's
   * spinner was the only thing on screen. A silent wait is indistinguishable
   * from a crash, and there was no way back short of the home key.
   *
   * This does NOT fix the site's page. It makes the failure visible, reports
   * the facts needed to diagnose it, and gives the remote a way out. Every
   * problem solved on this project was solved by a screen that said what it
   * could see; this is that screen for the one place that had none.
   *
   * The trigger is deliberately not 'are we on a player URL' - the module
   * should not have to know the site's URL shapes to notice it is stranded.
   * The condition is simply: nothing on this page can be selected, and no
   * player data has appeared, for long enough that it cannot be slow loading.
   */
  /* Ten seconds, not six. The condition cannot distinguish 'dead page' from
   * 'page whose controls I do not recognise', so it should err late. */
  var STUCK_AFTER_MS = 10000;

  /* What we can see of the page, in the terms that actually decide takeover. */
  function navStuckScan() {
    var s = D.getElementsByTagName('script'), i, txt;
    var inline = 0, bytes = 0, q = 0, src = 0;
    for (i = 0; i < s.length; i++) {
      if (s[i].src) { continue; }
      txt = s[i].textContent || '';
      inline++; bytes += txt.length;
      if (txt.indexOf('qualityLevels') >= 0) { q++; }
      if (txt.indexOf('sources') >= 0) { src++; }
    }
    return { inline: inline, bytes: bytes, quality: q, sources: src };
  }

  function navStuckHide() {
    if (nav.stuckBox && nav.stuckBox.parentNode) {
      nav.stuckBox.parentNode.removeChild(nav.stuckBox);
    }
    nav.stuckBox = null;
  }

  function navStuckShow(secs) {
    var d = navStuckScan();
    if (!nav.stuckBox) {
      /* A strip along the bottom, NOT a full-screen cover. This can be wrong -
       * 'nothing I can select' is not the same as 'this page is dead' - so the
       * cost of being wrong has to stay small. Under the focus ring
       * (2147483646) so a ring is never hidden by a note about being stuck. */
      nav.stuckBox = el('div',
        'position:fixed;left:0;right:0;bottom:0;z-index:2147483640;' +
        'background:rgba(6,8,12,.93);color:#eef;' +
        'font:17px/1.45 system-ui,Arial,sans-serif;padding:16px 28px;' +
        'border-top:2px solid #7fd0ff');
      D.body.appendChild(nav.stuckBox);
    }
    nav.stuckBox.innerHTML = '';
    nav.stuckBox.appendChild(el('div', 'font-weight:700;margin-bottom:4px',
      'Waiting for the player - ' + secs + 's. Nothing here can be selected yet.'));
    nav.stuckBox.appendChild(el('div',
      'font:14px/1.5 monospace;opacity:.85',
      (function () {
        var u = '(unavailable)';
        try { u = String(W.location.pathname + W.location.search).slice(0, 90); } catch (e) {}
        return u + '   ' + D.readyState +
               '   inline scripts ' + d.inline + ' (' + d.bytes + 'b)' +
               '   qualityLevels ' + d.quality + '   sources ' + d.sources;
      }())));
    nav.stuckBox.appendChild(el('div', 'font-size:14px;opacity:.75;margin-top:4px',
      'Takeover needs both markers in the SAME script. Press BACK to go back.'));
  }
  /* Called from the existing nav tick, so it adds no second timer. */
  function navStuckTick(hasCandidates) {
    if (state.tookOver) { navStuckHide(); return; }
    if (hasCandidates || playerDataInPage()) {
      nav.stuckSince = 0;
      navStuckHide();
      return;
    }
    if (!nav.stuckSince) { nav.stuckSince = now(); return; }
    var ms = now() - nav.stuckSince;
    if (ms >= STUCK_AFTER_MS) { navStuckShow(Math.round(ms / 1000)); }
  }

  function navStart() {
    if (nav.on || state.tookOver) return;
    nav.on = true;
    navScaleApply();
    registerKeys();
    D.addEventListener('keydown', navKey, true);
    nav.scrollFn = function () { navDrawRing(); };
    W.addEventListener('scroll', nav.scrollFn, true);
    // NOTE: this must not re-capture nav.baseW. A resize fires when our own
    // viewport tag lands, so re-reading innerWidth here would feed the
    // magnified width back into the sum and shrink the page a step at a time.
    nav.resizeFn = function () { navScaleApply(); nav.dirty = true; navDrawRing(); };
    W.addEventListener('resize', nav.resizeFn);
    try {
      if (W.MutationObserver) {
        nav.obs = new W.MutationObserver(function () { nav.dirty = true; });
        nav.obs.observe(D.documentElement, { childList: true, subtree: true });
      }
    } catch (e) {}
    // Keep a selection alive: pages here arrive in pieces, and the first
    // render often has nothing pickable in it yet.
    nav.pick = setInterval(function () {
      if (!nav.on) { clearInterval(nav.pick); nav.pick = null; return; }
      if (nav.focus && navAttached(nav.focus) && navShown(nav.focus)) {
        navStuckTick(true);
        navDrawRing();
        return;
      }
      var c = navCandidates();
      navStuckTick(c.length > 0);
      if (c.length) navSetFocus(navPickFirst(c));
    }, 700);
  }

  function navStop() {
    if (!nav.on) return;
    nav.on = false;
    D.removeEventListener('keydown', navKey, true);
    if (nav.scrollFn) { W.removeEventListener('scroll', nav.scrollFn, true); nav.scrollFn = null; }
    if (nav.resizeFn) { W.removeEventListener('resize', nav.resizeFn); nav.resizeFn = null; }
    if (nav.obs) { try { nav.obs.disconnect(); } catch (e) {} nav.obs = null; }
    if (nav.pick) { clearInterval(nav.pick); nav.pick = null; }
    navCloseHelp();
    if (nav.ring) { try { nav.ring.parentNode.removeChild(nav.ring); } catch (e2) {} nav.ring = null; }
    nav.focus = null;
    nav.cache = null;
  }

  // ------------------------------------------------------------------ boot
  // The player data is already in the page once the site opens a title -- the
  // site did the navigating and the source lookup, and the <script> block that
  // carries qualityLevels is sitting in the DOM. So the normal path needs no
  // fetch at all: read the live document.
  //
  // Only scripts that mention the marker are read, so this is bounded rather
  // than a sweep of the whole page.
  function playerDataInPage() {
    var out = [], s = D.getElementsByTagName('script'), i, txt;
    for (i = 0; i < s.length; i++) {
      if (s[i].src) continue;
      txt = s[i].textContent || '';
      if (txt.indexOf('qualityLevels') >= 0 && txt.indexOf('sources') >= 0) out.push(txt);
    }
    return out.length ? out.join('\n') : null;
  }

  // Take over only when there is something to play. Until then the site's own
  // pages are left completely alone -- browsing and search are the site's job
  // and already work with a remote, so hijacking them would remove the only
  // way to reach a title.
  function takeOver(scriptText) {
    if (state.tookOver) return;
    state.tookOver = true;
    marks.takeoverAt = now();
    // Navigation and the player must never both hold the keys. This is the
    // whole handover: no mode flag the user can see, no second code path.
    navStop();
    buildUi();
    D.addEventListener('keydown', onKey, true);
    D.addEventListener('keyup', onKeyUp, true);
    registerKeys();
    try { start(scriptText); } catch (e) {
      showMsg(el('div', 'font-size:22px;font-weight:600', 'Could not read the player data'),
              el('div', 'color:#ff8f8f', String(e && e.message || e)));
    }
  }

  // The site also swaps the player in by AJAX without a page load, so the data
  // can arrive late. Watch for it cheaply, and -- now that browsing happens
  // inside this same page load -- never stop watching. See the note on the
  // ceiling below.
  function watchForPlayer() {
    var seen = playerDataInPage();
    if (seen) { takeOver(seen); return; }
    var stop = false;
    function check() {
      if (stop || state.tookOver) return true;
      var t = playerDataInPage();
      if (t) { stop = true; takeOver(t); return true; }
      return false;
    }
    var obs = null;
    try {
      if (W.MutationObserver) {
        obs = new W.MutationObserver(function () { if (check() && obs) obs.disconnect(); });
        obs.observe(D.documentElement, { childList: true, subtree: true });
      }
    } catch (e) {}
    // Belt and braces for a platform where the observer misbehaves.
    //
    // This used to give up after ~5 minutes, which was harmless while the mod
    // assumed you ARRIVED on a player page: either the data was there within
    // seconds or it was never coming. Now that navigation runs in this same
    // page load, someone can browse for longer than that before picking a
    // title -- and a ceiling would mean the player quietly loses the ability
    // to take over once they do. That failure would present as the mod being
    // broken, with nothing on screen to say why, so there is no ceiling.
    //
    // The cost of keeping it is one indexOf sweep of the page's inline
    // scripts per second, which stops for good the instant takeOver() fires.
    var iv = setInterval(function () {
      if (check()) {
        clearInterval(iv);
        if (obs) { try { obs.disconnect(); } catch (e2) {} }
      }
    }, 1000);
  }

  // TizenBrew registers the `keys` array from package.json before navigating,
  // so this is belt and braces rather than the mechanism.
  function registerKeys() {
    try {
      if (!W.tizen || !W.tizen.tvinputdevice) return;
      var want = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
                  'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious',
                  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'];
      for (var i = 0; i < want.length; i++) {
        try { W.tizen.tvinputdevice.registerKey(want[i]); } catch (e) {}
      }
    } catch (e) {}
  }

  // Development hatch. `bootFetch()` wipes the document, which is exactly the
  // behaviour that made the mod unusable before -- so a querystring alone must
  // not be able to reach it. A link could arrive on the TV by accident; a
  // localStorage flag cannot. Both are required, and the flag has to be set
  // deliberately from a console:
  //
  //     localStorage.setItem('mbp_dev', '1')
  //
  // Dev-only. Nothing in normal use goes near this path.
  function devOpenRequest() {
    var on = false;
    try { on = W.localStorage.getItem('mbp_dev') === '1'; } catch (e) { return null; }
    if (!on) return null;
    var m = /[?&]mbpopen=(tv|movie):(\d+)/.exec(W.location.search);
    return m ? { kind: m[1], id: m[2] } : null;
  }

  function boot() {
    var forced = devOpenRequest();
    if (forced) { CFG.open = forced; bootFetch(); return; }
    navStart();         // make the site's own pages reachable with the remote
    watchForPlayer();   // and hand over the moment a player appears
  }

  function bootFetch() {
    buildUi();
    D.addEventListener('keydown', onKey, true);
    D.addEventListener('keyup', onKeyUp, true);
    registerKeys();
    state.tookOver = true;
    marks.takeoverAt = now();
    showMsg(el('div', 'font-size:26px;font-weight:600', 'MBP Native Player'),
            el('div', 'color:#8fa3b8', CFG.open && CFG.open.id
                ? ('Loading ' + CFG.open.kind + ' ' + CFG.open.id + '...')
                : 'Loading...'));

    function load() {
      return fetchPlayer(CFG.open, 0).then(start);
    }

    load()['catch'](function (err) {
      if (err && err.needsAuth) {
        startPairing(function () { load()['catch'](function (e2) { fail(e2); }); });
        return;
      }
      fail(err);
    });

    function fail(err) {
      // No session is the most likely cause; the pairing flow is the fix, and
      // it is same-origin here so it needs no CORS either.
      showMsg(el('div', 'font-size:22px;font-weight:600', 'Could not load the player page'),
              el('div', 'color:#ff8f8f', String(err && err.message || err)),
              el('div', 'class', ''),
              el('div', 'color:#8fa3b8;font-size:14px',
                 'If this is a session problem, sign in on this TV once: ' +
                 'the site pairs a device at /index/login/code_login with an 8-digit code.'));
    }

  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed so the offline fixture can drive the parser without a network.
  W.__mbpSliceApi = {
    saveProgress: saveProgress,
    refreshLink: refreshLink,
    playNext: playNext,
    urlExpiry: urlExpiry,
    startPairing: startPairing,
    // navigation, so the fixture can drive the D-pad without a remote
    nav: nav,
    navCandidates: navCandidates,
    navCollapseDuplicateLinks: navCollapseDuplicateLinks,
    navMove: navMove,
    navActivate: navActivate,
    navSetFocus: navSetFocus,
    navPickFirst: navPickFirst,
    navScaleGet: navScaleGet,
    navScaleApply: navScaleApply,
    navScaleNudge: navScaleNudge,
    navToggleHelp: navToggleHelp,
    navStart: navStart,
    navStop: navStop,
    openSubPanel: openSubPanel,
    openSettings: openSettings,
    closeSettings: closeSettings,
    settingsRows: settingsRows,
    panelKey: panelKey,
    stepRung: stepRung,
    usableRungs: usableRungs,
    rungPref: rungPref,
    rememberRung: rememberRung,
    pickRung: pickRung,
    SAFE_HEIGHT: SAFE_HEIGHT,
    closeSubPanel: closeSubPanel,
    chooseSub: chooseSub,
    nudgeDelay: nudgeDelay,
    parseSkips: parseSkips,
    endEpisode: endEpisode,
    onWake: onWake,
    retryOwedRefresh: retryOwedRefresh,
    onStallStart: onStallStart,
    onStallEnd: onStallEnd,
    stallText: stallText,
    wakeHint: wakeHint,
    checkSkips: checkSkips,
    isUnauthenticated: isUnauthenticated,
    extractPairCode: extractPairCode,
    secondsUntilExpiry: secondsUntilExpiry,
    fetchTarget: fetchTarget,
    CFG: CFG,
    now: now,
    state: state,
    parsePlayerPage: parsePlayerPage,
    playerDataInPage: playerDataInPage,
    takeOver: takeOver,
    devOpenRequest: devOpenRequest,
    toggleDiag: toggleDiag,
    diagLines: diagLines,
    marks: marks,
    BUILD_VERSION: BUILD_VERSION,
    BUILD_SHA: BUILD_SHA,
    BUILD_SRC: BUILD_SRC,
    pickRung: pickRung,
    sourceFor: sourceFor,
    subtitleVttUrl: subtitleVttUrl,
    extractJson: extractJson,
    extractScalar: extractScalar,
    extractSubtitles: extractSubtitles,
    start: start
  };
})();
