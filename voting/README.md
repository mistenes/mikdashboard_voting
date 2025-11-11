<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1eMSyqrmWa8Ynn1MwM-_8KK029KI3FcoF

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
 `npm run dev`

## Deploy on Render

The root [`render.yaml`](../render.yaml) blueprint provisions a dedicated Node
web service (`mikdashboard-voting`) for this app on the Starter plan in the
Frankfurt region. Render automatically runs `npm install && npm run build` and
starts the service with `npm run preview -- --host 0.0.0.0 --port $PORT`.
