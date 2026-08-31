# igreels_embedder

Makes Instagram reels embed as **playable videos directly inside Discord** (and Telegram, Slack, etc.).

Instagram's pages give Discord's link crawler only a thumbnail image — no `og:video` tag — so reel links never embed as video. This service fixes that: swap `instagram.com` for this service's domain and the reel plays inline.

```
https://www.instagram.com/reel/DaYHHJvqxWO/?utm_source=ig_web_copy_link&igsh=NTc4...
                      ↓
https://your-domain.com/reel/DaYHHJvqxWO/
```

Everything after the shortcode — extra path segments, `?utm_source=`, `?igsh=`, anything — is ignored. The `/{username}/reel/{code}`, `/reels/{code}`, `/p/{code}`, and `/tv/{code}` link forms work too.

## How it works

1. **Discord's crawler** (`Discordbot` user agent) requests `/reel/{shortcode}`. The service resolves the reel via Instagram's public anonymous GraphQL endpoint (`PolarisPostRootQuery`) and returns an HTML page with `og:video`, `twitter:player:stream`, and oEmbed tags — everything Discord needs to render an inline video player with the author, caption, and like/comment counts.
2. **The video itself** is served from `/videos/{shortcode}.mp4`, which streams the MP4 from Instagram's CDN through this domain (with HTTP Range support). Proxying matters because Instagram's CDN URLs are signed and expire — old Discord embeds keep playing since this service re-resolves a fresh CDN URL whenever the old one dies.
3. **Real people** clicking the link get a `302` redirect to the original reel on instagram.com.
4. **Reels the anonymous endpoint can't see** (age-gated, audience-restricted) are retried against an authenticated endpoint when a session cookie is configured. See [Login-gated reels](#login-gated-reels).

## Running

Requires Node.js ≥ 18. No dependencies.

```sh
node server.js
# or
npm start
```

Test locally:

```sh
# What Discord sees (OG tags):
curl -A Discordbot http://localhost:8080/reel/DaYHHJvqxWO/

# The proxied video:
curl -o reel.mp4 http://localhost:8080/videos/DaYHHJvqxWO.mp4

# What a human gets (302 to Instagram):
curl -i http://localhost:8080/reel/DaYHHJvqxWO/
```

## Login-gated reels

A small share of reels are invisible to anonymous requests. Instagram's anonymous GraphQL endpoint returns a bare `execution error` for them, and opening the link logged out shows one of:

- *"Age-restricted content — This content is age-restricted based on your age or account settings. Log in to continue."*
- *"People under 25 can't see this content — This account has set limits on who can see their profile and content."*

Give the service a session cookie and those resolve too:

```sh
IG_SESSIONID='<sessionid cookie value>' node server.js
```

**How the fallback works.** Anonymous first, always — the account stays out of the request for the reels that don't need it. Only when the anonymous query fails does the service retry against the authenticated media-info endpoint (`/api/v1/media/{id}/info/`, the same one instagram.com's own web client calls), which sees exactly what the logged-in account sees. Shortcodes that turn out to be gated are remembered, so a later re-resolve skips straight to the authenticated path.

### Getting the cookie

1. Log into instagram.com in a browser, as the account the service should view content as. Age-gated reels only resolve if that account is permitted to see them.
2. DevTools → **Application** → **Storage** → **Cookies** → `https://www.instagram.com`.
3. Copy the **Value** of the `sessionid` cookie.

`sessionid` is `HttpOnly`, so it never appears in `document.cookie` — it has to come from the Cookies panel (or off a request's `Cookie:` header in the Network tab).

### Operating notes

- **Treat it as a password.** It authenticates the account outright. Keep it in an environment file with `0600` permissions — not in the repo, and not inline in a world-readable systemd unit.
- **It expires**, typically after months, and immediately on password change or "log out of all sessions". When Instagram rejects it the service logs `[ig-auth] session rejected ...` once and `/healthz` starts reporting `ok (session rejected: ...)`. Nothing else breaks — only gated reels fall back to a link preview.
- **Don't log out of the browser you took it from**; that can invalidate the cookie server-side. Grabbing it from a dedicated browser profile avoids surprises.
- **Prefer a secondary account.** Automated traffic can get an account rate-limited or checkpointed. The service only ever reads media that account could already view, but the risk isn't zero.
- The cookie is only ever sent to `instagram.com` and Meta's media CDNs (`cdninstagram.com`, `fbcdn.net`).

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PUBLIC_BASE_URL` | *(from Host header)* | Force the absolute URL used in `og:video` tags, e.g. `https://embedmyigreel.com`. Set this in production behind a proxy that doesn't forward `X-Forwarded-Proto/Host`. |
| `IG_DOC_ID` | `28000200952919027` | Instagram's persisted-query ID for `PolarisPostRootQuery`. Instagram rotates these occasionally — override without redeploying if extraction starts failing. |
| `CACHE_TTL_MS` | `1800000` (30 min) | In-memory metadata cache TTL |
| `IG_SESSIONID` | *(unset)* | Instagram `sessionid` cookie value. Unlocks age-gated and audience-restricted reels — see [Login-gated reels](#login-gated-reels). Anonymous-only without it. |
| `IG_COOKIE` | *(unset)* | Full `k=v; k=v` cookie string, if you'd rather paste that than a bare `sessionid`. Takes precedence over `IG_SESSIONID`. |

## Deployment notes / caveats

- **Discord needs HTTPS** for `og:video` URLs. Put the service behind TLS (Caddy, nginx + certbot, Cloudflare, or a PaaS like Fly/Railway).
- **Datacenter IPs can get rate-limited or blocked by Instagram.** Residential/less-common hosting IPs work best. If you see `reel not found or query rejected` errors for reels that clearly exist, the server IP is likely being challenged. Routing just the GraphQL call through a proxy is the usual fix.
- **`IG_DOC_ID` rotation.** Instagram retires query IDs every few months (old ones return "soft-deleted" errors). Get a fresh one by opening any reel on instagram.com with DevTools → Network → filter `graphql` → the `PolarisPostRootQuery` request's `doc_id` form field. Also confirm the `variables` shape hasn't changed.
- **Login-gated reels need a session cookie.** Age-gated posts and audience-restricted accounts fail anonymously; set `IG_SESSIONID` to resolve them (see [Login-gated reels](#login-gated-reels)). Without it they fall back to a plain link preview. Reels from private accounts additionally require that the session account follows them.
- The `/healthz` endpoint returns `200` for load-balancer checks, with the session state alongside it: `ok (no session)`, `ok (session configured, not yet used)`, `ok (session ok)` once Instagram has actually honoured the cookie, or `ok (session rejected: ...)`.

## Endpoints

| Path | Behavior |
|---|---|
| `/reel/{code}`, `/reels/{code}`, `/p/{code}`, `/tv/{code}`, `/{user}/reel/{code}` | Bot UA → OG embed page; human UA → 302 to Instagram |
| `/videos/{code}.mp4` | Streams the reel MP4 (Range supported) |
| `/oembed?shortcode={code}` | oEmbed JSON (Discord author line) |
| `/` | Landing page with usage instructions |
| `/healthz` | Health check; body reports session state |
