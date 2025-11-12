# MikDashboard Voting Monorepo

This repository contains two deployable apps:

- **dashboard/** – FastAPI-based administration and registration portal backed by a PostgreSQL database.
- **voting/** – React front-end used by participants during live voting sessions.

## Deploying on Render

Use the root [`render.yaml`](render.yaml) blueprint to provision everything in a single step. The
blueprint creates:

- `mikdashboard-dashboard` – Python web service (Starter plan, Frankfurt region) serving the admin dashboard.
- `mikdashboard-voting` – Node web service (Starter plan, Frankfurt region) serving the voting UI and API via `npm run start`.
- `mikdashboard-db` – Managed PostgreSQL instance (Free plan, Frankfurt region) shared by both apps.

After connecting the repository to Render and applying the blueprint, deployments run with the
following commands:

- Dashboard build: `pip install -r requirements.txt`
- Dashboard start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Voting build: `npm install && npm run build`
- Voting start: `npm run start`

Update the environment variables in the blueprint before the first deploy:

- Set unique `ADMIN_EMAIL`/`ADMIN_PASSWORD` pairs for both services (the default username is
  always `admin`). The dashboard forces a password change on first login.
- Point the voting service `DASHBOARD_API_BASE_URL` at the publicly reachable dashboard base
  URL (including the `https://` scheme). The blueprint now references the live dashboard at
  `https://dashboard.mikegyesulet.hu/`. The voting API signs login checks with the shared
  `VOTING_O2AUTH_SECRET` and first calls the dashboard’s `/api/voting/authenticate` endpoint before
  falling back to `/api/login`, so both apps accept the exact same credentials.
- Provide `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and `PUBLIC_BASE_URL` so the registration
  service can deliver verification emails through Brevo. The blueprint defaults to the
  production dashboard domain `https://dashboard.mikegyesulet.hu/`, so update the value if
  you deploy elsewhere.
- Optionally configure Google reCAPTCHA keys if you want captcha protection on sign-up forms.

The dashboard now exposes a dedicated **Szavazási események** admin page where you can create
named voting events, choose the active session, and assign exactly one delegate per
organization. Only the active-event delegate (or a system administrator) is allowed to launch
the separate voting service through the signed o2auth flow. The launch endpoint accepts an
optional `view` value so admins can jump directly to the voting admin console (`/admin`),
while any paid member can open the public scoreboard via `/public` without needing to be the
delegated voter.

## Local development

Each app keeps its local setup instructions in its respective folder (`dashboard/README.md` and
`voting/README.md`).
