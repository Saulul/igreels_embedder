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
// Instagram scraping (anonymous GraphQL)
// ---------------------------------------------------------------------------

// Current persisted-query id for PolarisPostRootQuery (the query instagram.com
// itself fires when you open a reel). Instagram rotates these occasionally;
// override via env without redeploying if it goes stale.
const IG_DOC_ID = process.env.IG_DOC_ID || '28000200952919027';
const IG_APP_ID = '936619743392459';
const LSD_TOKEN = 'AVqbxe3J_YA';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchReelFromInstagram(shortcode) {
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
  if (!res.ok) throw new Error(`instagram graphql http ${res.status}`);

  const data = await res.json();
  const item = data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
  if (!item) {
    const msg = data?.errors?.[0]?.message || 'no items in response';
    throw new Error(`reel not found or query rejected: ${msg}`);
  }

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
    if (path === '/healthz') return send(res, 200, { 'Content-Type': 'text/plain' }, 'ok');
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
  console.log(`try: http://localhost:${PORT}/reel/DaYHHJvqxWO/`);
});
