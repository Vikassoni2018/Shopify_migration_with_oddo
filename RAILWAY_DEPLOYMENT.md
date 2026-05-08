# Railway Deployment

This app can run on Railway from the `backgroundjob` branch.

## What Railway Runs

- Builder: Nixpacks
- Start command: `npm start`
- Health check: `/healthz`
- Node: `22.x` from `package.json`

The server binds to `0.0.0.0` automatically when Railway environment variables are present.

## Required Variables

Set these in Railway service variables:

- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`
- `ORDER_CREATE_SPACING_MS` = `13000`
- `SHOPIFY_THROTTLE_RETRY_WAIT_MS` = `65000`
- `SHOPIFY_THROTTLE_MAX_ATTEMPTS` = `8`

## Persistent Storage

Attach a Railway Volume if you want saved imports and job progress to survive restarts.

The app automatically uses Railway's `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached. You can also set `DATA_DIR` manually to a mounted path.

Saved data is written under:

- `import-plans/`
- `jobs/`
- `connection.json`
- `logs/`

Without a Railway Volume, background imports can still run, but saved plans and resume files may be lost when the container restarts.

## Resume Behavior

If Railway restarts while a batch is running, reopen the app and click `Resume Batch`. The app reads saved job files, skips processed orders, and continues from the next unprocessed order.
