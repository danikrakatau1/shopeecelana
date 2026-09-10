# AR STORE Seller Dashboard — Auth + Shopee Connection

This repository keeps seller credentials and Shopee Partner credentials on the Cloudflare Worker only. Do not commit passwords, Partner Key, access tokens, or refresh tokens to GitHub.

## Required Cloudflare Worker secrets

Set these in the Worker that deploys `shopeecelana`:

- `SELLER_PASSWORD` — password used by the private Seller Dashboard login.
- `SESSION_SECRET` — long random secret used to sign seller sessions and encrypt the temporary Shopee token vault.
- `SHOPEE_PARTNER_ID` — Partner ID from Shopee Open Platform Console.
- `SHOPEE_PARTNER_KEY` — Partner Key from Shopee Open Platform Console.

Optional:

- `SELLER_USERNAME` — defaults to `owner` when omitted.
- `SHOPEE_REDIRECT_URL` — defaults to `https://<current-host>/shopee/callback`.
- `SHOPEE_API_BASE` — defaults to `https://partner.shopeemobile.com`.

## Shopee Console callback

Set the app redirect/callback URL to:

`https://shopeecelana.celanaarstore.workers.dev/shopee/callback`

If a custom domain is introduced later, update both Shopee Open Platform Console and `SHOPEE_REDIRECT_URL` together.

## Flow

1. Visit `/seller-login/` and authenticate as the seller owner.
2. `/dashboard/` is protected by the Worker and is never served without a valid signed session cookie.
3. Open `Shopee Connection` in the dashboard.
4. `Connect Shopee` asks the Worker to generate the signed Shopee authorization URL.
5. Shopee returns to `/shopee/callback` with an authorization code and Shop ID.
6. The Worker exchanges that code for Shopee tokens server-side.
7. For this V2 foundation, the token payload is AES-GCM encrypted and stored in an HttpOnly cookie for the single-owner dashboard.
8. Use `Test Shop Info` to verify that the connected token can read shop information.

## Current security boundaries

- Seller password is compared only inside the Worker.
- Seller session cookie: HttpOnly, Secure, SameSite=Lax, 12-hour expiry.
- Shopee Partner Key never reaches dashboard JavaScript.
- Shopee authorization signatures are created in the Worker.
- Dashboard assets are served with `Cache-Control: no-store` and private security headers.
- No browser `localStorage` is used for passwords or Shopee credentials.

## Next production hardening

Before adding heavy order/product synchronization, move Shopee access/refresh tokens from the encrypted single-owner cookie vault to a server-side Cloudflare KV/D1/Durable Object token store. Add rate limiting or Turnstile to the seller login endpoint, automatic refresh-token rotation, webhook verification, audit logs, and explicit API permission checks.
