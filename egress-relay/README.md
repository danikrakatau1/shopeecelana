# AR STORE — Shopee Static Egress Relay V1

This small service gives AR STORE a stable outbound IPv4 path for Shopee API allowlisting without running a VPS.

## Architecture

Cloudflare Worker -> signed HTTPS request -> Railway relay -> Shopee Open Platform

The relay never stores the Shopee Partner Key. It only forwards already-signed Shopee requests from the AR STORE Worker.

## Railway setup

1. Create a Railway project from this GitHub repository.
2. Set the service root directory to `egress-relay`.
3. Use Node 22+ and deploy.
4. Add a Railway secret named `EGRESS_SHARED_SECRET` with a strong random value.
5. On Railway Pro, open the service Settings -> Networking and enable Static Outbound IPs.
6. Redeploy after enabling the static IP feature.
7. Copy every static outbound IPv4 shown by Railway. Shopee's APP IP Address Management accepts one IP per line.

Do not change the Railway region after the IPs are submitted to Shopee, because the assigned outbound IPs are region-specific.

## Optional hostname restriction

By default the relay only permits HTTPS targets on `shopeemobile.com` and its subdomains.

For a stricter allowlist, add:

`ALLOWED_SHOPEE_HOSTS=partner.shopeemobile.com`

Multiple hosts can be comma-separated if Shopee requires more than one official API hostname.

## Health check

`GET /health`

The endpoint only reports whether the relay secret exists. It never exposes the secret.

## Security model

- Requests to `/v1/forward` require HMAC-SHA256 authentication.
- Requests older than 90 seconds are rejected.
- Only GET and POST are allowed.
- Only HTTPS Shopee mobile hosts are allowed.
- Authorization and cookie headers are never forwarded.
- Request size is capped at 1 MB.
- Upstream requests time out after 20 seconds.
- The relay does not log Shopee target URLs or credentials.

## Cloudflare variables used later

After the Railway service and static outbound IPs are confirmed, wire the AR STORE Worker with:

- `SHOPEE_EGRESS_RELAY_URL` — normal environment variable, e.g. the Railway service URL ending in `/v1/forward`.
- `SHOPEE_EGRESS_SHARED_SECRET` — Cloudflare Secret. It must match Railway's `EGRESS_SHARED_SECRET`.

Do not place either secret value in GitHub.

## Cutover rule

Do not route production Shopee API traffic through the relay until:

1. Railway static outbound IPs are enabled and known.
2. Those IPs are entered into Shopee APP IP Address Management.
3. Relay health is confirmed.
4. The Worker-side relay integration passes sandbox regression tests.
