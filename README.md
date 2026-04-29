# Shopify_migration_with_oddo

## Stripe-gated migration flow

The API now supports a Stripe-driven paid migration entitlement model:

- Free tier: first `10` orders can be imported with no payment.
- Paid tier A: `$10 / 1,000 orders` (tracked as paid quota).
- Paid tier B: `$100` full migration unlock.

### Endpoints

- `POST /api/payments/quote`
  - Input: `{ "totalOrders": number }`
  - Returns free/paid breakdown and per-1,000 quote.

- `POST /api/payments/webhook`
  - Accepts Stripe-style webhook payloads for:
    - `checkout.session.completed`
    - `payment_intent.succeeded`
  - Uses event metadata:
    - `shopDomain`
    - `plan` (`per_1000` or `full`)
  - Grants entitlement and logs transaction IDs.

- `POST /api/import/start`
  - Requires `selectedPlan` when total orders exceed the free limit (`per_1000` or `full`).
  - Enforces paid quota or full-migration unlock before running import.

### Security notes

- Card data collection must occur in Stripe Checkout or Stripe Elements only.
- Payment confirmation must be validated server-side via webhooks.
