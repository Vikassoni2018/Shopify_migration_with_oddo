# Render Background Import Deployment

This branch is configured for Render with `render.yaml`.

## What Render Runs

- Service type: Web Service
- Branch: `backgroundjob`
- Start command: `npm start`
- Health check: `/healthz`
- Persistent disk: `/var/data`

The app starts Shopify imports on the server. After an import starts, closing the browser does not stop the running job. Render keeps the Node process alive and the importer continues to pace Shopify requests.

## Required Render Environment Variables

Set these in Render before starting a real import:

- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`

You can still enter the shop domain and token in the UI, but Render environment variables are safer for long-running imports.

## Important Limit

Render keeps the job running while the service is alive. If Render redeploys or restarts the service during an import, the current in-memory job can stop. For fully resumable imports across restarts, add a database queue such as Render Postgres or Supabase and persist every order's status.

## Recommended Import Flow

1. Deploy this `backgroundjob` branch on Render.
2. Open the Render app URL.
3. Upload the Odoo order CSV.
4. Click `Preview and Prepare`.
5. Use the 1,000-order batch list to import one batch at a time.

The current safe pacing estimate is about 3h 36m per 1,000 orders.
