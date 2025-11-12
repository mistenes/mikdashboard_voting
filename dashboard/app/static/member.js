const body = document.body;
const pageType = body?.dataset?.memberPage || "tagok";
const statusEl = document.querySelector("#member-status");
const organizationId = extractOrganizationId();
const navLinks = document.querySelectorAll("[data-member-link]");
const signOutButton = document.querySelector("#member-sign-out");
const openVotingButton = document.querySelector("#open-voting");
const votingHelper = document.querySelector("#voting-helper");

let cachedSessionUser = null;
let cachedOrganizationDetail = null;
let votingHandlerBound = false;

function extractOrganizationId() {
  const match = window.location.pathname.match(/\/szervezetek\/(\d+)\//);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

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

function clearStatus() {
  setStatus("");
}

function setVotingHelper(message = "") {
  if (!votingHelper) {
    return;
  }
  votingHelper.textContent = message || "";
}

function getAuthHeaders(options = {}) {
  const token = sessionStorage.getItem("authToken");
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: getAuthHeaders(options),
    ...options,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || "";
    } catch (_) {
      // nincs további részlet
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

function handleAuthError(error) {
  const message = error?.message || "Ismeretlen hiba";
  setStatus(message, "error");
  if (error?.status === 401 || error?.status === 403) {
    sessionStorage.clear();
    setTimeout(() => {
      window.location.href = "/";
    }, 1200);
  }
}

function formatDisplayName(firstName, lastName, fallback = "") {
  const cleanedFirst = (firstName || "").trim();
  const cleanedLast = (lastName || "").trim();
  const parts = [cleanedLast, cleanedFirst].filter(Boolean);
  const display = parts.join(" ");
  return display || fallback;
}

function ensureNavLinks(orgId) {
  navLinks.forEach((link) => {
    const target = link.dataset.memberLink;
    if (!target) {
      return;
    }
    link.href = `/szervezetek/${orgId}/${target}`;
    link.classList.toggle("active", pageType === target);
  });
}

function renderMembers(detail) {
  const tableBody = document.querySelector("#member-list-table tbody");
  if (!tableBody) {
    return;
  }
  tableBody.innerHTML = "";

  detail.members.forEach((member) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = formatDisplayName(
      member.first_name,
      member.last_name,
      member.email,
    );

    const emailCell = document.createElement("td");
    emailCell.textContent = member.email;

    const statusCell = document.createElement("td");
    if (member.is_admin) {
      statusCell.textContent = "Adminisztrátor";
    } else if (!member.is_email_verified) {
      statusCell.textContent = "E-mail megerősítésre vár";
    } else if (member.admin_decision !== "approved") {
      statusCell.textContent = "Admin jóváhagyásra vár";
    } else if (!detail.fee_paid) {
      statusCell.textContent = "Tagsági díj rendezetlen";
    } else if (!member.has_access) {
      statusCell.textContent = "Hozzáférés blokkolva";
    } else if (member.is_voting_delegate) {
      statusCell.textContent = "Szavazó delegált";
    } else {
      statusCell.textContent = "Aktív";
    }

    row.appendChild(nameCell);
    row.appendChild(emailCell);
    row.appendChild(statusCell);
    tableBody.appendChild(row);
  });
}

function renderOrganizationBasics(detail) {
  const nameEl = document.querySelector("#member-organization-name");
  const accessEl = document.querySelector("#member-access-status");
  if (nameEl) {
    nameEl.textContent = detail.name;
  }
  if (accessEl) {
    accessEl.textContent = detail.fee_paid
      ? "A tagsági díj rendezve, a funkciók elérhetők."
      : "A tagsági díj rendezetlen, kérjük intézkedj.";
  }
}

function renderUnpaid(detail) {
  const bankNameEl = document.querySelector("#bank-name");
  const bankAccountEl = document.querySelector("#bank-account");
  const instructionsEl = document.querySelector("#bank-instructions");

  bankNameEl.textContent = detail.bank_name || "Nincs megadva";
  bankAccountEl.textContent = detail.bank_account_number || "Nincs megadva";
  instructionsEl.textContent = detail.payment_instructions || "Nincs megadva";
}

function renderVoting(detail, sessionUser) {
  if (!openVotingButton) {
    return;
  }

  setVotingHelper("");

  const isPaid = Boolean(detail.fee_paid);
  const member = detail.members?.find((item) => item.id === sessionUser.id);
  const isDelegate = Boolean(sessionUser.is_admin || member?.is_voting_delegate);

  if (!isPaid) {
    openVotingButton.disabled = true;
    setVotingHelper(
      "A szervezet tagsági díja rendezetlen, ezért a szavazási felület nem nyitható meg.",
    );
    return;
  }

  if (!isDelegate) {
    openVotingButton.disabled = true;
    setVotingHelper(
      "Nem vagy kijelölve a szavazási eseményre, ezért nem nyithatod meg a felületet.",
    );
    return;
  }

  openVotingButton.disabled = false;
  setVotingHelper("A gombra kattintva új lapon nyílik meg a szavazási felület.");

  if (!votingHandlerBound) {
    openVotingButton.addEventListener("click", handleOpenVoting);
    votingHandlerBound = true;
  }
}

async function handleOpenVoting(event) {
  event.preventDefault();
  if (!organizationId) {
    return;
  }

  try {
    openVotingButton.disabled = true;
    setStatus("Szavazási felület megnyitása folyamatban...", "");
    const response = await requestJSON(
      `/api/organizations/${organizationId}/voting/sso`,
      {
        method: "POST",
      },
    );
    window.location.href = response.redirect;
  } catch (error) {
    const message =
      error?.message || "Nem sikerült megnyitni a szavazási felületet. Próbáld újra később.";
    setStatus(message, "error");
    if (cachedOrganizationDetail && cachedSessionUser) {
      renderVoting(cachedOrganizationDetail, cachedSessionUser);
    } else if (openVotingButton) {
      openVotingButton.disabled = false;
    }
  }
}

async function fetchSessionUser() {
  if (!sessionStorage.getItem("authToken")) {
    setStatus("A megtekintéshez jelentkezz be.", "error");
    setTimeout(() => {
      window.location.href = "/";
    }, 1200);
    throw new Error("Nincs bejelentkezett felhasználó");
  }
  return requestJSON("/api/me");
}

function redirectToSection(orgId, section) {
  window.location.href = `/szervezetek/${orgId}/${section}`;
}

function attachSignOut() {
  if (!signOutButton) {
    return;
  }
  signOutButton.addEventListener("click", () => {
    sessionStorage.clear();
    window.location.href = "/";
  });
}

async function init() {
  attachSignOut();
  if (!organizationId) {
    setStatus("Érvénytelen szervezet azonosító.", "error");
    return;
  }
  try {
    const sessionUser = await fetchSessionUser();
    cachedSessionUser = sessionUser;
    if (
      !sessionUser.is_admin &&
      (!sessionUser.organization || sessionUser.organization.id !== organizationId)
    ) {
      setStatus("Ehhez a szervezethez nincs hozzáférésed.", "error");
      sessionStorage.clear();
      setTimeout(() => {
        window.location.href = "/";
      }, 1200);
      return;
    }

    ensureNavLinks(organizationId);
    clearStatus();

    const detail = await requestJSON(`/api/organizations/${organizationId}/detail`);
    cachedOrganizationDetail = detail;
    renderOrganizationBasics(detail);

    if (!sessionUser.is_admin) {
      if (pageType === "tagok" && !detail.fee_paid) {
        redirectToSection(organizationId, "dij");
        return;
      }
      if (pageType === "dij" && detail.fee_paid) {
        redirectToSection(organizationId, "tagok");
        return;
      }
    }

    if (pageType !== "szavazas") {
      setVotingHelper("");
    }

    if (pageType === "tagok") {
      renderMembers(detail);
    } else if (pageType === "dij") {
      renderUnpaid(detail);
    } else if (pageType === "szavazas") {
      renderVoting(detail, sessionUser);
    }
  } catch (error) {
    handleAuthError(error);
  }
}

init();
