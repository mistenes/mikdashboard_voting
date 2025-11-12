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

Set the `VOTING_O2AUTH_SECRET` environment variable before starting `npm run api`
so the Express server can validate the dashboard által generált o2auth tokeneket.
Fejlesztéshez add meg az `ADMIN_PASSWORD` (és opcionálisan az `ADMIN_EMAIL` vagy
`ADMIN_USERNAME`) változókat is; manuális bejelentkezés csak az admin számára
engedélyezett, minden más felhasználó az o2auth átadáson keresztül éri el a rendszert.

### Views

- `/` – a szavazói felület, ahol a delegált leadhatja a szavazatát, az admin pedig
  indíthatja vagy zárhatja a folyamatot.
- `/public` – nyilvános, csak olvasható eredménykijelző, amely bejelentkezés nélkül
  is követi a valós idejű állást.
- `/admin` – az admin vezérlőfelület. Ide csak rendszerszintű adminok férnek hozzá;
  a dashboardból induló o2auth kérésben a `view="admin"` érték kérhető, hogy a
  token közvetlenül ezt a nézetet nyissa meg.

## Deploy on Render

The root [`render.yaml`](../render.yaml) blueprint provisions a dedicated Node
web service (`mikdashboard-voting`) for this app on the Starter plan in the
Frankfurt region. Render automatically runs `npm install && npm run build` and
starts the service with `npm run start`, which serves the static bundle and the
real-time voting API from the same Express server.

### Required environment variables

- `VOTING_O2AUTH_SECRET`: Meg kell egyeznie a dashboard szolgáltatásban használt
  titkos kulccsal, így a szavazási app ellenőrizni tudja a tokeneket.
- `VOTING_O2AUTH_TTL_SECONDS`: A dashboard által jelzett token lejárati idő másodpercben.
- `VOTING_SESSION_TTL_SECONDS`: Mennyi ideig marad érvényes egy bejelentkezett
  session (alapértelmezés szerint 3600 másodperc).
- `DASHBOARD_API_BASE_URL`: A dashboard szolgáltatás publikus, `https://`-sel
  kezdődő alap URL-je. A szavazási szolgáltatás a megosztott
  `VOTING_O2AUTH_SECRET` segítségével aláírt kérést küld a
  `/api/voting/authenticate` végpontra, majd szükség esetén visszavált a
  nyilvános `/api/login` hívásra, így ugyanazokat az e-mail/jelszó párokat
  fogadja el, mint a dashboard.
- `ADMIN_PASSWORD`: Az adminisztrátori bejelentkezéshez használt jelszó. A
  felhasználónév alapértelmezetten `admin`, de az `ADMIN_USERNAME` változóval
  felülírható. Az `ADMIN_EMAIL` megadásával az admin munkamenet metaadataiban
  is látszódni fog a cím. Ez csak tartalék, ha a dashboard API nem érhető el.
