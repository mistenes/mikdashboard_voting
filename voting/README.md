# MikDashboard Voting UI

## Run Locally

**Prerequisites:**  Node.js 18+

1. Install dependencies:
   `npm install`
2. Start the in-memory API server (tab 1):
   `npm run api`
3. Launch the Vite dev server (tab 2):
   `npm run dev`

The dev server proxies `/api` requests to the local API server, so keep both processes running during development.

## Deploy on Render

The root [`render.yaml`](../render.yaml) blueprint provisions a dedicated Node
web service (`mikdashboard-voting`) for this app on the Starter plan in the
Frankfurt region. Render automatically runs `npm install && npm run build` and
starts the service with `npm run start`, which serves the static bundle and the
real-time voting API from the same Express server.
