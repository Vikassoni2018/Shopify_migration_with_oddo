# Render Background Import Deployment

This branch is configured for Render with `render.yaml`.

## What Render Runs

- Service type: Web Service
- Branch: `backgroundjob`
- Start command: `npm start`
- Health check: `/healthz`
- Persistent disk: `/var/data`

The app starts Shopify imports on the server. After an import starts, closing the browser does not stop the running job. Render keeps the Node process alive and the importer continues to pace Shopify requests.

Uploaded order CSVs are saved under Render's persistent disk in `/var/data/import-plans`. Each batch job is saved under `/var/data/jobs` after every order result, so the page can be reopened later to show completed, failed, and pending batch progress.

## Required Render Environment Variables

Set these in Render before starting a real import:

- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`

You can still enter the shop domain and token in the UI, but Render environment variables are safer for long-running imports.

## Resume Behavior

If Render redeploys or restarts while a job is running, reopen the Render app, open `Saved Render imports`, and click the batch again. The app loads the saved CSV and job result file from disk, skips orders already recorded as processed, and resumes from the next unprocessed order in that batch.

This is file-backed persistence, not a database queue. It is enough for one Render instance processing these imports, but avoid running the same batch from multiple browser windows at the same time.

## Recommended Import Flow

1. Deploy this `backgroundjob` branch on Render.
2. Open the Render app URL.
3. Upload the Odoo order CSV.
4. Click `Preview and Prepare`.
5. The CSV is saved on Render disk and shown in `Saved Render imports`.
6. Click `Import All Batches` or start the first batch. Render imports one 1,000-order batch at a time and automatically starts the next batch after each batch completes.
7. If the browser closes or the service restarts, reopen the app and click `Open Batches` for the saved CSV.

The current safe pacing estimate is about 3h 36m per 1,000 orders.
