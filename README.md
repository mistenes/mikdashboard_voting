# MikDashboard Voting Monorepo

This repository contains two deployable apps:

- **dashboard/** – FastAPI-based administration and registration portal backed by a PostgreSQL database.
- **voting/** – React front-end used by participants during live voting sessions.

## Deploying on Render

Use the root [`render.yaml`](render.yaml) blueprint to provision everything in a single step. The
blueprint creates:

- `mikdashboard-dashboard` – Python web service (Starter plan, Frankfurt region) serving the admin dashboard.
- `mikdashboard-voting` – Node web service (Starter plan, Frankfurt region) serving the voting UI via `npm run preview`.
- `mikdashboard-db` – Managed PostgreSQL instance (Free plan, Frankfurt region) shared by both apps.

After connecting the repository to Render and applying the blueprint, deployments run with the
following commands:

- Dashboard build: `pip install -r requirements.txt`
- Dashboard start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Voting build: `npm install && npm run build`
- Voting start: `npm run preview -- --host 0.0.0.0 --port $PORT`

Customize the admin credentials and optional Google reCAPTCHA keys by editing the environment
variables under the dashboard service definition in the blueprint.

## Local development

Each app keeps its local setup instructions in its respective folder (`dashboard/README.md` and
`voting/README.md`).
