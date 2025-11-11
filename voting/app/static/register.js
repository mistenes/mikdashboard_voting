const registrationForm = document.querySelector("#registration-form");
const registrationStatus = document.querySelector("#registration-status");
const organizationSelect = document.querySelector("#org-select");
const refreshButton = document.querySelector("#refresh-orgs");
const captchaWrapper = document.querySelector("#captcha-wrapper");
const captchaContainer = document.querySelector("#captcha-container");
const captchaInput = document.querySelector("#captcha-token");

let captchaRequired = false;
let captchaWidgetId = null;
let captchaInitAttempts = 0;

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || "";
    } catch (_) {
      // üres
    }
    throw new Error(detail || "Ismeretlen hiba");
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function populateOrganizations(items) {
  while (organizationSelect.options.length > 1) {
    organizationSelect.remove(1);
  }

  items.forEach((org) => {
    const option = document.createElement("option");
    option.value = org.id;
    option.textContent = org.name;
    organizationSelect.appendChild(option);
  });
}

async function loadOrganizations() {
  registrationStatus.textContent = "";
  registrationStatus.classList.remove("error", "success");

  try {
    const organizations = await requestJSON("/api/organizations");
    populateOrganizations(organizations);
  } catch (error) {
    populateOrganizations([]);
    registrationStatus.textContent =
      "Nem sikerült betölteni a szervezetek listáját. Próbáld újra a Frissítés gombbal.";
    registrationStatus.classList.add("error");
  }
}

function resetCaptchaSolution() {
  if (captchaInput) {
    captchaInput.value = "";
  }
  if (
    captchaWidgetId !== null &&
    window.grecaptcha &&
    typeof window.grecaptcha.reset === "function"
  ) {
    window.grecaptcha.reset(captchaWidgetId);
  }
}

function renderRecaptcha(sitekey) {
  if (!captchaContainer) {
    return;
  }

  const captchaLib = window.grecaptcha;
  if (!captchaLib || typeof captchaLib.render !== "function") {
    if (captchaInitAttempts < 15) {
      captchaInitAttempts += 1;
      window.setTimeout(() => renderRecaptcha(sitekey), 250);
    }
    return;
  }

  captchaRequired = true;
  if (captchaWrapper) {
    captchaWrapper.removeAttribute("hidden");
  }

  captchaWidgetId = captchaLib.render(captchaContainer, {
    sitekey,
    callback: (token) => {
      if (captchaInput) {
        captchaInput.value = token || "";
      }
    },
    "expired-callback": () => {
      if (captchaInput) {
        captchaInput.value = "";
      }
    },
    "error-callback": resetCaptchaSolution,
  });
}

async function loadCaptchaConfig() {
  try {
    const config = await requestJSON("/api/public/config");
    if (config?.recaptcha_site_key) {
      renderRecaptcha(config.recaptcha_site_key);
    }
  } catch (_) {
    // konfiguráció nem elérhető, captcha opcionális marad
  }
}

registrationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  registrationStatus.textContent = "";
  registrationStatus.classList.remove("error", "success");

  const formData = new FormData(registrationForm);
  const organizationId = parseInt(formData.get("organization"), 10);

  if (!organizationId) {
    registrationStatus.textContent = "Válassz ki egy szervezetet a regisztrációhoz.";
    registrationStatus.classList.add("error");
    return;
  }

  const payload = {
    email: formData.get("email"),
    first_name: formData.get("first_name"),
    last_name: formData.get("last_name"),
    password: formData.get("password"),
    organization_id: organizationId,
    captcha_token: formData.get("captcha_token") || null,
  };

  if (captchaRequired && !payload.captcha_token) {
    registrationStatus.textContent =
      "Kérjük, oldd meg a robot elleni feladatot a folytatáshoz.";
    registrationStatus.classList.add("error");
    return;
  }

  try {
    await requestJSON("/api/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    registrationStatus.textContent =
      "Sikeres regisztráció. Nézd meg az e-mail fiókodat a megerősítő levélért.";
    registrationStatus.classList.add("success");
    registrationForm.reset();
    organizationSelect.selectedIndex = 0;
    resetCaptchaSolution();
  } catch (error) {
    const message = error.message || "Ismeretlen hiba";
    registrationStatus.textContent = message.includes("szervezet")
      ? "A kiválasztott szervezet nem található."
      : message;
    registrationStatus.classList.add("error");
  }
});

refreshButton?.addEventListener("click", loadOrganizations);

loadOrganizations();
loadCaptchaConfig();
