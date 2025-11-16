const CONSENT_STORAGE_KEY = "mik-dashboard-cookie-consent";
const CONSENT_COOKIE = `${CONSENT_STORAGE_KEY}=accepted`;
const ISSUE_ENDPOINT = "/api/report-issue";
const BETA_BANNER_DISMISS_KEY = "mik-dashboard-beta-banner-dismissed";

function hasDismissedBetaBanner() {
  try {
    return localStorage.getItem(BETA_BANNER_DISMISS_KEY) === "1";
  } catch (err) {
    console.warn("Nem sikerült elérni a localStorage-t a béta bannerhez:", err);
  }

  return false;
}

function rememberBetaBannerDismissal() {
  try {
    localStorage.setItem(BETA_BANNER_DISMISS_KEY, "1");
  } catch (err) {
    console.warn("Nem sikerült elmenteni a béta banner elutasítását:", err);
  }
}

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

function initBetaBanner() {
  if (document.getElementById("beta-banner") || hasDismissedBetaBanner()) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = "beta-banner";
  banner.className = "beta-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");

  const title = document.createElement("strong");
  title.className = "beta-banner__title";
  title.textContent = "Béta verzió";

  const text = document.createElement("span");
  text.className = "beta-banner__text";
  text.textContent =
    "A MIK Dashboard jelenleg béta verzióban működik. Hibát vagy problémát tapasztalsz? Használd a jobb alsó sarokban lévő Hibajelentőt, hogy üzenj a fejlesztőnek.";

  const content = document.createElement("div");
  content.className = "beta-banner__content";
  content.appendChild(title);
  content.appendChild(text);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "beta-banner__close";
  closeButton.setAttribute("aria-label", "Béta értesítés bezárása");
  closeButton.innerHTML = "&times;";
  closeButton.addEventListener("click", () => {
    rememberBetaBannerDismissal();
    banner.remove();
    document.body.classList.remove("has-beta-banner");
  });

  banner.appendChild(content);
  banner.appendChild(closeButton);
  document.body.prepend(banner);
  document.body.classList.add("has-beta-banner");
}

function initIssueReporter() {
  if (document.getElementById("issue-reporter-trigger")) {
    return;
  }

  const trigger = document.createElement("button");
  trigger.id = "issue-reporter-trigger";
  trigger.type = "button";
  trigger.className = "issue-reporter__trigger";
  trigger.textContent = "Hibajelentő";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("title", "Üzenet küldése a fejlesztőnek");

  const overlay = document.createElement("div");
  overlay.id = "issue-reporter-overlay";
  overlay.className = "issue-reporter__overlay";
  overlay.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "issue-reporter__dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "issue-reporter-title");

  const header = document.createElement("div");
  header.className = "issue-reporter__header";

  const title = document.createElement("h2");
  title.id = "issue-reporter-title";
  title.textContent = "Hibajelentés küldése";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "ghost-btn issue-reporter__close";
  closeButton.textContent = "Bezárás";
  closeButton.addEventListener("click", () => setReporterOpen(false));

  header.appendChild(title);
  header.appendChild(closeButton);

  const description = document.createElement("p");
  description.className = "issue-reporter__description";
  description.textContent =
    "Írd meg a neved és a tapasztalt hibát vagy problémát. Az üzenetet a fejlesztő közvetlenül megkapja.";

  const form = document.createElement("form");
  form.className = "issue-reporter__form";
  form.noValidate = true;

  const nameField = document.createElement("label");
  nameField.className = "issue-reporter__field";
  nameField.textContent = "Név";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.name = "name";
  nameInput.required = true;
  nameInput.maxLength = 150;
  nameInput.placeholder = "Neved";
  nameField.appendChild(nameInput);

  const messageField = document.createElement("label");
  messageField.className = "issue-reporter__field";
  messageField.textContent = "Üzenet";

  const messageInput = document.createElement("textarea");
  messageInput.name = "message";
  messageInput.required = true;
  messageInput.rows = 4;
  messageInput.maxLength = 2000;
  messageInput.placeholder = "Írd le, mit tapasztaltál";
  messageField.appendChild(messageInput);

  const status = document.createElement("p");
  status.id = "issue-reporter-status";
  status.className = "issue-reporter__status";
  status.setAttribute("role", "status");

  const actions = document.createElement("div");
  actions.className = "issue-reporter__actions";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "primary-btn";
  submitButton.textContent = "Üzenet küldése";

  actions.appendChild(submitButton);

  form.appendChild(nameField);
  form.appendChild(messageField);
  form.appendChild(status);
  form.appendChild(actions);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    status.dataset.state = "";

    const name = nameInput.value.trim();
    const message = messageInput.value.trim();

    if (!name || !message) {
      status.textContent = "Kérjük, add meg a neved és a leírást.";
      status.dataset.state = "error";
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Küldés...";

    try {
      const response = await fetch(ISSUE_ENDPOINT, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          name,
          message,
          page_url: window?.location?.href || "",
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const detail = data?.detail || "Nem sikerült elküldeni az üzenetet.";
        throw new Error(detail);
      }

      status.textContent = "Köszönjük! Az üzenetet elküldtük a fejlesztőnek.";
      status.dataset.state = "success";
      form.reset();

      setTimeout(() => setReporterOpen(false), 1000);
    } catch (err) {
      const messageText = err?.message || "Nem sikerült elküldeni az üzenetet.";
      status.textContent = messageText;
      status.dataset.state = "error";
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Üzenet küldése";
    }
  });

  dialog.appendChild(header);
  dialog.appendChild(description);
  dialog.appendChild(form);

  overlay.appendChild(dialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      setReporterOpen(false);
    }
  });

  function setReporterOpen(isOpen) {
    overlay.hidden = !isOpen;
    overlay.dataset.open = isOpen ? "true" : "false";
    trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isOpen) {
      nameInput.focus();
    }
  }

  trigger.addEventListener("click", () => setReporterOpen(true));

  document.body.appendChild(trigger);
  document.body.appendChild(overlay);
}

initBetaBanner();
initIssueReporter();
