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

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PUBLIC_BASE_URL` | *(from Host header)* | Force the absolute URL used in `og:video` tags, e.g. `https://embedmyigreel.com`. Set this in production behind a proxy that doesn't forward `X-Forwarded-Proto/Host`. |
| `IG_DOC_ID` | `28000200952919027` | Instagram's persisted-query ID for `PolarisPostRootQuery`. Instagram rotates these occasionally — override without redeploying if extraction starts failing. |
| `CACHE_TTL_MS` | `1800000` (30 min) | In-memory metadata cache TTL |

## Deployment notes / caveats

- **Discord needs HTTPS** for `og:video` URLs. Put the service behind TLS (Caddy, nginx + certbot, Cloudflare, or a PaaS like Fly/Railway).
- **Datacenter IPs can get rate-limited or blocked by Instagram.** Residential/less-common hosting IPs work best. If you see `reel not found or query rejected` errors for reels that clearly exist, the server IP is likely being challenged. Routing just the GraphQL call through a proxy is the usual fix.
- **`IG_DOC_ID` rotation.** Instagram retires query IDs every few months (old ones return "soft-deleted" errors). Get a fresh one by opening any reel on instagram.com with DevTools → Network → filter `graphql` → the `PolarisPostRootQuery` request's `doc_id` form field. Also confirm the `variables` shape hasn't changed.
- Private-account and age-gated reels can't be fetched anonymously and will fall back to a plain link preview.
- The `/healthz` endpoint returns `200 ok` for load-balancer checks.

## Endpoints

| Path | Behavior |
|---|---|
| `/reel/{code}`, `/reels/{code}`, `/p/{code}`, `/tv/{code}`, `/{user}/reel/{code}` | Bot UA → OG embed page; human UA → 302 to Instagram |
| `/videos/{code}.mp4` | Streams the reel MP4 (Range supported) |
| `/oembed?shortcode={code}` | oEmbed JSON (Discord author line) |
| `/` | Landing page with usage instructions |
| `/healthz` | Health check |
