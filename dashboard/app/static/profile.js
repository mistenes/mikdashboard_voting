import "./cookie-consent.js";

const statusEl = document.querySelector("#profile-status");
const signOutButton = document.querySelector("#profile-sign-out");
const profileHomeLink = document.querySelector("#profile-home");
const resetButton = document.querySelector("#profile-reset");
const form = document.querySelector("#profile-password-form");
const submitButton = form?.querySelector("[data-submit]");

const firstNameInput = document.querySelector("#profile-first-name");
const lastNameInput = document.querySelector("#profile-last-name");
const emailInput = document.querySelector("#profile-email");
const currentPasswordInput = document.querySelector("#profile-current-password");
const newPasswordInput = document.querySelector("#profile-new-password");
const confirmPasswordInput = document.querySelector("#profile-confirm-password");

const passwordRequirementItems = {
  length: document.querySelector('[data-requirement="length"]'),
  uppercase: document.querySelector('[data-requirement="uppercase"]'),
  special: document.querySelector('[data-requirement="special"]'),
};

const uppercasePattern = /[A-ZÁÉÍÓÖŐÚÜŰ]/;
const passwordRules = [
  { key: "length", test: (value) => value.length >= 8 },
  { key: "uppercase", test: (value) => uppercasePattern.test(value) },
  { key: "special", test: (value) => /[^A-Za-z0-9]/.test(value) },
];

function setStatus(message = "", type = "") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove("error", "success");
  if (message && type) {
    statusEl.classList.add(type);
  }
}

function setFieldError(fieldName, message) {
  const field = form?.querySelector(`[data-field="${fieldName}"]`);
  if (!field) return;
  const errorEl = field.querySelector("[data-field-error]");
  if (message) {
    field.setAttribute("data-invalid", "true");
    if (errorEl) errorEl.textContent = message;
  } else {
    field.removeAttribute("data-invalid");
    if (errorEl) errorEl.textContent = "";
  }
}

function clearErrors() {
  ["currentPassword", "newPassword", "confirmPassword"].forEach((name) => setFieldError(name, ""));
}

function updatePasswordRequirements() {
  if (!newPasswordInput) return;
  const value = newPasswordInput.value || "";
  passwordRules.forEach((rule) => {
    const met = rule.test(value);
    const listItem = passwordRequirementItems[rule.key];
    if (!listItem) return;
    listItem.classList.toggle("met", met);
    const indicator = listItem.querySelector(".requirement-indicator");
    if (indicator) {
      indicator.textContent = met ? "✓" : "";
    }
  });
}

function passwordMeetsRequirements() {
  if (!newPasswordInput) return false;
  return passwordRules.every((rule) => rule.test(newPasswordInput.value || ""));
}

function requireSessionToken() {
  const token = sessionStorage.getItem("authToken");
  if (!token) {
    window.location.href = "/";
    return null;
  }
  return token;
}

async function requestJSON(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || "";
    } catch (_) {
      // ignore
    }
    throw new Error(detail || "Ismeretlen hiba történt.");
  }
  if (response.status === 204) return null;
  return response.json();
}

async function loadProfile() {
  const token = requireSessionToken();
  if (!token) return;

  try {
    const user = await requestJSON("/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (firstNameInput) firstNameInput.value = user?.first_name || "";
    if (lastNameInput) lastNameInput.value = user?.last_name || "";
    if (emailInput) emailInput.value = user?.email || "";

    const isAdmin = sessionStorage.getItem("isAdmin") === "1" || Boolean(user?.is_admin);
    if (profileHomeLink) {
      if (isAdmin) {
        profileHomeLink.href = "/admin";
      } else if (user?.organization?.id) {
        profileHomeLink.href = `/szervezetek/${user.organization.id}/tagok`;
      } else {
        profileHomeLink.href = "/";
      }
    }
  } catch (error) {
    setStatus(error.message || "Nem sikerült betölteni a profilt.", "error");
  }
}

function resetFormFields() {
  if (currentPasswordInput) currentPasswordInput.value = "";
  if (newPasswordInput) newPasswordInput.value = "";
  if (confirmPasswordInput) confirmPasswordInput.value = "";
  updatePasswordRequirements();
  clearErrors();
  setStatus("");
}

function toggleBusy(isBusy) {
  if (!submitButton) return;
  submitButton.disabled = Boolean(isBusy);
  submitButton.dataset.loading = isBusy ? "true" : "false";
  submitButton.textContent = isBusy ? "Jelszó frissítése…" : "Jelszó frissítése";
}

async function handleSubmit(event) {
  event.preventDefault();
  clearErrors();
  updatePasswordRequirements();

  const token = requireSessionToken();
  if (!token) return;

  const currentPassword = currentPasswordInput?.value || "";
  const newPassword = newPasswordInput?.value || "";
  const confirmPassword = confirmPasswordInput?.value || "";

  let isValid = true;
  if (!currentPassword) {
    setFieldError("currentPassword", "Add meg a jelenlegi jelszavad.");
    isValid = false;
  }
  if (!newPassword) {
    setFieldError("newPassword", "Add meg az új jelszót.");
    isValid = false;
  } else if (!passwordMeetsRequirements()) {
    setFieldError(
      "newPassword",
      "A jelszónak meg kell felelnie az összes felsorolt követelménynek.",
    );
    isValid = false;
  }
  if (!confirmPassword) {
    setFieldError("confirmPassword", "Ismételd meg az új jelszót.");
    isValid = false;
  } else if (newPassword !== confirmPassword) {
    setFieldError("confirmPassword", "A két jelszó nem egyezik.");
    isValid = false;
  }

  if (!isValid) {
    setStatus("Ellenőrizd a kiemelt mezőket és a jelszókövetelményeket.", "error");
    return;
  }

  toggleBusy(true);
  setStatus("Jelszó frissítése folyamatban…", "");

  try {
    const response = await requestJSON("/api/change-password", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });

    sessionStorage.setItem("authToken", response?.token || token);
    sessionStorage.setItem("mustChangePassword", response?.must_change_password ? "1" : "0");
    resetFormFields();
    setStatus(response?.message || "A jelszavad frissült.", "success");
  } catch (error) {
    setStatus(error.message || "Nem sikerült frissíteni a jelszót.", "error");
  } finally {
    toggleBusy(false);
  }
}

function bindEvents() {
  form?.addEventListener("submit", handleSubmit);
  resetButton?.addEventListener("click", resetFormFields);
  signOutButton?.addEventListener("click", () => {
    sessionStorage.clear();
    window.location.href = "/";
  });
  newPasswordInput?.addEventListener("input", updatePasswordRequirements);
  newPasswordInput?.addEventListener("input", () => setFieldError("newPassword", ""));
  confirmPasswordInput?.addEventListener("input", () => setFieldError("confirmPassword", ""));
  currentPasswordInput?.addEventListener("input", () => setFieldError("currentPassword", ""));
}

updatePasswordRequirements();
bindEvents();
loadProfile();
