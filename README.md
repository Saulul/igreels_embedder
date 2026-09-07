# igreels_embedder

Makes Instagram reels embed as **playable videos directly inside Discord** (and Telegram, Slack, etc.).

Instagram gives Discord's crawler a thumbnail and no `og:video` tag, so reel links never embed as video. Swap `instagram.com` for this service's domain and the reel plays inline:

```
https://www.instagram.com/reel/DaYHHJvqxWO/?utm_source=ig_web_copy_link&igsh=NTc4...
                      ↓
https://your-domain.com/reel/DaYHHJvqxWO/
```

Everything after the shortcode is ignored. The `/{username}/reel/{code}`, `/reels/{code}`, `/p/{code}` and `/tv/{code}` forms work too.

## How it works

1. **Discord's crawler** gets an HTML page with `og:video`, `twitter:player:stream` and oEmbed tags, resolved from Instagram's anonymous GraphQL endpoint (`PolarisPostRootQuery`).
2. **The video** is served from `/videos/{shortcode}.mp4`, streaming the CDN MP4 through this domain with Range support. Proxying matters because Instagram's CDN URLs are signed and expire — old embeds keep playing because the service re-resolves a fresh URL when the old one dies.
3. **Real people** get a `302` to the original reel.
4. **Reels the anonymous endpoint can't see** are retried against an authenticated endpoint when a session cookie is configured. See [Login-gated reels](#login-gated-reels).

## Running

Requires Node.js ≥ 18. No dependencies.

```sh
node server.js   # or: npm start
```

```sh
# What Discord sees (OG tags):
curl -A Discordbot http://localhost:8080/reel/DaYHHJvqxWO/

# The proxied video:
curl -o reel.mp4 http://localhost:8080/videos/DaYHHJvqxWO.mp4

# What a human gets (302 to Instagram):
curl -i http://localhost:8080/reel/DaYHHJvqxWO/
```

## Login-gated reels

A small share of reels are invisible to anonymous requests — age-restricted posts, and accounts that limit who can see their content. The anonymous endpoint returns a bare `execution error` for them. A session cookie resolves them:

```sh
IG_SESSIONID='<sessionid cookie value>' node server.js
```

Anonymous is always tried first, so the account stays out of the request for reels that don't need it. Only on failure does the service retry against `/api/v1/media/{id}/info/` — the same endpoint instagram.com's own web client calls — which sees what the logged-in account sees. Gated shortcodes are remembered so later re-resolves skip straight there.

### Getting the cookie

1. Log into instagram.com as the account the service should view content as. Age-gated reels only resolve if that account may see them.
2. DevTools → **Application** → **Cookies** → `https://www.instagram.com` → copy the **Value** of `sessionid`.

It's `HttpOnly`, so it never appears in `document.cookie` — it has to come from the Cookies panel or a request's `Cookie:` header. You should only need to do this once; see below.

### Rotation

Instagram rotates `sessionid` on its own schedule without logging anyone out, returning the replacement on a `Set-Cookie` header. That's why a browser sails through a rotation while a service holding a hard-coded copy silently starts failing.

So the service follows the rotation rather than being told about it:

1. Every authenticated response is read for `Set-Cookie`; a new `sessionid` is adopted on the spot, along with `csrftoken`, `rur`, `mid` and friends so the jar stays browser-shaped.
2. The result is written to a state file, so it survives restarts and deploys.
3. A keepalive calls an authenticated endpoint hourly, purely so there is a response to read cookies from. This is the load-bearing part: the authenticated path otherwise only fires for gated reels, which can be days apart, and **each rotation is bought with the cookie that preceded it**.

`IG_SESSIONID` is therefore a *seed*. From the first rotation onward the state file holds the live value. Pasting a new seed by hand still wins — the stored session records a fingerprint of the seed it grew from, and a mismatch abandons the stored chain.

You only go back to DevTools if the session is genuinely killed (password change, "log out of all sessions", a checkpoint — set `IG_ALERT_WEBHOOK` to hear about it), or if the service is down long enough to miss a rotation.

### Operating notes

- **Treat it as a password.** Keep it in a `0600` environment file — not in the repo, not inline in a world-readable unit.
- **It renews itself, until it doesn't.** On outright rejection the service logs `[ig-auth] session rejected ...` once, fires `IG_ALERT_WEBHOOK`, and `/healthz` reports `"state": "rejected"`. Only gated reels degrade.
- **Leave the browser profile you seeded from idle.** Don't log out (that kills the cookie server-side), but don't keep browsing in it either — an active browser is a second client rotating the same session, and the two can strand each other.
- **Prefer a secondary account.** Automated traffic can get an account rate-limited or checkpointed.
- The cookie is only ever sent to `instagram.com`, `cdninstagram.com` and `fbcdn.net`.

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PUBLIC_BASE_URL` | *(from Host header)* | Force the absolute URL used in `og:video` tags. Set in production behind a proxy that doesn't forward `X-Forwarded-Proto/Host`. |
| `IG_DOC_ID` | `28000200952919027` | Persisted-query ID for `PolarisPostRootQuery`. Instagram rotates these occasionally — override without redeploying. |
| `CACHE_TTL_MS` | `1800000` (30 min) | In-memory metadata cache TTL |
| `IG_SESSIONID` | *(unset)* | `sessionid` cookie value; unlocks gated reels. Anonymous-only without it. |
| `IG_COOKIE` | *(unset)* | Full `k=v; k=v` cookie string instead of a bare `sessionid`. Takes precedence. |
| `IG_SESSION_STATE_FILE` | *(from `$STATE_DIRECTORY`)* | Where the rotated session is persisted. With neither set, rotations are followed but forgotten on restart. |
| `IG_SESSION_KEEPALIVE_MS` | `3600000` (1 h) | How often to stay eligible for the next rotation. `0` disables it. |
| `IG_KEEPALIVE_URL` | *(built-in list)* | Comma-separated endpoints the keepalive tries, first that answers wins. Override when Instagram moves them — `/healthz` reports which one is in use. |
| `IG_ALERT_WEBHOOK` | *(unset)* | POSTed a `{"content": "..."}` body once when the session is rejected. A Discord webhook works as-is. |
| `IG_LOG_SET_COOKIE` | `1` | Log the *names* (never values) of cookies Instagram sets. `0` to silence. |
| `IG_FETCH_TIMEOUT_MS` | `8000` | Upstream timeout for authenticated calls. |

## Deploying

systemd + nginx + Let's Encrypt on Debian/Ubuntu, running as an unprivileged user behind a TLS reverse proxy. Substitute your own domain for `example.com`. Discord will not render `og:video` over plain HTTP, so TLS is not optional.

### 1. Service user and code

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin igreels
sudo mkdir -p /opt/igreels-embedder
sudo git clone https://github.com/Saulul/igreels_embedder.git /opt/igreels-embedder
sudo chown -R igreels:igreels /opt/igreels-embedder
```

### 2. Secrets

```sh
sudo install -m 600 -o root -g root /dev/null /etc/igreels-embedder.env
printf 'IG_SESSIONID=%s\n' 'PASTE_SESSIONID_HERE' | sudo tee -a /etc/igreels-embedder.env > /dev/null
```

Use `EnvironmentFile=`, not `Environment=`. Unit files are world-readable and `systemctl show -p Environment` prints their values to any local user; a value from `EnvironmentFile=` appears in neither, and the file itself is root-only.

This is a seed — from the first rotation onward the live cookie lives in the state directory, and this file is only re-read if you change it. Skip the step entirely to run anonymous-only.

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
StateDirectory=igreels-embedder
StateDirectoryMode=0700
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

`StateDirectory=` is what lets the rotated session survive a restart: systemd creates `/var/lib/igreels-embedder` owned by the service user and makes it writable *without* punching a hole in `ProtectSystem=strict`, which is why the empty `ReadWritePaths=` can stay. That directory is the only thing the service ever writes. The leading `-` on `EnvironmentFile=` makes that file optional.

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

`proxy_buffering off` matters: without it nginx buffers each MP4 before forwarding, delaying playback and burning disk.

```sh
sudo ln -s /etc/nginx/sites-available/igreels.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d example.com -d www.example.com
```

### 5. Verify

```sh
curl -s https://example.com/healthz
curl -s -A Discordbot https://example.com/reel/DaYHHJvqxWO/ | grep -o 'og:video[^>]*'
curl -s -o /dev/null -D - -r 0-1023 https://example.com/videos/DaYHHJvqxWO.mp4 | head -1
```

Expect `"status": "ok"`, an `og:video` URL on your own domain, and `206 Partial Content` — Discord's media proxy relies on range requests.

`/healthz` returns JSON; add `?pretty=1` when reading it by hand:

```jsonc
{
  "status": "ok",
  "session": {
    "state": "ok",              // absent | unverified | ok | rejected
    "fingerprint": "0296c626",  // a tag for the cookie, not the cookie
    "seededFrom": "state-file", // "env" until the first rotation is stored
    "cookies": ["sessionid", "ds_user_id", "csrftoken", "rur"],
    "rotationsFollowed": 3,
    "persistence": "/var/lib/igreels-embedder/session.json",
    "keepalive": { "everySec": 3600, "lastOk": true, "endpoint": "...", "lastDetail": "@youraccount" }
  },
  "cache":    { "entries": 12, "knownGated": 3, "ttlSec": 1800 },
  "requests": { "pages": 940, "videos": 1204, "resolvedAnon": 902, "resolvedAuth": 38, "failed": 4 }
}
```

Two fields worth watching: `session.state` should reach `ok` within a minute of boot (the keepalive verifies it — `unverified` just means nothing has asked Instagram yet), and `session.persistence` should be a path rather than `disabled` or `failing: ...`.

To confirm the rotation machinery is live, watch the journal for a day or two:

```sh
journalctl -u igreels-embedder -f | grep ig-auth
```

`[ig-auth] set-cookie: ...` shows which cookies Instagram is setting; `[ig-auth] session rotated by Instagram - adopted (...)` is the thing working. Once you've seen one land, `IG_LOG_SET_COOKIE=0` quiets the routine lines.

### 6. Continuous deployment (GitHub Actions)

Pushes to `main` deploy themselves. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) syntax-checks the commit on a runner, then asks the server to move to it over SSH. The rollout itself is [`deploy/igreels-deploy.sh`](deploy/igreels-deploy.sh): fetch, `git reset --hard`, `node --check`, restart, poll `/healthz` — and **roll back to the previous commit if the service doesn't come back healthy**.

The deploy key is pinned to a *forced command*, so it runs that one script and nothing else. A leaked key can redeploy the repo; it does not hand over the box.

```sh
# 1. Install the deploy hook.
curl -fsSL https://raw.githubusercontent.com/Saulul/igreels_embedder/main/deploy/igreels-deploy.sh \
  | install -m 0755 /dev/stdin /usr/local/sbin/igreels-deploy

# 2. Authorise the deploy key, locked to that one command.
cat >> /root/.ssh/authorized_keys <<'KEY'
command="/usr/local/sbin/igreels-deploy",restrict ssh-ed25519 AAAA...  github-actions-deploy
KEY
```

`restrict` turns off pty allocation and forwarding; `command=` overrides whatever the client asks to run, leaving the request only in `SSH_ORIGINAL_COMMAND`, which the script validates as `deploy [<40-hex sha>]` before acting on it.

The first deploy adopts `/opt/igreels-embedder` as a git checkout in place, so a hand-copied tree converts without downtime. Neither `/etc/igreels-embedder.env` nor `/var/lib/igreels-embedder/` is touched, so both the seed and the rotated session survive every deploy.

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | the deploy key's **private** half, `BEGIN`/`END` lines included |
| `DEPLOY_HOST` | the server's IP or hostname |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ssh-ed25519 <host>` output — pins the host key |

### Deploying by hand

```sh
igreels-deploy                       # tip of origin/main
igreels-deploy 218589dfcc2e69094...  # a specific commit (full 40-char sha)
journalctl -u igreels-embedder -f
```

Rolling back is just deploying the previous sha. There is no build step or migration.

## Caveats

- **Datacenter IPs can get rate-limited or blocked.** If reels that clearly exist return `not found or query rejected`, the server IP is likely being challenged. Routing the GraphQL call through a proxy is the usual fix.
- **`IG_DOC_ID` rotation.** Instagram retires query IDs every few months. Get a fresh one from DevTools → Network → filter `graphql` → the `PolarisPostRootQuery` request's `doc_id`, and confirm the `variables` shape hasn't changed.
- **Private accounts** additionally require that the session account follows them.
- **`/healthz` always returns `200`** for load-balancer checks — a rejected session degrades gated reels but doesn't make the service unhealthy, and the deploy hook rolls back on a non-200. Read `session.state` to tell the difference.
- **Rotations are only followed while the service is running.** A box that is off for a long stretch can come back holding a cookie Instagram has moved past, which needs a manual re-seed.

## Endpoints

| Path | Behavior |
|---|---|
| `/reel/{code}`, `/reels/{code}`, `/p/{code}`, `/tv/{code}`, `/{user}/reel/{code}` | Bot UA → OG embed page; human UA → 302 to Instagram |
| `/videos/{code}.mp4` | Streams the reel MP4 (Range supported) |
| `/oembed?shortcode={code}` | oEmbed JSON (Discord author line) |
| `/` | Landing page |
| `/healthz` | Health check (always `200`); JSON body reports session, rotation, cache and request state. `?pretty=1` to indent |
