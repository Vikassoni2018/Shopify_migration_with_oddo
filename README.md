# Shopify Migration with Odoo

This project is now configured to run in two modes without hand-editing the code:

- Local mode: reads settings from a root `.env` file.
- Render mode: uses `render.yaml` plus Render environment variables.

The app serves the HTML frontend and the Node API from the same service, so file upload, CSV conversion, order import, and product sync work the same way locally and on Render.

## Local setup

1. Copy `.env.example` to `.env`.
2. Adjust any local values you need, especially `PORT`, `DEFAULT_API_BASE_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
3. Run:

```bash
npm install
npm start
```

4. Open `http://127.0.0.1:3456` or use `Open_Odoo_CSV_Converter.bat`.

## Render deployment

This repo includes a `render.yaml` Blueprint with:

- Node 20
- `npm install` build step
- `npm start` start step
- `/api/health` health check
- production base URL set to `https://shopify-migration-with-oddo.onrender.com`

After you connect the repo in Render, the service can boot directly from Git. Add any secret values in the Render dashboard:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

## Runtime config

The server injects runtime config into each HTML page through `/app-config.js`, so the frontend automatically picks the correct API base:

- Local default: `http://127.0.0.1:3456`
- Render default: `https://shopify-migration-with-oddo.onrender.com`

The default import timezone is controlled by `DEFAULT_TIMEZONE_OFFSET`.

## Admin panel

`/admin` now uses server-side login instead of hardcoded browser credentials and no longer stores Stripe secrets in localStorage.

It is intentionally read-only for secrets:

- Local: edit `.env`
- Render: edit environment variables in the Render dashboard

## Health and API endpoints

- `GET /api/health`
- `GET /api/config`
- `POST /api/connect`
- `POST /api/import/start`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/results.csv`
- `POST /api/products/sync`
- `POST /api/woocommerce/shopify-sync-products`
- `POST /api/payments/quote`
- `POST /api/payments/webhook`

## Stripe webhook note

If `STRIPE_WEBHOOK_SECRET` is set, `/api/payments/webhook` verifies the `Stripe-Signature` header against the raw request body before accepting the event.
