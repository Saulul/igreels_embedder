#!/usr/bin/env node
/**
 * igreels_embedder — makes Instagram reels embed as playable videos in Discord.
 *
 * Replace `instagram.com` with this service's domain in any reel link:
 *   https://www.instagram.com/reel/DaYHHJvqxWO/  ->  https://<your-domain>/reel/DaYHHJvqxWO/
 *
 * How it works:
 *  - Link-preview crawlers (Discordbot etc.) get an HTML page with og:video /
 *    twitter:player tags pointing at /videos/<shortcode>.mp4 on this domain.
 *  - Real users get a 302 redirect to the original instagram.com reel.
 *  - /videos/<shortcode>.mp4 resolves the reel's CDN MP4 via Instagram's public
 *    GraphQL endpoint (anonymous, no login) and streams it through, with Range
 *    support so Discord's media proxy can seek.
 *  - Reels that anonymous access can't see (age-gated, or from accounts that
 *    restrict their audience) fall back to an authenticated lookup when a
 *    session cookie is configured via IG_SESSIONID. See "Optional logged-in
 *    session" below.
 *
 * Zero dependencies. Node >= 18 required (built-in fetch).
 */

'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');

const PORT = Number(process.env.PORT || 8080);
// Optional: force a public base URL (e.g. https://embedmyigreel.com) for the
// og: tags. When unset, the incoming Host header is used, which works both
// locally and behind a reverse proxy.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000);
const CACHE_MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Instagram scraping
// ---------------------------------------------------------------------------

// Current persisted-query id for PolarisPostRootQuery (the query instagram.com
// itself fires when you open a reel). Instagram rotates these occasionally;
// override via env without redeploying if it goes stale.
const IG_DOC_ID = process.env.IG_DOC_ID || '28000200952919027';
const IG_APP_ID = '936619743392459';
const LSD_TOKEN = 'AVqbxe3J_YA';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// --- Optional logged-in session -------------------------------------------
//
// Anonymous access covers the large majority of reels. A few are only visible
// to a logged-in viewer and fail anonymously with a bare "execution error":
//   - age-gated posts ("Age-restricted content ... Log in to continue")
//   - accounts that limit their audience ("People under 25 can't see this")
//
// Set one of these to resolve those too. With neither set the service behaves
// exactly as it did before: anonymous only, and gated reels degrade to a plain
// link preview.
//
//   IG_SESSIONID  just the `sessionid` cookie value (simplest)
//   IG_COOKIE     a full `k=v; k=v` cookie string, if you'd rather paste that
//
// The cookie authenticates a real account, so keep it in env/systemd rather
// than anywhere world-readable. It is only ever sent to instagram.com and
// Meta's media CDNs (see COOKIE_HOST_RE below).
function buildAuthCookie() {
  const full = (process.env.IG_COOKIE || '').trim().replace(/^Cookie:\s*/i, '');
  if (full) return full;

  // Tolerate a pasted `sessionid=...` prefix or a trailing `; other=...`.
  const sid = (process.env.IG_SESSIONID || '').trim().replace(/^sessionid=/, '').replace(/;.*$/, '').trim();
  if (!sid) return '';

  const parts = [`sessionid=${sid}`];
  // sessionid is `<ds_user_id>%3A<secret>%3A<...>`; Instagram is happier when
  // ds_user_id rides along, and it costs nothing to derive. A stray % in a
  // fat-fingered paste makes decodeURIComponent throw, and this runs at module
  // load — never let that take the whole service down over a nicety.
  try {
    const dsUserId = decodeURIComponent(sid).split(':')[0];
    if (/^\d+$/.test(dsUserId)) parts.push(`ds_user_id=${dsUserId}`);
  } catch {
    console.warn('[ig-auth] could not derive ds_user_id from IG_SESSIONID; sending sessionid alone');
  }
  return parts.join('; ');
}

const IG_COOKIE_HEADER = buildAuthCookie();
const HAS_AUTH = IG_COOKIE_HEADER.length > 0;

// Only ever attach the session cookie to Instagram/Meta hosts.
const COOKIE_HOST_RE = /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net)$/;

function cookieAllowedFor(url) {
  try {
    return COOKIE_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Instagram hands out a rolling anti-abuse claim; echoing the latest one back
// keeps authenticated calls looking like a real client session.
let wwwClaim = '0';

// A session cookie expires eventually, or gets invalidated by a password
// change or a checkpoint. Track that so we stop hammering a dead cookie on
// every request, log it once, and surface it on /healthz — with a periodic
// re-probe in case the failure was transient.
const AUTH_REPROBE_MS = 5 * 60 * 1000;
// Discord gives a crawler only a few seconds; never hang on a slow upstream.
const IG_FETCH_TIMEOUT_MS = Number(process.env.IG_FETCH_TIMEOUT_MS || 8000);
let authState = { ok: true, reason: HAS_AUTH ? 'configured' : 'not configured', since: Date.now() };

function authUsable() {
  if (!HAS_AUTH) return false;
  return authState.ok || Date.now() - authState.since > AUTH_REPROBE_MS;
}

function markAuthDead(reason) {
  if (authState.ok) {
    console.error(
      `[ig-auth] session rejected (${reason}) — refresh IG_SESSIONID; gated reels will fail until then`
    );
  }
  authState = { ok: false, reason, since: Date.now() };
}

function markAuthAlive() {
  if (!authState.ok) console.log('[ig-auth] session accepted again');
  authState = { ok: true, reason: 'ok', since: Date.now() };
}

// --- Shared response shape -------------------------------------------------

// The anonymous GraphQL query and the authenticated media-info endpoint return
// the same media object, so one parser serves both.
function parseMediaItem(shortcode, item) {
  const video = (item.video_versions || [])[0];
  const thumb = (item.image_versions2?.candidates || [])[0];
  return {
    shortcode,
    videoUrl: video?.url || null,
    width: item.original_width || video?.width || 720,
    height: item.original_height || video?.height || 1280,
    thumbnailUrl: thumb?.url || null,
    username: item.user?.username || '',
    fullName: item.user?.full_name || '',
    caption: item.caption?.text || '',
    likeCount: item.like_count ?? null,
    commentCount: item.comment_count ?? null,
  };
}

// --- Tier 1: anonymous GraphQL --------------------------------------------

async function fetchReelAnonymous(shortcode) {
  const body = new URLSearchParams({
    av: '0',
    __d: 'www',
    __user: '0',
    __a: '1',
    __req: '3',
    __ccg: 'UNKNOWN',
    __comet_req: '7',
    lsd: LSD_TOKEN,
    jazoest: '2957',
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'PolarisPostRootQuery',
    server_timestamps: 'true',
    doc_id: IG_DOC_ID,
    variables: JSON.stringify({
      shortcode,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    }),
  });

  const res = await fetch('https://www.instagram.com/api/graphql', {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-IG-App-ID': IG_APP_ID,
      'X-FB-Friendly-Name': 'PolarisPostRootQuery',
      'X-FB-LSD': LSD_TOKEN,
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
    },
    body,
  });
  if (!res.ok) throw new Error(`graphql http ${res.status}`);

  const data = await res.json();
  const item = data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
  if (!item) {
    // Login-gated reels land here as a generic "execution error".
    const msg = data?.errors?.[0]?.message || 'no items in response';
    throw new Error(`not found or query rejected: ${msg}`);
  }
  return parseMediaItem(shortcode, item);
}

// --- Tier 2: authenticated media-info --------------------------------------

// Instagram's own web client calls this endpoint. With a session cookie it
// returns the same media object for content the anonymous GraphQL query
// refuses. It is keyed by numeric media id rather than shortcode — and the
// shortcode *is* that id, base64-encoded, so no extra lookup is needed.
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode) {
    const v = SHORTCODE_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

async function fetchReelAuthenticated(shortcode) {
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) throw new Error('unparseable shortcode');

  let res;
  try {
    res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-IG-App-ID': IG_APP_ID,
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': wwwClaim,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `https://www.instagram.com/reel/${shortcode}/`,
        'Sec-Fetch-Site': 'same-origin',
        Cookie: IG_COOKIE_HEADER,
      },
      // A stale cookie gets bounced towards the login page; following that
      // just burns redirects and surfaces as an opaque "fetch failed".
      redirect: 'manual',
      signal: AbortSignal.timeout(IG_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'media info timed out' : `media info request failed: ${err.message}`);
  }

  const claim = res.headers.get('x-ig-set-www-claim');
  if (claim) wwwClaim = claim;

  // Redirected instead of answered: the session is no longer being honoured.
  if (res.status >= 300 && res.status < 400) {
    const target = res.headers.get('location') || 'elsewhere';
    markAuthDead(target.includes('login') ? 'redirected to login' : `redirected to ${target.slice(0, 60)}`);
    throw new Error('session rejected (redirected to login)');
  }
  if (res.status === 401 || res.status === 403) {
    markAuthDead(`http ${res.status}`);
    throw new Error(`session rejected (http ${res.status})`);
  }
  if (res.status === 429) throw new Error('rate limited (http 429)');
  if (!res.ok) throw new Error(`media info http ${res.status}`);

  const data = await res.json().catch(() => null);
  if (data?.require_login || data?.message === 'login_required' || data?.message === 'checkpoint_required') {
    markAuthDead(data.message || 'require_login');
    throw new Error(`session rejected (${data?.message || 'require_login'})`);
  }

  const item = data?.items?.[0];
  if (!item) throw new Error(`media info returned no items: ${data?.message || 'unknown'}`);

  markAuthAlive();
  return parseMediaItem(shortcode, item);
}

// --- Orchestration ---------------------------------------------------------

// Shortcodes anonymous access can't see. Remembering them lets a re-resolve
// (after the CDN URL expires, say) go straight to the authenticated path
// instead of paying for a round trip that is guaranteed to fail.
const needsAuth = new Set();

function rememberNeedsAuth(shortcode) {
  if (needsAuth.size >= CACHE_MAX_ENTRIES) needsAuth.clear();
  needsAuth.add(shortcode);
}

async function fetchReelFromInstagram(shortcode) {
  const canAuth = authUsable();
  // Anonymous first — it keeps the account out of the request for the reels
  // that don't need it. Reels already known to be gated skip straight to auth.
  const order = canAuth && needsAuth.has(shortcode) ? ['auth', 'anon'] : ['anon', 'auth'];

  const failures = [];
  for (const mode of order) {
    if (mode === 'auth' && !canAuth) continue;
    try {
      const reel =
        mode === 'auth' ? await fetchReelAuthenticated(shortcode) : await fetchReelAnonymous(shortcode);
      if (mode === 'auth') rememberNeedsAuth(shortcode);
      else needsAuth.delete(shortcode);
      return reel;
    } catch (err) {
      failures.push(`${mode}: ${err.message}`);
      if (mode === 'anon' && canAuth) {
        console.log(`[reel ${shortcode}] anonymous failed (${err.message}) — retrying with session`);
      }
    }
  }
  if (!HAS_AUTH) failures.push('auth: no session configured (set IG_SESSIONID)');
  else if (!canAuth) failures.push(`auth: skipped, session marked bad (${authState.reason})`);
  throw new Error(failures.join('; '));
}

// Tiny TTL cache so one Discord message (crawler hit + video fetch + oembed)
// costs a single Instagram request.
const cache = new Map(); // shortcode -> { at, promise }

function getReel(shortcode, { bypassCache = false } = {}) {
  const hit = cache.get(shortcode);
  if (!bypassCache && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;

  const promise = fetchReelFromInstagram(shortcode);
  cache.set(shortcode, { at: Date.now(), promise });
  promise.catch(() => cache.delete(shortcode)); // don't cache failures
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return promise;
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

// Crawlers that fetch link previews. Everyone else is a human and gets
// redirected to the real instagram.com page.
const BOT_UA_RE =
  /discordbot|telegrambot|twitterbot|facebookexternalhit|whatsapp|slackbot|linkedinbot|redditbot|skypeuripreview|pinterest|vkshare|embedly|iframely|bot|crawler|spider/i;

// Accepts /reel/<code>, /reels/<code>, /p/<code>, /tv/<code>, and the
// share-link form /<username>/reel/<code>. Everything after the shortcode
// (extra path segments, ?utm_source=..., ?igsh=..., etc.) is ignored because
// we only capture the shortcode itself and never look at the query string.
const REEL_PATH_RE = /^\/(?:[A-Za-z0-9._]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,39})(?:[/?].*)?$/;
const VIDEO_PATH_RE = /^\/videos\/([A-Za-z0-9_-]{5,39})(?:\.mp4)?\/?$/;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location) {
  send(res, 302, { Location: location, 'Cache-Control': 'no-store' }, '');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function statsLine(reel) {
  const parts = [];
  if (reel.likeCount != null) parts.push(`❤️ ${reel.likeCount.toLocaleString('en-US')}`);
  if (reel.commentCount != null) parts.push(`💬 ${reel.commentCount.toLocaleString('en-US')}`);
  return parts.join('   ');
}

async function handleReelPage(req, res, shortcode) {
  const igUrl = `https://www.instagram.com/reel/${shortcode}/`;
  const ua = req.headers['user-agent'] || '';

  // Humans go straight to Instagram.
  if (!BOT_UA_RE.test(ua)) return redirect(res, igUrl);

  let reel;
  try {
    reel = await getReel(shortcode);
  } catch (err) {
    console.error(`[reel ${shortcode}] scrape failed:`, err.message);
    // Fall back to a plain link preview rather than an error page.
    return send(
      res,
      200,
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      `<!DOCTYPE html><html><head>` +
        `<meta property="og:title" content="Instagram Reel" />` +
        `<meta property="og:description" content="Couldn't fetch this reel right now — tap to open on Instagram." />` +
        `<meta property="og:url" content="${esc(igUrl)}" />` +
        `<meta http-equiv="refresh" content="0;url=${esc(igUrl)}" />` +
        `</head><body></body></html>`
    );
  }

  const base = baseUrl(req);
  const videoUrl = `${base}/videos/${shortcode}.mp4`;
  const oembedUrl = `${base}/oembed?shortcode=${shortcode}`;
  const title = reel.username ? `@${reel.username}` : 'Instagram Reel';
  const description = [statsLine(reel), reel.caption].filter(Boolean).join('\n').slice(0, 340);

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8" />` +
    `<meta name="theme-color" content="#E1306C" />` +
    `<meta property="og:type" content="video.other" />` +
    `<meta property="og:url" content="${esc(igUrl)}" />` +
    `<meta property="og:title" content="${esc(title)}" />` +
    `<meta property="og:description" content="${esc(description)}" />` +
    (reel.thumbnailUrl ? `<meta property="og:image" content="${esc(reel.thumbnailUrl)}" />` : '') +
    `<meta property="og:video" content="${esc(videoUrl)}" />` +
    `<meta property="og:video:secure_url" content="${esc(videoUrl)}" />` +
    `<meta property="og:video:type" content="video/mp4" />` +
    `<meta property="og:video:width" content="${reel.width}" />` +
    `<meta property="og:video:height" content="${reel.height}" />` +
    `<meta name="twitter:card" content="player" />` +
    `<meta name="twitter:title" content="${esc(title)}" />` +
    `<meta name="twitter:player:stream" content="${esc(videoUrl)}" />` +
    `<meta name="twitter:player:stream:content_type" content="video/mp4" />` +
    `<meta name="twitter:player:width" content="${reel.width}" />` +
    `<meta name="twitter:player:height" content="${reel.height}" />` +
    `<link rel="alternate" type="application/json+oembed" href="${esc(oembedUrl)}" title="${esc(title)}" />` +
    `</head><body>Redirecting to <a href="${esc(igUrl)}">${esc(igUrl)}</a></body></html>`;

  send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, html);
}

// Discord reads oEmbed to render the small "author / provider" line above the embed.
async function handleOembed(req, res, url) {
  const shortcode = (url.searchParams.get('shortcode') || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!shortcode) return send(res, 400, { 'Content-Type': 'application/json' }, '{"error":"missing shortcode"}');
  try {
    const reel = await getReel(shortcode);
    const authorName = [statsLine(reel)].filter(Boolean).join('') || `@${reel.username}`;
    send(
      res,
      200,
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      JSON.stringify({
        version: '1.0',
        type: 'video',
        author_name: authorName,
        author_url: `https://www.instagram.com/${reel.username}/`,
        title: reel.caption.slice(0, 256),
      })
    );
  } catch (err) {
    send(res, 404, { 'Content-Type': 'application/json' }, '{"error":"reel not found"}');
  }
}

// Streams the reel MP4 through our domain. The Instagram CDN URL is signed and
// expires after a while; resolving it fresh here (with cache + one retry on
// 403) keeps embeds working long after the message was posted.
async function handleVideo(req, res, shortcode) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let reel;
    try {
      reel = await getReel(shortcode, { bypassCache: attempt > 0 });
    } catch (err) {
      console.error(`[video ${shortcode}] scrape failed:`, err.message);
      return send(res, 404, { 'Content-Type': 'text/plain' }, 'Reel not found');
    }
    if (!reel.videoUrl) return send(res, 404, { 'Content-Type': 'text/plain' }, 'This post has no video');

    const upstreamHeaders = { 'User-Agent': BROWSER_UA };
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;

    let upstream;
    try {
      upstream = await fetch(reel.videoUrl, { headers: upstreamHeaders });
      // The CDN URL is signed, so an anonymous fetch normally suffices — but
      // gated media is sometimes handed out only to an authenticated one.
      if ((upstream.status === 401 || upstream.status === 403) && HAS_AUTH && cookieAllowedFor(reel.videoUrl)) {
        upstream = await fetch(reel.videoUrl, {
          headers: { ...upstreamHeaders, Cookie: IG_COOKIE_HEADER },
        });
      }
    } catch (err) {
      console.error(`[video ${shortcode}] cdn fetch failed:`, err.message);
      return send(res, 502, { 'Content-Type': 'text/plain' }, 'Upstream fetch failed');
    }

    // Signed URL expired -> re-resolve once with a fresh scrape.
    if ((upstream.status === 403 || upstream.status === 410) && attempt === 0) {
      cache.delete(shortcode);
      continue;
    }
    if (!upstream.ok && upstream.status !== 206) {
      return send(res, 502, { 'Content-Type': 'text/plain' }, `Upstream error ${upstream.status}`);
    }

    const headers = {
      'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }

    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }
}

function handleLanding(req, res) {
  const base = baseUrl(req);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>saulinstagram</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;line-height:1.6;color:#222}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>saulinstagram</h1>
<p>Make Instagram reels play directly inside Discord.</p>
<p>Take any reel link and replace <code>instagram.com</code> with <code>${esc(base.replace(/^https?:\/\//, ''))}</code>:</p>
<p><code>https://www.instagram.com/reel/DaYHHJvqxWO/</code><br />&darr;<br /><code>${esc(base)}/reel/DaYHHJvqxWO/</code></p>
<p>Paste the new link in Discord and the video embeds. Opening the link in a browser redirects you to the original reel on Instagram.</p>
</body></html>`;
  send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://internal');
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad request');
  }
  const path = url.pathname;

  try {
    let m;
    if (path === '/' || path === '') return handleLanding(req, res);
    if (path === '/healthz') {
      // "configured" and "ok" differ on purpose: the first means a cookie is
      // present, the second that Instagram has actually honoured it.
      const auth = !HAS_AUTH
        ? 'no session'
        : !authState.ok
        ? `session rejected: ${authState.reason}`
        : authState.reason === 'ok'
        ? 'session ok'
        : 'session configured, not yet used';
      return send(res, 200, { 'Content-Type': 'text/plain' }, `ok (${auth})`);
    }
    if (path === '/oembed') return await handleOembed(req, res, url);
    if ((m = path.match(VIDEO_PATH_RE))) return await handleVideo(req, res, m[1]);
    if ((m = path.match(REEL_PATH_RE))) return await handleReelPage(req, res, m[1]);
    // Unknown instagram-ish path: bounce to instagram.com with the same path.
    return redirect(res, `https://www.instagram.com${path}`);
  } catch (err) {
    console.error(`[${req.method} ${path}] unhandled:`, err);
    if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain' }, 'Internal error');
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`igreels_embedder listening on http://localhost:${PORT}`);
  console.log(
    HAS_AUTH
      ? '[ig-auth] session cookie configured — age-gated and audience-restricted reels enabled'
      : '[ig-auth] no session cookie (set IG_SESSIONID) — gated reels fall back to a plain link preview'
  );
  console.log(`try: http://localhost:${PORT}/reel/DaYHHJvqxWO/`);
});