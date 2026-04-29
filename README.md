# Shopify_migration_with_oddo

This project contains a small Node.js web app for converting Odoo CSV data for Shopify/Matrixify and syncing orders.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3456`.

## Deploy to Render

This repo is now configured for Render using `render.yaml`.

### Option A: Blueprint (recommended)
1. Push this repository to GitHub.
2. In Render, click **New +** → **Blueprint**.
3. Select this repository.
4. Render will detect `render.yaml` and create the web service.
5. After deploy finishes, open your Render URL to view the app live.

### Option B: Manual Web Service
1. In Render, create a **Web Service** from this repo.
2. Use:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Runtime**: Node
3. Deploy and open the generated Render URL.

## Notes
- The server listens on `process.env.PORT` (Render sets this automatically).
- Host binding is `0.0.0.0`, required for Render.
