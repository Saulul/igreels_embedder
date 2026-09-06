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

## Deploying

The reference deployment is systemd + nginx + Let's Encrypt on a Debian/Ubuntu box, running the service as an unprivileged user behind a TLS reverse proxy. Substitute your own domain for `example.com` throughout.

Discord will not render `og:video` over plain HTTP, so TLS is not optional.

### 1. Service user and code

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin igreels
sudo mkdir -p /opt/igreels-embedder
sudo git clone https://github.com/Saulul/igreels_embedder.git /opt/igreels-embedder
sudo chown -R igreels:igreels /opt/igreels-embedder
```

Node.js ≥ 18 is the only requirement — there are no dependencies to install.

### 2. Secrets

The session cookie goes in a root-only environment file, never in the unit itself:

```sh
sudo install -m 600 -o root -g root /dev/null /etc/igreels-embedder.env
printf 'IG_SESSIONID=%s\n' 'PASTE_SESSIONID_HERE' | sudo tee -a /etc/igreels-embedder.env > /dev/null
```

Use `EnvironmentFile=`, not an `Environment=` line in the unit. Unit files are world-readable (`0644` on a stock Ubuntu box), and `systemctl show -p Environment` prints their values to any local user — including `nobody`. A value loaded from `EnvironmentFile=` shows up in neither, and the file itself is `0600` root-only. systemd reads it as root before dropping to the service user, so the unprivileged process still gets the value.

Skip this step to run anonymous-only; see [Login-gated reels](#login-gated-reels).

### 3. systemd unit

`/etc/systemd/system/igreels-embedder.service`:

```ini
[Unit]
Description=igreels-embedder (Instagram reel -> Discord embed service)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=igreels
Group=igreels
WorkingDirectory=/opt/igreels-embedder
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=PUBLIC_BASE_URL=https://example.com
EnvironmentFile=-/etc/igreels-embedder.env
ExecStart=/usr/bin/node /opt/igreels-embedder/server.js
Restart=on-failure
RestartSec=3

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
```

The service never writes to disk, so `ProtectSystem=strict` with an empty `ReadWritePaths=` is safe. The leading `-` on `EnvironmentFile=` makes the file optional, so the service still starts if you haven't created it.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now igreels-embedder
```

### 4. nginx

`/etc/nginx/sites-available/igreels.conf`, symlinked into `sites-enabled/`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;

    # Stream video straight through instead of buffering whole MP4s to disk.
    proxy_buffering off;
    proxy_http_version 1.1;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        proxy_read_timeout 60s;
        client_max_body_size 1m;
    }
}
```

`proxy_buffering off` matters: without it nginx buffers each `/videos/*.mp4` response before forwarding, which delays playback and burns disk on large reels.

```sh
sudo ln -s /etc/nginx/sites-available/igreels.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d example.com -d www.example.com
```

Certbot rewrites the block to listen on 443 and adds the HTTP→HTTPS redirect.

### 5. Verify

```sh
curl -s https://example.com/healthz
curl -s -A Discordbot https://example.com/reel/DaYHHJvqxWO/ | grep -o 'og:video[^>]*'
curl -s -o /dev/null -D - -r 0-1023 https://example.com/videos/DaYHHJvqxWO.mp4 | head -1
```

Expect `ok (...)`, an `og:video` URL on your own domain, and `206 Partial Content` — Discord's media proxy relies on range requests. If you configured a session cookie, `/healthz` reports `session configured, not yet used` until the first gated reel is resolved, then `session ok`.

Then paste a reel link into Discord with the domain swapped and confirm it plays inline.

### 6. Continuous deployment (GitHub Actions)

Pushes to `main` deploy themselves. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) syntax-checks the commit on a runner, then asks the server to move to it over SSH. The rollout itself is [`deploy/igreels-deploy.sh`](deploy/igreels-deploy.sh), installed on the box: it fetches, `git reset --hard`s to the pushed commit, runs `node --check`, restarts the unit, polls `/healthz` — and **rolls back to the previous commit if the service doesn't come back healthy**.

The deploy key is pinned to a *forced command*, so it can run that one script and nothing else — no shell, no forwarding. A leaked key can redeploy the repo; it does not hand over the box.

#### One-time server setup

```sh
# 1. Install the deploy hook.
curl -fsSL https://raw.githubusercontent.com/Saulul/igreels_embedder/main/deploy/igreels-deploy.sh   | install -m 0755 /dev/stdin /usr/local/sbin/igreels-deploy

# 2. Authorise the deploy key, locked to that one command.
cat >> /root/.ssh/authorized_keys <<'KEY'
command="/usr/local/sbin/igreels-deploy",restrict ssh-ed25519 AAAA...  github-actions-deploy
KEY
```

`restrict` turns off pty allocation and agent/port/X11 forwarding; `command=` overrides whatever the client asks to run. The client's request survives only in `SSH_ORIGINAL_COMMAND`, which the script parses and validates as `deploy [<40-hex sha>]` before doing anything with it.

The first deploy adopts `/opt/igreels-embedder` as a git checkout in place — `git init` + `remote add` + `reset --hard` — so a hand-copied tree converts without downtime. Untracked files (old `.bak`s) are left alone; `/etc/igreels-embedder.env` is never touched, so the session cookie survives every deploy.

#### Repository secrets

Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | the deploy key's **private** half — the whole file, `BEGIN`/`END` lines included |
| `DEPLOY_HOST` | the server's IP or hostname |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ssh-ed25519 <host>` output — pins the host key so the job can't be MITM'd |

Host and known-hosts are secrets rather than literals only to keep the server's address out of a public repo; neither is sensitive in itself.

### Deploying by hand

The hook is a normal script — run it as root on the server to force a rollout, or to pin a specific commit:

```sh
igreels-deploy                       # tip of origin/main
igreels-deploy 218589dfcc2e69094...  # a specific commit (full 40-char sha)
systemctl is-active igreels-embedder && curl -s localhost:8080/healthz
journalctl -u igreels-embedder -f
```

Rolling back is just deploying the previous sha. There is no build step or migration.

## Caveats

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
