# MIK Dashboard Registration Prototype

This prototype implements a simple registration flow with organization lookup,
email verification, and administrator approval gates. It provides a FastAPI
backend and a lightweight vanilla JavaScript UI for demonstration. A minimal
Hungarian-language interface covers bejelentkezés (login), regisztráció, and a
separate adminisztrációs felület.

## Features

- Searchable organization directory surfaced on the registration form.
- User registration API that stores a verification token and delivers the confirmation e-mail
  through Brevo once the message sender is configured.
- Email verification endpoint that flags the account as verified while waiting
  on administrator approval.
- Admin review API with dedicated `/admin`, `/admin/szervezetek`, and `/admin/jelentkezok`
  felületek, amelyek külön oldalakon kezelik az áttekintést, a szervezeteket és a függő
  regisztrációkat.
- Admin áttekintő, amely listázza a szervezeteket, megmutatja a tagokat, engedi a tagsági
  díj státuszának módosítását, a banki adatok frissítését és lehetővé teszi a tagok törlését.
- Admin felületről új szervezet hozható létre, a törlés pedig három egymást követő
  megerősítést igényel, mielőtt véglegesen eltávolítaná az adatbázisból.
- Login endpoint that enforces e-mail verification and admin approval before granting
  hozzáférést, majd automatikusan a szervezethez kötött oldalra irányítja a felhasználót:
  ha a tagsági díj rendezetlen, az egyedi díjfizetési oldal (`/szervezetek/<id>/dij`) jelenik
  meg, rendezett díj esetén pedig a tagi felület (`/szervezetek/<id>/tagok`) nyílik meg.
- Adminisztrátorok a taglistán külön jelölhetik ki a „szavazó delegáltakat”, akik
  rendezett tagsági díj mellett egy kattintással átirányíthatók a különálló szavazási
  webalkalmazásba egy aláírt o2auth tokennel.
- Kötelező keresztnév és vezetéknév megadása, amely az admin felületen is látható.
- Jelszó-erősségi ellenőrzés (legalább 8 karakter, nagybetű és speciális karakter) és Google
  reCAPTCHA védelem a regisztrációs űrlapon.
- A seedelt adminisztrátor első bejelentkezéskor kötelezően új jelszót állít be a webes
  jelszócsere felületen, mielőtt bármely funkciót használhatna.

## Getting started

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open `http://localhost:8000` to reach the Hungarian login page. Registration lives at
`http://localhost:8000/register`. Adminisztrátorok a jóváhagyott belépés után az
`/admin` áttekintőre jutnak, ahonnan a szervezet-kezelés (`/admin/szervezetek`) és a függő
kérelmek (`/admin/jelentkezok`) külön oldalon érhetők el. Minden más felhasználó a
tagsági díj státusza alapján kerül átirányításra a saját szervezetének oldalára:
- rendezetlen díj esetén: `http://localhost:8000/szervezetek/<id>/dij`, ahol a banki adatok
  és az utalási instrukciók jelennek meg;
- rendezett díj esetén: `http://localhost:8000/szervezetek/<id>/tagok`, amelyből a szavazási
  (`.../szavazas`) és pénzügyi (`.../penzugyek`) aloldalak érhetők el.

Successful logins always verify e-mail and admin approval first. Admin jóváhagyáskor a rendszer
automatikusan megerősítettnek tekinti az e-mail címet, így nincs szükség külön megerősítő linkre
a belépéshez.

Designate administrator accounts with the `ADMIN_EMAILS` environment variable — provide a
comma-separated list of e-mail addresses. Those users will auto-approve once they verify
their e-mail and gain access to the admin tools after signing in. Optional
`USER_REDIRECT_PATH` (alapértelmezetten `/`) and `ADMIN_REDIRECT_PATH` variables let you customize
the post-login destinations.

To guarantee at least one adminisztrátor, set `ADMIN_EMAIL` és `ADMIN_PASSWORD`. The
application will create or frissít the matching felhasználó on startup, jelölve verified
és approved státusszal. You can optionally set `ADMIN_FIRST_NAME` és `ADMIN_LAST_NAME` to
control the megjelenített név. A seeded admin nem kap külön szervezetet, de továbbra is
látja és kezelheti az összes szervezetet az admin felületen.

## Deploying to Render

The service can be deployed to [Render](https://render.com/) using either the
provided blueprint or the manual setup steps below.

### Option A: Deploy with the Render blueprint

1. Make sure the repository is available in your Git provider (GitHub, GitLab,
   or Bitbucket).
2. From the Render dashboard, choose **New ➝ Blueprint** and select this
   repository. Render will detect the root-level `render.yaml` file.
3. Accept the defaults or adjust the service/database names as desired, then
   click **Apply** to provision the PostgreSQL database, the dashboard web
   service, and the separate voting web service.
4. Render currently defaults Python services to version 3.13, which is
   incompatible with Pydantic 1.x on this project. The blueprint pins the
   `PYTHON_VERSION` environment variable to `3.11.9` so the app runs on a
   supported interpreter.
5. Deployments will automatically build using `pip install -r requirements.txt`
   and start the FastAPI server with `uvicorn app.main:app --host 0.0.0.0 --port
   $PORT`. The blueprint also wires the `DATABASE_URL` environment variable to
   the managed database and surfaces placeholders for `ADMIN_EMAILS`, `ADMIN_EMAIL`,
   `ADMIN_PASSWORD`, `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME`, `PUBLIC_BASE_URL`,
   `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `RECAPTCHA_SITE_KEY`,
   `RECAPTCHA_SECRET_KEY`, `VOTING_O2AUTH_SECRET`, `VOTING_APP_BASE_URL`,
   `VOTING_O2AUTH_TTL_SECONDS`, and `VOTING_AUTH_TTL_SECONDS` so you can
   pre-authorize administrator accounts,
   label the seeded admin, configure outbound e-mail delivery, enable the Google
   reCAPTCHA integration, és beállíthatod a szavazási webalkalmazás felé használt
   o2auth titkot és átirányítási URL-t.
   Alapértelmezetten a blueprint a `https://dashboard.mikegyesulet.hu/` és
   `https://voting.mikegyesulet.hu/` domainekre mutat, ezért más környezetben
   frissítsd ezeket az értékeket.

### Option B: Manual setup via the Render dashboard

1. Create a new PostgreSQL instance in Render. After it provisions, copy the
   `External Database URL`.
2. Create a new **Web Service** from this repository. Use the following
   settings:
   - **Environment**: `Python`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
3. Add the environment variable `PYTHON_VERSION` with the value `3.11.9` to pin
   the service to a Python release compatible with the current dependencies.
4. Add the environment variable `DATABASE_URL` with the value copied from the
   database instance. The app automatically converts Render's `postgres://`
   URL to the driver string SQLAlchemy expects.
5. Set `ADMIN_EMAILS` to a comma-separated list of addresses that should receive
   administrator privileges after verifying their e-mail. Those users can then
   log in and load the `/admin` panel without a separate token.
6. (Optional) Provide `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_FIRST_NAME`, and
   `ADMIN_LAST_NAME` to seed or refresh a dedicated adminisztrátor account
   automatically.
7. Állítsd be a `PUBLIC_BASE_URL` értékét a dashboard publikus URL-jére, majd
   add meg a Brevo küldő adatait (`BREVO_API_KEY`, `BREVO_SENDER_EMAIL`,
   `BREVO_SENDER_NAME`), hogy a regisztrációs visszaigazoló e-mailek ténylegesen
   kiküldésre kerüljenek. A blueprint a `https://dashboard.mikegyesulet.hu/`
   értékkel indul ki, amit szükség esetén cserélj le a saját környezetedre.
8. (Optional) Configure Google reCAPTCHA by setting `RECAPTCHA_SITE_KEY` and
   `RECAPTCHA_SECRET_KEY`. When omitted, the regisztrációs űrlap captcha
   automatikusan letiltva marad.
9. Állítsd be a `VOTING_O2AUTH_SECRET`, `VOTING_APP_BASE_URL`, `VOTING_O2AUTH_TTL_SECONDS`
   (és opcionálisan a `VOTING_AUTH_TTL_SECONDS`) változókat ugyanazzal az
   értékkel, amit a szavazási webszolgáltatásnál használsz. Ezek biztosítják,
   hogy a tagi felület által generált o2auth tokeneket a voting alkalmazás
   érvényesnek fogadja el, és hogy az új `/api/voting/authenticate` végpont
   kizárólag a megosztott titokkal aláírt hitelesítési kéréseket fogadja el.
   A blueprint a `VOTING_APP_BASE_URL` értékét `https://voting.mikegyesulet.hu/`
   címre állítja, ezért más deploy esetén módosítsd.

On the first startup the application only creates the required tables; all
organizations must now be added manually via the admin felület.

## Szavazási események és delegáltak

- Az adminisztrátorok a bal oldali menüben elérhető **Szavazási események**
  oldalon hozhatnak létre új eseményt, válthatják aktívvá a következő
  szavazást, valamint szervezetenként kijelölhetik az egyetlen résztvevő
  delegáltat.
- Delegált csak olyan tag lehet, aki jóváhagyott, megerősített és a szervezet
  tagsági díja rendezett. A kiválasztás minden eseménynél külön történik,
  a korábbi hozzárendelések megőrződnek.
- Csak az aktív eseményhez kijelölt delegált (illetve a rendszerszintű admin)
  láthatja engedélyezve a **Szavazás megnyitása** gombot a tagi felületen.
  A felület jelzi az aktuális esemény nevét, valamint azt, ha nincs aktív
  szavazás vagy nincs hozzárendelt delegált.
- A gomb megnyomásakor a backend HMAC-aláírt o2auth tokent készít, amely tartalmazza
  a felhasználó, a szervezet és az aktív esemény azonosítóját. A token az
  `VOTING_APP_BASE_URL` szerinti `/o2auth` végpontra irányítja a felhasználót, és
  alapértelmezetten 5 percig érvényes (`VOTING_O2AUTH_TTL_SECONDS`).
- A kérés törzsében opcionálisan megadható egy `view` mező is. A `"default"`
  érték a szavazói felületre visz, a `"public"` nézet a voting szolgáltatás
  `/public` útvonalára irányít és minden rendezett tagságú tag számára elérhető
  (akkor is, ha nem ő a delegált), míg a `"admin"` érték csak rendszerszintű
  adminok számára engedélyezett és közvetlenül a `/admin` irányítópultot nyitja
  meg.
- A különálló szavazási szolgáltatás ugyanazzal a `VOTING_O2AUTH_SECRET` titokkal
  ellenőrzi a tokeneket. Sikeres hitelesítés után HTTP-only munkamenet sütit
  állít be, és a felhasználói felület megjeleníti az aktív esemény nevét is.
