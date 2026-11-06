# Cloudflare Deploy

[中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iola1999/uurc-web)

This deployment mode uses a Cloudflare Worker plus a Durable Object. It does not depend on Cloudflare Containers.

## What Runs On Cloudflare

- Static frontend from `frontend/dist`
- `/api/proxy/uu` UU API forwarding
- `/api/health`
- Durable Object-backed `/api/remote/signal/*` status, event, diagnostics, and error-reporting endpoints

The live signal gateway is implemented in the Worker Durable Object. It uses an upstream Engine.IO/Socket.IO WebSocket opened with Worker `fetch(..., Upgrade: websocket)`.

## Requirements

- Cloudflare Workers account with Durable Objects enabled.
- Deploy/build token with `Workers Scripts Edit`.

## Deploy

```bash
npx wrangler login
npm run deploy:cloudflare
```

For local Cloudflare runtime preview:

```bash
npm run dev:cloudflare
```

## Required: console passphrase

`/api/remote/*` and `/api/proxy/uu` are now gated by the Worker itself instead of Cloudflare
Access, so you **must** set a passphrase after deploying — otherwise those endpoints answer 503:

```bash
npx wrangler secret put OWNER_PASSPHRASE
```

Minimum 8 characters. You can also add it in the Cloudflare dashboard under
Workers → `uurc-web` → Settings → Variables and secrets.

Optionally set `SESSION_SECRET` to sign the session cookie with a dedicated key; without it the
passphrase itself is used. Sessions are HttpOnly signed cookies valid for 14 days, and rotating
the passphrase invalidates them immediately.

Share links (`/share/<id>`, `/api/share/*`) do not require this passphrase — guests use their own
view password.

## Notes

- Configuration lives in `wrangler.jsonc`.
- The deploy flow runs `npm run build:cloudflare`, which builds `shared` and `frontend`.
