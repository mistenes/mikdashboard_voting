const CONSENT_STORAGE_KEY = "mik-dashboard-cookie-consent";
const CONSENT_COOKIE = `${CONSENT_STORAGE_KEY}=accepted`;

function hasStoredConsent() {
  try {
    if (localStorage.getItem(CONSENT_STORAGE_KEY) === "accepted") {
      return true;
    }
  } catch (err) {
    console.warn("Nem sikerült elérni a localStorage-t a sütikhez:", err);
  }

  return document.cookie.split(";").some((cookie) =>
    cookie.trim().startsWith(CONSENT_COOKIE)
  );
}

function persistConsent() {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, "accepted");
  } catch (err) {
    console.warn("Nem sikerült elmenteni a sütibeállítást localStorage-ba:", err);
  }

  document.cookie = `${CONSENT_COOKIE}; path=/; max-age=31536000; SameSite=Lax`;
}

export function initCookieConsent() {
  if (hasStoredConsent() || document.getElementById("cookie-consent-banner")) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = "cookie-consent-banner";
  banner.className = "cookie-banner";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Sütihasználati értesítés");

  const content = document.createElement("div");
  content.className = "cookie-banner__content";

  const title = document.createElement("h2");
  title.className = "cookie-banner__title";
  title.textContent = "Sütihasználat";

  const message = document.createElement("p");
  message.className = "cookie-banner__message";
  message.textContent =
    "A MIK Dashboard a biztonságos bejelentkezéshez és a munkamenetek fenntartásához szükséges sütiket használ. A folytatáshoz fogadd el a sütiket.";

  content.appendChild(title);
  content.appendChild(message);

  const actions = document.createElement("div");
  actions.className = "cookie-banner__actions";

  const acceptButton = document.createElement("button");
  acceptButton.type = "button";
  acceptButton.className = "primary-btn cookie-banner__btn";
  acceptButton.textContent = "Rendben, elfogadom";
  acceptButton.addEventListener("click", () => {
    persistConsent();
    banner.remove();
  });

  const note = document.createElement("p");
  note.className = "cookie-banner__note";
  note.textContent =
    "Csak a szükséges sütiket használjuk a bejelentkezéshez és a biztonságos böngészéshez.";

  actions.appendChild(acceptButton);

  banner.appendChild(content);
  banner.appendChild(note);
  banner.appendChild(actions);

  document.body.appendChild(banner);
}

initCookieConsent();
