import "./cookie-consent.js";

const shell = document.querySelector("[data-profile-shell]");
const sidebarContainer = document.querySelector("[data-profile-sidebar]");
const profileHeader = document.querySelector("[data-profile-header]");
const main = document.querySelector("#profile-main");

let statusEl = document.querySelector("#profile-status");
let signOutButton = document.querySelector("#profile-sign-out");
let profileHomeLink = document.querySelector("#profile-home");
let resetButton = document.querySelector("#profile-reset");
let form = document.querySelector("#profile-password-form");
let submitButton = form?.querySelector("[data-submit]");

let firstNameInput = document.querySelector("#profile-first-name");
let lastNameInput = document.querySelector("#profile-last-name");
let emailInput = document.querySelector("#profile-email");
let currentPasswordInput = document.querySelector("#profile-current-password");
let newPasswordInput = document.querySelector("#profile-new-password");
let confirmPasswordInput = document.querySelector("#profile-confirm-password");

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

function renderSidebar(templateId) {
  if (!sidebarContainer) return null;
  const template = document.querySelector(templateId);
  if (!template) return null;
  const clone = template.content.firstElementChild?.cloneNode(true);
  if (!clone) return null;
  sidebarContainer.innerHTML = "";
  sidebarContainer.appendChild(clone);
  return clone;
}

function refreshElementRefs() {
  statusEl = document.querySelector("#profile-status");
  signOutButton = document.querySelector("#profile-sign-out");
  profileHomeLink = document.querySelector("#profile-home");
  resetButton = document.querySelector("#profile-reset");
  form = document.querySelector("#profile-password-form");
  submitButton = form?.querySelector("[data-submit]");

  firstNameInput = document.querySelector("#profile-first-name");
  lastNameInput = document.querySelector("#profile-last-name");
  emailInput = document.querySelector("#profile-email");
  currentPasswordInput = document.querySelector("#profile-current-password");
  newPasswordInput = document.querySelector("#profile-new-password");
  confirmPasswordInput = document.querySelector("#profile-confirm-password");
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

function applyAdminLayout() {
  if (!shell || !main) return;
  shell.classList.remove("member-shell");
  shell.classList.add("admin-shell");
  main.classList.remove("member-main");
  main.classList.add("admin-container");
  if (profileHeader) {
    profileHeader.classList.remove("member-main-header");
    profileHeader.classList.add("admin-header");
  }
  const sidebar = renderSidebar("#profile-admin-sidebar");
  return sidebar;
}

function formatAccessStatus(organization) {
  if (!organization) return "Nincs társított szervezet.";
  return organization.fee_paid ? "Tagsági díj rendezve" : "Tagsági díj rendezetlen";
}

function applyMemberLayout(user) {
  if (!shell || !main) return;
  shell.classList.remove("admin-shell");
  shell.classList.add("member-shell");
  main.classList.remove("admin-container");
  main.classList.add("member-main");
  if (profileHeader) {
    profileHeader.classList.remove("admin-header");
    profileHeader.classList.add("member-main-header");
  }

  const sidebar = renderSidebar("#profile-member-sidebar");
  if (!sidebar) return;

  const organization = user?.organization;
  const organizationId = organization?.id;
  const orgNameEl = sidebar.querySelector("#profile-org-name");
  const accessStatusEl = sidebar.querySelector("#profile-access-status");

  if (orgNameEl) orgNameEl.textContent = organization?.name || "Ismeretlen szervezet";
  if (accessStatusEl) accessStatusEl.textContent = formatAccessStatus(organization);

  const orgBase = organizationId ? `/szervezetek/${organizationId}` : "/";
  const navTargets = {
    overview: `${orgBase}/tagok`,
    tagkezeles: `${orgBase}/tagkezeles`,
    szavazas: `${orgBase}/szavazas`,
    penzugyek: `${orgBase}/penzugyek`,
  };

  Object.entries(navTargets).forEach(([key, href]) => {
    const link = sidebar.querySelector(`[data-profile-nav="${key}"]`);
    if (!link) return;
    link.href = href;
    if (!organizationId) {
      link.classList.add("is-hidden");
    }
  });

  const manageLink = sidebar.querySelector('[data-profile-nav="tagkezeles"]');
  if (manageLink) {
    manageLink.classList.toggle("is-hidden", !user?.is_organization_contact || !organizationId);
  }

  const profileLink = sidebar.querySelector('a[href="/profil"]');
  if (profileLink && organizationId) {
    profileLink.href = `${orgBase}/profil`;
  }

  return sidebar;
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
    const isAdmin = sessionStorage.getItem("isAdmin") === "1" || Boolean(user?.is_admin);
    const sidebar = isAdmin ? applyAdminLayout() : applyMemberLayout(user);
    refreshElementRefs();
    bindEvents();

    if (firstNameInput) firstNameInput.value = user?.first_name || "";
    if (lastNameInput) lastNameInput.value = user?.last_name || "";
    if (emailInput) emailInput.value = user?.email || "";

    if (!sidebar && statusEl) {
      statusEl.textContent = "Nem sikerült betölteni az oldalsávot.";
      statusEl.classList.add("error");
    }

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

let eventsBound = false;

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
  if (eventsBound) return;
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
  eventsBound = true;
}

updatePasswordRequirements();
loadProfile();
