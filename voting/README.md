# MikDashboard Voting UI

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Update the Firebase configuration in [`index.tsx`](index.tsx) with your project values.
3. Run the app:
   `npm run dev`

## Deploy on Render

The root [`render.yaml`](../render.yaml) blueprint provisions a dedicated Node
web service (`mikdashboard-voting`) for this app on the Starter plan in the
Frankfurt region. Render automatically runs `npm install && npm run build` and
starts the service with `npm run preview -- --host 0.0.0.0 --port $PORT`.
