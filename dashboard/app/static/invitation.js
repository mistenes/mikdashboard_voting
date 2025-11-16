import "./cookie-consent.js";

const statusEl = document.querySelector("#invite-status");
const organizationEl = document.querySelector("#invite-organization");
const emailEl = document.querySelector("#invite-email");
const roleEl = document.querySelector("#invite-role");
const introEl = document.querySelector("#invitation-intro");
const formEl = document.querySelector("#invitation-form");
const confirmInput = document.querySelector("#password-confirm");
const passwordInput = document.querySelector("#password");
const firstNameInput = document.querySelector("#first-name");
const lastNameInput = document.querySelector("#last-name");

function setStatus(message, type = "") {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message || "";
  statusEl.classList.remove("error", "success");
  if (type) {
    statusEl.classList.add(type);
  }
}

function formatRole(role) {
  return role === "contact" ? "Kapcsolattartó" : "Tag";
}

function extractToken() {
  const match = window.location.pathname.match(/\/meghivas\/([^/]+)/);
  return match ? match[1] : null;
}

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
      // ignore
    }
    const error = new Error(detail || "Ismeretlen hiba történt.");
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function loadInvitationDetails(token) {
  try {
    const invitation = await requestJSON(`/api/invitations/${token}`);
    organizationEl.textContent = invitation.organization_name;
    emailEl.textContent = invitation.email;
    roleEl.textContent = formatRole(invitation.role);
    if (invitation.first_name && !firstNameInput.value) {
      firstNameInput.value = invitation.first_name;
    }
    if (invitation.last_name && !lastNameInput.value) {
      lastNameInput.value = invitation.last_name;
    }
    introEl.textContent =
      invitation.role === "contact"
        ? "Erősítsd meg az adataidat, hogy a szervezet kapcsolattartójaként beléphess."
        : "Erősítsd meg az adataidat, hogy csatlakozhass a szervezethez.";
  } catch (error) {
    setStatus(error.message || "A meghívó nem található vagy lejárt.", "error");
    if (formEl) {
      Array.from(formEl.elements).forEach((element) => {
        element.disabled = true;
      });
    }
    throw error;
  }
}

function validatePasswords() {
  if (!passwordInput || !confirmInput) {
    return true;
  }
  if (passwordInput.value !== confirmInput.value) {
    setStatus("A két jelszó nem egyezik.", "error");
    return false;
  }
  return true;
}

async function submitInvitation(event, token) {
  event.preventDefault();
  if (!validatePasswords()) {
    return;
  }
  setStatus("Meghívó elfogadása folyamatban...");
  try {
    await requestJSON(`/api/invitations/${token}/accept`, {
      method: "POST",
      body: JSON.stringify({
        first_name: firstNameInput.value,
        last_name: lastNameInput.value,
        password: passwordInput.value,
      }),
    });
    setStatus(
      "Sikeresen elfogadtad a meghívót. Most már bejelentkezhetsz az új jelszóval.",
      "success",
    );
    if (formEl) {
      Array.from(formEl.elements).forEach((element) => {
        element.disabled = true;
      });
    }
    window.setTimeout(() => {
      window.location.href = "/";
    }, 2000);
  } catch (error) {
    setStatus(error.message || "Nem sikerült elfogadni a meghívót.", "error");
  }
}

async function init() {
  const token = extractToken();
  if (!token) {
    setStatus("Érvénytelen meghívó hivatkozás.", "error");
    if (formEl) {
      Array.from(formEl.elements).forEach((element) => {
        element.disabled = true;
      });
    }
    return;
  }

  try {
    await loadInvitationDetails(token);
  } catch (_) {
    return;
  }

  formEl?.addEventListener("submit", (event) => submitInvitation(event, token));
}

init();
