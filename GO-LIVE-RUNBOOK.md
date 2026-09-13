# AR STORE — Shopee Go-Live Runbook

Status: PRE-GO-LIVE FREEZE

This runbook is the controlled path from the current sandbox-tested AR STORE dashboard to a real Shopee seller connection. It is intentionally written so the current sandbox/runtime stays untouched until every manual production gate is confirmed.

## Non-negotiable rules

- Do not paste `SHOPEE_PARTNER_KEY`, `SESSION_SECRET`, `SELLER_PASSWORD`, access tokens, or refresh tokens into chat, issues, commits, logs, screenshots, or source files.
- Do not use Shopee API Test Tool → Get Access Token while the dashboard owns the seller authorization flow. That can replace/invalidate the token pair used by the dashboard.
- Do not change production credentials merely because CI is green. CI proves code/config structure, not Shopee application approval.
- Keep the homepage/dashboard freeze intact. Only critical fixes or the controlled credential/environment cutover are allowed before Go-Live validation completes.
- Preserve `SESSION_SECRET` during credential cutover unless a deliberate seller-session/token reset is intended.

## Gate 0 — Current frozen baseline

Required before any cutover:

- `wrangler.jsonc` main remains `./src/worker-v3-20.js`.
- `keep_vars` remains enabled.
- Production Readiness Audit remains green.
- Homepage Cross-Device QA remains green.
- No real Shopee credentials are committed to the repository.

## Gate 1 — Shopee application approval

Manual gate. Do not continue until the Shopee Open Platform application is approved/eligible for live seller authorization and the production Partner ID + Partner Key are available in the Shopee console.

Record only non-secret confirmation in the deployment notes:

- App live/production access: confirmed
- Production Partner ID: available
- Production Partner Key: available (never copy the value into this repository)
- Required API permissions/scopes: approved
- Redirect/callback URL: approved for the deployed AR STORE Worker origin

If any item is not confirmed, stay on sandbox.

## Gate 2 — Confirm endpoint/environment configuration

Current code resolves the Shopee API base from `SHOPEE_API_BASE`, with a fallback inside `src/worker-v3.js`.

Before cutover, confirm the exact live API base and authorization requirements from the current Shopee Open Platform console/documentation. Do not guess the production or sandbox hostname.

Only after confirmation:

- Set/update `SHOPEE_API_BASE` in Cloudflare if the live environment requires a value different from the current fallback.
- Set the production `SHOPEE_PARTNER_ID` as a Cloudflare environment variable.
- Set the production `SHOPEE_PARTNER_KEY` using Cloudflare secret management.
- Keep `SESSION_SECRET` and `SELLER_PASSWORD` secret values protected and unchanged unless rotation is intentional.
- Set `SHOPEE_REDIRECT_URL` only if an explicit callback override is required; otherwise the Worker derives `/shopee/callback` from its own origin.

No secret values belong in GitHub.

## Gate 3 — Controlled credential cutover

Perform the Cloudflare changes together in one maintenance window.

Recommended order:

1. Confirm rollback values/previous environment configuration are available privately in Cloudflare/Shopee consoles.
2. Update `SHOPEE_API_BASE` only if required by the verified live environment.
3. Update production `SHOPEE_PARTNER_ID`.
4. Replace `SHOPEE_PARTNER_KEY` through Cloudflare secrets.
5. Do not rotate `SESSION_SECRET` at the same time.
6. Wait for the Worker configuration/deployment to settle.
7. Log in to the private seller dashboard normally.
8. Use Dashboard → Shopee Connection to authorize the real seller account.

Never reuse a sandbox token/cookie as proof of a live connection.

## Gate 4 — Live seller validation

After real seller authorization, validate in this order so failures are easy to isolate:

1. Shopee Connection / status
2. Token health and refresh path
3. Shop information
4. Products / variants
5. Orders
6. Stock & Pricing
7. Logistics
8. Finance / settlement reconciliation
9. Shopee Ads
10. Profit Intelligence using real mapped products/HPP
11. Settings connection metadata

For every panel verify:

- Data belongs to the expected real shop.
- No sandbox shop/account identifiers remain.
- No dummy/demo values appear.
- API failures show truthful error/empty states instead of stale fabricated data.
- Refreshing the browser preserves the expected authenticated state.

## Gate 5 — Real-money sanity checks

Before trusting operational numbers:

- Compare at least one real order against Shopee Seller Centre.
- Compare finance/settlement components against the same order in Shopee.
- Verify buyer-paid totals are not mislabeled as seller revenue.
- Verify ad spend/ROAS against the matching Shopee Ads date range.
- Enter/confirm real HPP locally before using estimated profit for decisions.
- Remember settlement-factor estimates can change from the sandbox baseline and must be recalibrated with real orders.

## Gate 6 — Failure and rollback plan

Rollback immediately if live authorization or critical endpoints fail after the credential cutover.

Rollback sequence:

1. Stop further credential changes.
2. Preserve the current code commit; do not mix an emergency credential rollback with unrelated UI/code edits.
3. Restore the previous known-good Cloudflare environment configuration privately.
4. If needed, clear/reconnect Shopee authorization through the dashboard flow rather than API Test Tool token generation.
5. Re-run token health/status.
6. Confirm the private dashboard is stable before any second live attempt.

If `SESSION_SECRET` was accidentally rotated, existing encrypted Shopee/session cookies will no longer decrypt. Treat that as an intentional re-authentication event and reconnect cleanly.

## Gate 7 — Go-Live acceptance

Mark `GO-LIVE = PASS` only when all of the following are true:

- Shopee application live access confirmed.
- Production credentials configured privately in Cloudflare.
- Real seller authorization completed through the dashboard.
- Token health passes and refresh is proven.
- Products, orders, logistics, finance, ads, and settings show correct real-shop data.
- At least one real order/settlement cross-check matches Seller Centre.
- No sandbox/demo identifiers or fabricated metrics remain.
- Production Readiness Audit remains green.
- Homepage Cross-Device QA remains green.

Until then the correct status is `PRE-GO-LIVE FREEZE`.
