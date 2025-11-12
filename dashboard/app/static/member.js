const body = document.body;
const pageType = body?.dataset?.memberPage || "tagok";
const statusEl = document.querySelector("#member-status");
const organizationId = extractOrganizationId();
const navLinks = document.querySelectorAll("[data-member-link]");
const signOutButton = document.querySelector("#member-sign-out");
const openVotingButton = document.querySelector("#open-voting");
const openVotingAdminButton = document.querySelector("#open-voting-admin");
const openVotingPublicButton = document.querySelector("#open-voting-public");
const votingHelper = document.querySelector("#voting-helper");
const eventSummary = document.querySelector("#current-event-summary");
const invitationCard = document.querySelector("#member-invitations-card");
const invitationForm = document.querySelector("#member-invite-form");
const invitationStatus = document.querySelector("#member-invite-status");
const invitationTableBody = document.querySelector("#member-invitations-table tbody");

let cachedSessionUser = null;
let cachedOrganizationDetail = null;
let votingHandlerBound = false;
let adminVotingHandlerBound = false;
let publicVotingHandlerBound = false;
let votingLaunchInFlight = false;

const inviteDateFormatter = new Intl.DateTimeFormat("hu-HU", {
  dateStyle: "medium",
  timeStyle: "short",
});

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

function applyVotingBusyState() {
  [openVotingButton, openVotingAdminButton, openVotingPublicButton].forEach(
    (button) => {
      if (!button) {
        return;
      }
      const available = button.dataset.available === "1";
      button.disabled = !available || votingLaunchInFlight;
    },
  );
}

function markVotingButtonState(button, { available, hidden = false }) {
  if (!button) {
    return;
  }
  button.dataset.available = available ? "1" : "0";
  button.classList.toggle("is-hidden", hidden);
  applyVotingBusyState();
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

function formatInviteRole(role) {
  return role === "contact" ? "Kapcsolattartó" : "Tag";
}

function formatInviteTimestamp(value) {
  if (!value) {
    return "";
  }
  try {
    return inviteDateFormatter.format(new Date(value));
  } catch (_) {
    return "";
  }
}

function ensureNavLinks(orgId) {
  navLinks.forEach((link) => {
    const target = link.dataset.memberLink;
    if (!target) {
      return;
    }
    link.href = `/szervezetek/${orgId}/${target}`;
    const isActive = pageType === target;
    link.classList.toggle("active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
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
    row.classList.toggle("contact-member", Boolean(member.is_contact));

    const nameCell = document.createElement("td");
    nameCell.textContent = formatDisplayName(
      member.first_name,
      member.last_name,
      member.email,
    );

    const emailCell = document.createElement("td");
    emailCell.textContent = member.email;

    const statusCell = document.createElement("td");
    if (member.is_contact) {
      statusCell.textContent = "Kapcsolattartó";
    } else if (member.is_admin) {
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

function setInvitationStatus(message, type = "") {
  if (!invitationStatus) {
    return;
  }
  invitationStatus.textContent = message || "";
  invitationStatus.classList.remove("error", "success");
  if (type) {
    invitationStatus.classList.add(type);
  }
}

function clearInvitationStatus() {
  setInvitationStatus("");
}

function renderInvitations(detail, sessionUser) {
  if (!invitationCard || !invitationTableBody) {
    return;
  }
  const isContact = Boolean(
    sessionUser.is_admin ||
      sessionUser.is_organization_contact ||
      (detail.contact && detail.contact.user && detail.contact.user.id === sessionUser.id),
  );
  if (!isContact) {
    invitationCard.classList.add("is-hidden");
    return;
  }
  invitationCard.classList.remove("is-hidden");
  clearInvitationStatus();

  const pending = Array.isArray(detail.pending_invitations)
    ? detail.pending_invitations
    : [];
  invitationTableBody.innerHTML = "";
  if (!pending.length) {
    const row = document.createElement("tr");
    const emptyCell = document.createElement("td");
    emptyCell.colSpan = 3;
    emptyCell.classList.add("muted");
    emptyCell.textContent = "Nincs folyamatban lévő meghívó.";
    row.appendChild(emptyCell);
    invitationTableBody.appendChild(row);
    return;
  }

  pending.forEach((invite) => {
    const row = document.createElement("tr");
    const emailCell = document.createElement("td");
    emailCell.textContent = invite.email;
    const roleCell = document.createElement("td");
    roleCell.textContent = formatInviteRole(invite.role);
    const createdCell = document.createElement("td");
    createdCell.textContent = formatInviteTimestamp(invite.created_at);
    row.appendChild(emailCell);
    row.appendChild(roleCell);
    row.appendChild(createdCell);
    invitationTableBody.appendChild(row);
  });
}

function bindInvitationForm(sessionUser) {
  if (!invitationForm || invitationForm.dataset.bound === "1") {
    return;
  }
  invitationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!organizationId) {
      return;
    }
    clearInvitationStatus();
    const formData = new FormData(invitationForm);
    const payload = {
      email: formData.get("email"),
      first_name: formData.get("first_name"),
      last_name: formData.get("last_name"),
      role: "member",
    };

    try {
      const detail = await requestJSON(`/api/organizations/${organizationId}/invitations`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      cachedOrganizationDetail = detail;
      setInvitationStatus("Meghívó elküldve.", "success");
      invitationForm.reset();
      renderMembers(detail);
      renderInvitations(detail, sessionUser);
    } catch (error) {
      setInvitationStatus(error?.message || "Nem sikerült elküldeni a meghívót.", "error");
      if (error?.status === 401 || error?.status === 403) {
        handleAuthError(error);
      }
    }
  });
  invitationForm.dataset.bound = "1";
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
  markVotingButtonState(openVotingButton, { available: false, hidden: false });
  markVotingButtonState(openVotingAdminButton, { available: false, hidden: true });
  markVotingButtonState(openVotingPublicButton, { available: false, hidden: true });

  const activeEvent = detail.active_event || sessionUser.active_event || null;
  const eventName = activeEvent?.title || "szavazási esemény";
  if (eventSummary) {
    if (activeEvent) {
      const description = (activeEvent.description || "").trim();
      eventSummary.textContent = description
        ? `${activeEvent.title} – ${description}`
        : `${activeEvent.title}`;
    } else {
      eventSummary.textContent = "Jelenleg nincs aktív szavazási esemény.";
    }
  }

  const isPaid = Boolean(detail.fee_paid);
  const isAdmin = Boolean(sessionUser.is_admin);
  const delegateIds = Array.isArray(detail.active_event_delegate_user_ids)
    ? detail.active_event_delegate_user_ids.filter((id) => Number.isInteger(id))
    : [];
  const primaryDelegateId = detail.active_event_delegate_user_id || delegateIds[0] || null;
  const delegateMembers = Array.isArray(detail.members)
    ? detail.members.filter((member) => delegateIds.includes(member.id))
    : [];
  const isDelegate = Boolean(
    isAdmin || delegateIds.includes(sessionUser.id) || primaryDelegateId === sessionUser.id,
  );

  if (!activeEvent) {
    setVotingHelper(
      "Jelenleg nincs megnyitható szavazási esemény. Kérjük, várd meg az adminisztrátori értesítést.",
    );
    return;
  }

  if (!activeEvent.is_voting_enabled) {
    setVotingHelper(
      "A szavazási felület még nem elérhető ehhez az eseményhez. Kérjük, térj vissza később."
    );
    return;
  }

  const publicAvailable = isPaid;
  markVotingButtonState(openVotingPublicButton, {
    available: publicAvailable,
    hidden: !publicAvailable,
  });

  if (isAdmin && publicAvailable) {
    markVotingButtonState(openVotingAdminButton, { available: true, hidden: false });
  }

  if (!isPaid) {
    setVotingHelper(
      "A szervezet tagsági díja rendezetlen, ezért a szavazási felület nem nyitható meg.",
    );
    return;
  }

  if (!isDelegate) {
    const assignedNames = delegateMembers.map((member) =>
      formatDisplayName(member.first_name, member.last_name, member.email),
    );
    let delegateMessage = assignedNames.length
      ? `A(z) "${eventName}" eseményre jelenleg ${assignedNames.join(", ")} képviseli(k) a szervezetet a szavazás során.`
      : `Nem vagy kijelölve a(z) "${eventName}" szavazási eseményre, ezért nem nyithatod meg a felületet.`;
    if (publicAvailable) {
      delegateMessage = `${delegateMessage} A nyilvános nézet gombbal követheted az eredményeket.`;
    }
    setVotingHelper(delegateMessage);
    return;
  }

  markVotingButtonState(openVotingButton, { available: true, hidden: false });
  setVotingHelper(
    `A gombra kattintva új lapon nyílik meg a(z) "${eventName}" szavazási felület.`,
  );
}

async function launchVoting(view = "default") {
  if (!organizationId) {
    return;
  }

  try {
    votingLaunchInFlight = true;
    applyVotingBusyState();
    const statusMessage =
      view === "admin"
        ? "Admin nézet megnyitása folyamatban..."
        : view === "public"
          ? "Nyilvános nézet megnyitása folyamatban..."
          : "Szavazási felület megnyitása folyamatban...";
    setStatus(statusMessage, "");
    const options = { method: "POST" };
    if (view && view !== "default") {
      options.body = JSON.stringify({ view });
    }
    const response = await requestJSON(
      `/api/organizations/${organizationId}/voting/o2auth`,
      options,
    );
    window.location.href = response.redirect;
  } catch (error) {
    const message =
      error?.message || "Nem sikerült megnyitni a szavazási felületet. Próbáld újra később.";
    setStatus(message, "error");
    if (cachedOrganizationDetail && cachedSessionUser) {
      renderVoting(cachedOrganizationDetail, cachedSessionUser);
    }
  } finally {
    votingLaunchInFlight = false;
    applyVotingBusyState();
  }
}

async function handleOpenVoting(event) {
  event.preventDefault();
  await launchVoting();
}

async function handleOpenAdminVoting(event) {
  event.preventDefault();
  await launchVoting("admin");
}

async function handleOpenPublicVoting(event) {
  event.preventDefault();
  await launchVoting("public");
}

async function fetchSessionUser() {
  if (!sessionStorage.getItem("authToken")) {
    setStatus("A megtekintéshez jelentkezz be.", "error");
    setTimeout(() => {
      window.location.href = "/";
    }, 1200);
    throw new Error("Nincs bejelentkezett felhasználó");
  }
  if (sessionStorage.getItem("mustChangePassword") === "1") {
    window.location.href = "/jelszo-frissites";
    throw new Error("Jelszócsere szükséges");
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

function bindVotingButtons() {
  if (openVotingButton) {
    openVotingButton.dataset.available = "0";
    openVotingButton.disabled = true;
  }
  if (openVotingAdminButton) {
    openVotingAdminButton.dataset.available = "0";
    openVotingAdminButton.classList.add("is-hidden");
    openVotingAdminButton.disabled = true;
  }
  if (openVotingPublicButton) {
    openVotingPublicButton.dataset.available = "0";
    openVotingPublicButton.classList.add("is-hidden");
    openVotingPublicButton.disabled = true;
  }
  if (openVotingButton && !votingHandlerBound) {
    openVotingButton.addEventListener("click", handleOpenVoting);
    votingHandlerBound = true;
  }
  if (openVotingAdminButton && !adminVotingHandlerBound) {
    openVotingAdminButton.addEventListener("click", handleOpenAdminVoting);
    adminVotingHandlerBound = true;
  }
  if (openVotingPublicButton && !publicVotingHandlerBound) {
    openVotingPublicButton.addEventListener("click", handleOpenPublicVoting);
    publicVotingHandlerBound = true;
  }
}

async function init() {
  attachSignOut();
  bindVotingButtons();
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
      bindInvitationForm(sessionUser);
      renderMembers(detail);
      renderInvitations(detail, sessionUser);
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
