const body = document.body;
const pageType = body?.dataset?.adminPage || "overview";
const adminStatus = document.querySelector("#admin-status");
const signOutButton = document.querySelector("#admin-sign-out");
const eventListContainer = document.querySelector("#event-list");
const eventSelector = document.querySelector("#event-selector");
const delegateTableBody = document.querySelector("#delegate-table-body");
const createEventForm = document.querySelector("#create-event-form");
const selectedEventInfo = document.querySelector("#selected-event-info");

const eventState = {
  organizations: [],
  events: [],
  delegates: [],
  selectedEventId: null,
};

const eventDateFormatter = new Intl.DateTimeFormat("hu-HU", {
  dateStyle: "medium",
  timeStyle: "short",
});

function getSelectedEvent() {
  if (!eventState.selectedEventId) {
    return null;
  }
  return (
    eventState.events.find((item) => item.id === eventState.selectedEventId) || null
  );
}

function countAssignedDelegates() {
  if (!Array.isArray(eventState.delegates)) {
    return 0;
  }
  return eventState.delegates.reduce((count, item) => {
    return item && item.user_id ? count + 1 : count;
  }, 0);
}

function formatDateTime(value) {
  if (!value) {
    return null;
  }
  try {
    return eventDateFormatter.format(new Date(value));
  } catch (_) {
    return null;
  }
}

function setStatus(message, type = "") {
  if (!adminStatus) {
    return;
  }
  adminStatus.textContent = message || "";
  adminStatus.classList.remove("error", "success");
  if (type) {
    adminStatus.classList.add(type);
  }
}

function clearStatus() {
  setStatus("");
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
    const error = new Error(detail || "Ismeretlen hiba");
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function ensureAdminSession(silent = false) {
  const token = sessionStorage.getItem("authToken");
  const isAdmin = sessionStorage.getItem("isAdmin") === "1";
  const mustChange = sessionStorage.getItem("mustChangePassword") === "1";
  if (!token || !isAdmin) {
    if (!silent) {
      setStatus(
        "A felület használatához adminisztrátorként kell bejelentkezni.",
        "error",
      );
      setTimeout(() => {
        window.location.href = "/";
      }, 1200);
    }
    return false;
  }
  if (mustChange) {
    window.location.href = "/jelszo-frissites";
    return false;
  }
  return true;
}

function handleAuthError(error) {
  const message = error?.message || "Ismeretlen hiba történt.";
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

function memberStatus(member, organizationPaid) {
  if (member.is_admin) {
    return "Adminisztrátor";
  }
  if (!member.is_email_verified) {
    return "E-mail megerősítésre vár";
  }
  if (member.admin_decision !== "approved") {
    return "Admin jóváhagyásra vár";
  }
  if (!organizationPaid) {
    return "Tagsági díj rendezetlen";
  }
  if (!member.has_access) {
    return "Hozzáférés blokkolva";
  }
  if (member.is_voting_delegate) {
    return "Szavazó delegált";
  }
  return "Aktív tagság";
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

async function loadOverview() {
  clearStatus();
  try {
    const [organizations, pending] = await Promise.all([
      requestJSON("/api/admin/organizations"),
      requestJSON("/api/admin/pending"),
    ]);

    const orgCountEl = document.querySelector("#overview-org-count");
    const memberCountEl = document.querySelector("#overview-member-count");
    const pendingCountEl = document.querySelector("#overview-pending-count");
    const unpaidBanner = document.querySelector("#overview-unpaid-banner");

    const unpaidCount = organizations.filter((org) => !org.fee_paid).length;
    const memberTotal = organizations.reduce(
      (sum, org) => sum + (org.member_count || 0),
      0,
    );

    if (orgCountEl) {
      orgCountEl.textContent = organizations.length.toString();
    }
    if (memberCountEl) {
      memberCountEl.textContent = memberTotal.toString();
    }
    if (pendingCountEl) {
      pendingCountEl.textContent = pending.length.toString();
    }
    if (unpaidBanner) {
      if (unpaidCount) {
        unpaidBanner.hidden = false;
        unpaidBanner.textContent =
          unpaidCount === 1
            ? "1 szervezet tagsági díja rendezetlen"
            : `${unpaidCount} szervezet tagsági díja rendezetlen`;
      } else {
        unpaidBanner.hidden = true;
      }
    }
  } catch (error) {
    handleAuthError(error);
  }
}

async function initOverviewPage() {
  if (!ensureAdminSession()) {
    return;
  }
  await loadOverview();
  const refreshButton = document.querySelector("[data-admin-refresh]");
  refreshButton?.addEventListener("click", async () => {
    await loadOverview();
  });
}

async function loadOrganizations() {
  if (!ensureAdminSession(true)) {
    return;
  }
  clearStatus();
  try {
    const data = await requestJSON("/api/admin/organizations");
    renderOrganizations(data);
  } catch (error) {
    handleAuthError(error);
  }
}

function renderOrganizations(items) {
  const container = document.querySelector("#organizations-list");
  if (!container) {
    return;
  }
  container.innerHTML = "";

  if (!items.length) {
    const emptyState = document.createElement("p");
    emptyState.classList.add("muted");
    emptyState.textContent = "Még nincs felvett szervezet.";
    container.appendChild(emptyState);
    return;
  }

  items.forEach((org) => {
    const card = document.createElement("article");
    card.classList.add("organization-card");

    const header = document.createElement("header");
    header.classList.add("organization-head");

    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = org.name;
    const subtitle = document.createElement("p");
    subtitle.classList.add("muted");
    subtitle.textContent = `${org.member_count} tag`;
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const controls = document.createElement("div");
    controls.classList.add("organization-controls");

    const feeBadge = document.createElement("span");
    feeBadge.classList.add("badge", org.fee_paid ? "badge-success" : "badge-warning");
    feeBadge.textContent = org.fee_paid
      ? "Tagsági díj rendezve"
      : "Tagsági díj rendezetlen";

    const toggleButton = document.createElement("button");
    toggleButton.classList.add("primary-btn");
    toggleButton.type = "button";
    toggleButton.textContent = org.fee_paid
      ? "Állapot: rendezetté teszem"
      : "Állapot: rendezettre állítom";
    toggleButton.addEventListener("click", async () => {
      try {
        await requestJSON(`/api/admin/organizations/${org.id}/fee`, {
          method: "POST",
          body: JSON.stringify({ fee_paid: !org.fee_paid }),
        });
        setStatus("Tagsági díj státusz frissítve.", "success");
        await loadOrganizations();
      } catch (error) {
        handleAuthError(error);
      }
    });

    controls.appendChild(feeBadge);
    controls.appendChild(toggleButton);

    header.appendChild(titleWrap);
    header.appendChild(controls);

    const bankSection = document.createElement("section");
    bankSection.classList.add("organization-bank");

    const bankTitle = document.createElement("h4");
    bankTitle.textContent = "Banki adatok";
    bankSection.appendChild(bankTitle);

    const bankForm = document.createElement("form");
    bankForm.classList.add("organization-bank-form");

    const bankNameLabel = document.createElement("label");
    bankNameLabel.setAttribute("for", `bank-name-${org.id}`);
    bankNameLabel.textContent = "Bank neve";
    const bankNameInput = document.createElement("input");
    bankNameInput.id = `bank-name-${org.id}`;
    bankNameInput.name = "bank_name";
    bankNameInput.type = "text";
    bankNameInput.placeholder = "Pl. Magyar Bank";
    bankNameInput.value = org.bank_name || "";

    const bankAccountLabel = document.createElement("label");
    bankAccountLabel.setAttribute("for", `bank-account-${org.id}`);
    bankAccountLabel.textContent = "Bankszámlaszám";
    const bankAccountInput = document.createElement("input");
    bankAccountInput.id = `bank-account-${org.id}`;
    bankAccountInput.name = "bank_account_number";
    bankAccountInput.type = "text";
    bankAccountInput.placeholder = "Pl. 11700000-00000000";
    bankAccountInput.value = org.bank_account_number || "";

    const instructionsLabel = document.createElement("label");
    instructionsLabel.setAttribute("for", `bank-instructions-${org.id}`);
    instructionsLabel.textContent = "Utalási megjegyzés";
    const instructionsInput = document.createElement("textarea");
    instructionsInput.id = `bank-instructions-${org.id}`;
    instructionsInput.name = "payment_instructions";
    instructionsInput.rows = 3;
    instructionsInput.placeholder = "Pl. Közlemény: Név + tagsági díj";
    instructionsInput.value = org.payment_instructions || "";

    const bankActions = document.createElement("div");
    bankActions.classList.add("organization-bank-actions");

    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.classList.add("primary-btn");
    saveButton.textContent = "Banki adatok mentése";

    bankForm.appendChild(bankNameLabel);
    bankForm.appendChild(bankNameInput);
    bankForm.appendChild(bankAccountLabel);
    bankForm.appendChild(bankAccountInput);
    bankForm.appendChild(instructionsLabel);
    bankForm.appendChild(instructionsInput);
    bankActions.appendChild(saveButton);
    bankForm.appendChild(bankActions);

    bankForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await requestJSON(`/api/admin/organizations/${org.id}/billing`, {
          method: "POST",
          body: JSON.stringify({
            bank_name: bankNameInput.value,
            bank_account_number: bankAccountInput.value,
            payment_instructions: instructionsInput.value,
          }),
        });
        setStatus("Banki adatok frissítve.", "success");
        await loadOrganizations();
      } catch (error) {
        handleAuthError(error);
      }
    });

    bankSection.appendChild(bankForm);

    const membersSection = document.createElement("section");
    membersSection.classList.add("organization-members");

    const membersHeader = document.createElement("div");
    membersHeader.classList.add("organization-members-header");
    const membersTitle = document.createElement("h4");
    membersTitle.textContent = "Taglista";
    membersHeader.appendChild(membersTitle);

    const memberTable = document.createElement("table");
    memberTable.classList.add("organization-members-table");

    const memberHead = document.createElement("thead");
    memberHead.innerHTML = `
      <tr>
        <th>Tag</th>
        <th>E-mail</th>
        <th>Státusz</th>
        <th>Műveletek</th>
      </tr>
    `;
    memberTable.appendChild(memberHead);

    const memberBody = document.createElement("tbody");

    org.members.forEach((member) => {
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
      statusCell.textContent = memberStatus(member, org.fee_paid);

      const actionsCell = document.createElement("td");
      if (member.is_admin) {
        actionsCell.textContent = "-";
      } else {
        const delegateButton = document.createElement("button");
        delegateButton.type = "button";
        delegateButton.classList.add("ghost-btn");
        delegateButton.textContent = member.is_voting_delegate
          ? "Szavazó státusz visszavonása"
          : "Szavazóként kijelölöm";
        delegateButton.addEventListener("click", async () => {
          if (!ensureAdminSession(true)) {
            return;
          }
          try {
            await requestJSON(`/api/admin/users/${member.id}/delegate`, {
              method: "POST",
              body: JSON.stringify({ is_delegate: !member.is_voting_delegate }),
            });
            setStatus("Szavazási jogosultság frissítve.", "success");
            await loadOrganizations();
          } catch (error) {
            handleAuthError(error);
          }
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.classList.add("ghost-btn");
        deleteButton.textContent = "Felhasználó törlése";
        deleteButton.addEventListener("click", async () => {
          if (!(await confirmUserDeletion(member.email))) {
            return;
          }
          try {
            await requestJSON(`/api/admin/users/${member.id}`, {
              method: "DELETE",
            });
            setStatus("Felhasználó törölve.", "success");
            await loadOrganizations();
          } catch (error) {
            handleAuthError(error);
          }
        });
        actionsCell.appendChild(delegateButton);
        actionsCell.appendChild(deleteButton);
      }

      row.appendChild(nameCell);
      row.appendChild(emailCell);
      row.appendChild(statusCell);
      row.appendChild(actionsCell);
      memberBody.appendChild(row);
    });

    memberTable.appendChild(memberBody);
    membersSection.appendChild(membersHeader);
    membersSection.appendChild(memberTable);

    const footer = document.createElement("div");
    footer.classList.add("organization-footer");

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.classList.add("danger-btn");
    deleteButton.textContent = "Szervezet törlése";
    deleteButton.addEventListener("click", async () => {
      if (!(await confirmOrganizationDeletion(org.name))) {
        return;
      }
      try {
        await requestJSON(`/api/admin/organizations/${org.id}`, {
          method: "DELETE",
        });
        setStatus("Szervezet törölve.", "success");
        await loadOrganizations();
      } catch (error) {
        handleAuthError(error);
      }
    });

    footer.appendChild(deleteButton);

    card.appendChild(header);
    card.appendChild(bankSection);
    card.appendChild(membersSection);
    card.appendChild(footer);

    container.appendChild(card);
  });
}

async function confirmOrganizationDeletion(name) {
  const first = window.confirm(
    `${name} szervezet törlésére készülsz. Biztosan folytatod?`,
  );
  if (!first) {
    return false;
  }
  const second = window.confirm(
    "A törlés végleges és minden tagot érint. Folytatod?",
  );
  if (!second) {
    return false;
  }
  const third = window.prompt(
    "A törléshez írd be nagybetűvel: TÖRLÉS",
  );
  return third !== null && third.trim().toUpperCase() === "TÖRLÉS";
}

async function confirmUserDeletion(email) {
  const first = window.confirm(
    `${email} felhasználó törlésére készülsz. Biztosan folytatod?`,
  );
  if (!first) {
    return false;
  }
  const second = window.confirm(
    "A művelet nem visszavonható. Folytatod?",
  );
  if (!second) {
    return false;
  }
  const third = window.prompt(
    "A végleges törléshez írd be: TÖRLÉS",
  );
  return third !== null && third.trim().toUpperCase() === "TÖRLÉS";
}

async function confirmEventDeletion(title) {
  const first = window.confirm(
    `${title} esemény törlésére készülsz. Biztosan folytatod?`,
  );
  if (!first) {
    return false;
  }
  const second = window.prompt(
    "A törlés végleges. A folytatáshoz írd be: ESEMÉNY TÖRLÉSE",
  );
  return second !== null && second.trim().toUpperCase() === "ESEMÉNY TÖRLÉSE";
}

async function initOrganizationsPage() {
  if (!ensureAdminSession()) {
    return;
  }
  await loadOrganizations();

  const addOrganizationForm = document.querySelector("#add-organization-form");
  const refreshButton = document.querySelector("[data-admin-refresh]");

  addOrganizationForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ensureAdminSession(true)) {
      return;
    }
    const formData = new FormData(addOrganizationForm);
    const payload = {
      name: formData.get("name"),
      bank_name: formData.get("bank_name"),
      bank_account_number: formData.get("bank_account_number"),
      payment_instructions: formData.get("payment_instructions"),
    };
    try {
      await requestJSON("/api/admin/organizations", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setStatus("Új szervezet hozzáadva.", "success");
      addOrganizationForm.reset();
      await loadOrganizations();
    } catch (error) {
      handleAuthError(error);
    }
  });

  refreshButton?.addEventListener("click", async () => {
    await loadOrganizations();
  });
}

async function loadPending() {
  if (!ensureAdminSession(true)) {
    return;
  }
  clearStatus();
  try {
    const users = await requestJSON("/api/admin/pending");
    renderPending(users);
  } catch (error) {
    handleAuthError(error);
  }
}

function renderPending(users) {
  const tableBody = document.querySelector("#pending-table tbody");
  if (!tableBody) {
    return;
  }
  tableBody.innerHTML = "";

  if (!users.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.classList.add("muted");
    cell.textContent = "Jelenleg nincs függő regisztráció.";
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }

  users.forEach((user) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = formatDisplayName(
      user.first_name,
      user.last_name,
      user.email,
    );

    const emailCell = document.createElement("td");
    emailCell.textContent = user.email;

    const statusCell = document.createElement("td");
    statusCell.textContent = user.is_email_verified
      ? "E-mail megerősítve"
      : "Megerősítésre vár";

    const organizationCell = document.createElement("td");
    organizationCell.textContent = user.organization || "Ismeretlen";

    const actionsCell = document.createElement("td");
    const approveButton = document.createElement("button");
    approveButton.type = "button";
    approveButton.classList.add("primary-btn");
    approveButton.textContent = "Jóváhagyás";
    approveButton.addEventListener("click", async () => {
      await decideRegistration(user.id, true);
    });

    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.classList.add("ghost-btn");
    rejectButton.textContent = "Elutasítás";
    rejectButton.addEventListener("click", async () => {
      await decideRegistration(user.id, false);
    });

    actionsCell.appendChild(approveButton);
    actionsCell.appendChild(rejectButton);

    row.appendChild(nameCell);
    row.appendChild(emailCell);
    row.appendChild(statusCell);
    row.appendChild(organizationCell);
    row.appendChild(actionsCell);

    tableBody.appendChild(row);
  });
}

async function decideRegistration(userId, approve) {
  try {
    await requestJSON(`/api/admin/users/${userId}/decision`, {
      method: "POST",
      body: JSON.stringify({ approve }),
    });
    setStatus(
      approve
        ? "Felhasználó jóváhagyva és megerősítve."
        : "Felhasználó elutasítva.",
      "success",
    );
    await loadPending();
  } catch (error) {
    handleAuthError(error);
  }
}

async function initPendingPage() {
  if (!ensureAdminSession()) {
    return;
  }
  await loadPending();
  const refreshButton = document.querySelector("[data-admin-refresh]");
  refreshButton?.addEventListener("click", async () => {
    await loadPending();
  });
}

function eligibleDelegatesForOrganization(organization) {
  return (organization.members || []).filter(
    (member) =>
      !member.is_admin &&
      member.has_access &&
      member.is_email_verified &&
      member.admin_decision === "approved"
  );
}

function renderEventsList(events) {
  if (!eventListContainer) {
    return;
  }
  eventListContainer.innerHTML = "";

  if (!events.length) {
    const emptyState = document.createElement("p");
    emptyState.classList.add("muted");
    emptyState.textContent = "Még nincs létrehozott esemény.";
    eventListContainer.appendChild(emptyState);
    return;
  }

  events.forEach((event) => {
    const card = document.createElement("article");
    card.classList.add("event-card");
    if (event.is_active) {
      card.classList.add("event-card-active");
    }

    const header = document.createElement("header");
    header.classList.add("event-head");

    const title = document.createElement("h3");
    title.textContent = event.title;
    header.appendChild(title);

    const badge = document.createElement("span");
    badge.classList.add("badge");
    const votingEnabled = Boolean(event.is_voting_enabled);
    badge.classList.add(votingEnabled ? "badge-success" : "badge-muted");
    badge.textContent = votingEnabled ? "Aktív" : "Inaktív";
    header.appendChild(badge);

    const description = document.createElement("p");
    description.classList.add("muted");
    description.textContent = event.description || "Nincs megadott leírás.";

    const meta = document.createElement("p");
    meta.classList.add("event-meta");
    const createdLabel = event.created_at
      ? eventDateFormatter.format(new Date(event.created_at))
      : "Ismeretlen időpont";
    const delegateSummary = event.delegate_limit
      ? `${event.delegate_count} / ${event.delegate_limit}`
      : `${event.delegate_count}`;
    meta.textContent = `Létrehozva: ${createdLabel} • Delegáltak: ${delegateSummary}`;

    const details = document.createElement("ul");
    details.classList.add("event-details");
    const eventDateLabel = formatDateTime(event.event_date);
    if (eventDateLabel) {
      const item = document.createElement("li");
      item.textContent = `Esemény időpontja: ${eventDateLabel}`;
      details.appendChild(item);
    }
    const deadlineLabel = formatDateTime(event.delegate_deadline);
    if (deadlineLabel) {
      const item = document.createElement("li");
      item.textContent = `Delegált határidő: ${deadlineLabel}`;
      details.appendChild(item);
    }
    const accessItem = document.createElement("li");
    accessItem.textContent = event.is_voting_enabled
      ? "Szavazási felület engedélyezve"
      : "Szavazási felület letiltva";
    details.appendChild(accessItem);
    const limitItem = document.createElement("li");
    limitItem.textContent = event.delegate_limit
      ? `Delegált keret: ${event.delegate_count} / ${event.delegate_limit}`
      : "Delegált keret: nincs felső határ";
    details.appendChild(limitItem);

    const actions = document.createElement("div");
    actions.classList.add("event-actions");

    const toggleWrapper = document.createElement("label");
    toggleWrapper.classList.add("event-toggle");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(event.is_voting_enabled);
    toggle.disabled = !event.is_active;
    toggle.title = event.is_active
      ? "A szavazási felület engedélyezése vagy letiltása."
      : "Csak az aktív esemény érhető el a szavazási felületen.";
    toggle.addEventListener("change", async () => {
      await handleVotingAccessToggle(event, toggle);
    });
    const toggleLabel = document.createElement("span");
    toggleLabel.textContent = "Szavazási felület engedélyezése";
    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(toggleLabel);
    actions.appendChild(toggleWrapper);

    if (!event.is_active) {
      const activateButton = document.createElement("button");
      activateButton.type = "button";
      activateButton.classList.add("primary-btn");
      activateButton.textContent = "Aktiválás";
      activateButton.addEventListener("click", async () => {
        await handleEventActivation(event.id);
      });
      actions.appendChild(activateButton);
    } else {
      const activeLabel = document.createElement("span");
      activeLabel.classList.add("muted");
      activeLabel.textContent = "Ez az esemény jelenleg aktív.";
      actions.appendChild(activeLabel);
    }

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.classList.add("danger-btn");
    deleteButton.textContent = "Esemény törlése";
    deleteButton.disabled = !event.can_delete;
    if (!event.can_delete) {
      deleteButton.title = "Az aktív esemény nem törölhető.";
    }
    deleteButton.addEventListener("click", async () => {
      await handleEventDeletion(event);
    });
    actions.appendChild(deleteButton);

    card.appendChild(header);
    card.appendChild(description);
    card.appendChild(meta);
    card.appendChild(details);
    card.appendChild(actions);

    eventListContainer.appendChild(card);
  });
}

function renderEventSelectorControl(events) {
  if (!eventSelector) {
    return;
  }
  eventSelector.innerHTML = "";

  if (!events.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Nincs elérhető esemény";
    eventSelector.appendChild(option);
    eventSelector.disabled = true;
    if (selectedEventInfo) {
      selectedEventInfo.textContent = "Még nincs elérhető esemény.";
    }
    return;
  }

  eventSelector.disabled = false;
  events.forEach((event) => {
    const option = document.createElement("option");
    option.value = String(event.id);
    const labels = [event.title];
    if (event.is_active) {
      labels.push("(aktív)");
    }
    labels.push(event.is_voting_enabled ? "• szavazás engedélyezve" : "• szavazás letiltva");
    option.textContent = labels.join(" ");
    eventSelector.appendChild(option);
  });

  const desiredValue =
    eventState.selectedEventId && events.some((event) => event.id === eventState.selectedEventId)
      ? String(eventState.selectedEventId)
      : String(events[0].id);
  eventSelector.value = desiredValue;
  renderSelectedEventInfo();
}

function currentDelegateInfo(organizationId) {
  return eventState.delegates.find((item) => item.organization_id === organizationId) || null;
}

function renderSelectedEventInfo() {
  if (!selectedEventInfo) {
    return;
  }
  if (!eventState.selectedEventId) {
    selectedEventInfo.textContent = "Válassz ki egy eseményt.";
    return;
  }
  const event = getSelectedEvent();
  if (!event) {
    selectedEventInfo.textContent = "Válassz ki egy eseményt.";
    return;
  }
  const parts = [];
  const eventDateLabel = formatDateTime(event.event_date);
  if (eventDateLabel) {
    parts.push(`Időpont: ${eventDateLabel}`);
  }
  const deadlineLabel = formatDateTime(event.delegate_deadline);
  if (deadlineLabel) {
    parts.push(`Delegált határidő: ${deadlineLabel}`);
  }
  parts.push(event.is_voting_enabled ? "Szavazási felület engedélyezve" : "Szavazási felület letiltva");
  const assignedCount = countAssignedDelegates();
  if (event.delegate_limit) {
    parts.push(`Delegáltak: ${assignedCount}/${event.delegate_limit}`);
    if (assignedCount >= event.delegate_limit) {
      parts.push("Delegált keret betelt");
    }
  } else {
    parts.push(`Delegáltak: ${assignedCount}`);
  }
  selectedEventInfo.textContent = parts.join(" • ");
}

function renderDelegateTable() {
  if (!delegateTableBody) {
    return;
  }
  delegateTableBody.innerHTML = "";

  if (!eventState.selectedEventId) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.classList.add("muted");
    cell.textContent = "Válassz ki egy eseményt a delegáltak kezeléséhez.";
    row.appendChild(cell);
    delegateTableBody.appendChild(row);
    return;
  }

  if (!eventState.organizations.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.classList.add("muted");
    cell.textContent = "Még nincs felvett szervezet.";
    row.appendChild(cell);
    delegateTableBody.appendChild(row);
    return;
  }

  const selectedEvent = getSelectedEvent();
  const delegateLimit = selectedEvent?.delegate_limit ?? null;
  const assignedCount = countAssignedDelegates();
  const limitReached =
    delegateLimit !== null && delegateLimit > 0 && assignedCount >= delegateLimit;

  eventState.organizations.forEach((organization) => {
    const info = currentDelegateInfo(organization.id);
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = organization.name;

    const delegateCell = document.createElement("td");
    if (info && info.user_id) {
      delegateCell.textContent = formatDisplayName(
        info.user_first_name,
        info.user_last_name,
        info.user_email,
      );
    } else {
      delegateCell.classList.add("muted");
      delegateCell.textContent = limitReached
        ? "Nincs kijelölt delegált (a keret betelt)"
        : "Nincs kijelölt delegált";
    }

    const selectCell = document.createElement("td");
    const select = document.createElement("select");
    select.dataset.organizationId = String(organization.id);

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Nincs delegált";
    select.appendChild(emptyOption);

    const eligibleMembers = eligibleDelegatesForOrganization(organization);
    eligibleMembers.forEach((member) => {
      const option = document.createElement("option");
      option.value = String(member.id);
      option.textContent = formatDisplayName(
        member.first_name,
        member.last_name,
        member.email,
      );
      if (info && info.user_id === member.id) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    select.value = info && info.user_id ? String(info.user_id) : "";
    const hasDelegate = Boolean(info && info.user_id);
    if (limitReached && !hasDelegate) {
      select.disabled = true;
      select.title = "Elérte a delegáltak maximális számát ezen az eseményen.";
    }
    select.addEventListener("change", async () => {
      await handleDelegateChange(organization.id, select);
    });

    selectCell.appendChild(select);

    row.appendChild(nameCell);
    row.appendChild(delegateCell);
    row.appendChild(selectCell);

    delegateTableBody.appendChild(row);
  });
}

async function refreshEventDelegates() {
  if (!ensureAdminSession(true)) {
    return;
  }
  if (!eventState.selectedEventId) {
    eventState.delegates = [];
    return;
  }
  try {
    const data = await requestJSON(
      `/api/admin/events/${eventState.selectedEventId}/delegates`,
    );
    eventState.delegates = Array.isArray(data) ? data : [];
  } catch (error) {
    eventState.delegates = [];
    handleAuthError(error);
  }
  renderSelectedEventInfo();
}

async function refreshEventData(refreshOrganizations = false) {
  if (!ensureAdminSession(true)) {
    return;
  }
  clearStatus();
  try {
    if (refreshOrganizations || !eventState.organizations.length) {
      const organizations = await requestJSON("/api/admin/organizations");
      eventState.organizations = Array.isArray(organizations) ? organizations : [];
    }
    const events = await requestJSON("/api/admin/events");
    eventState.events = Array.isArray(events) ? events : [];

    if (!eventState.events.length) {
      eventState.selectedEventId = null;
      eventState.delegates = [];
      renderEventsList(eventState.events);
      renderEventSelectorControl(eventState.events);
      renderDelegateTable();
      return;
    }

    if (
      !eventState.selectedEventId ||
      !eventState.events.some((event) => event.id === eventState.selectedEventId)
    ) {
      const activeEvent = eventState.events.find((event) => event.is_active);
      eventState.selectedEventId = activeEvent ? activeEvent.id : eventState.events[0].id;
    }

    await refreshEventDelegates();

    renderEventsList(eventState.events);
    renderEventSelectorControl(eventState.events);
    renderDelegateTable();
  } catch (error) {
    handleAuthError(error);
  }
}

async function handleEventActivation(eventId) {
  if (!ensureAdminSession(true)) {
    return;
  }
  try {
    await requestJSON(`/api/admin/events/${eventId}/activate`, {
      method: "POST",
    });
    eventState.selectedEventId = eventId;
    setStatus("Az esemény aktívvá vált.", "success");
    await refreshEventData();
  } catch (error) {
    handleAuthError(error);
  }
}

async function handleEventDeletion(event) {
  if (!ensureAdminSession(true)) {
    return;
  }
  if (!(await confirmEventDeletion(event.title))) {
    return;
  }
  try {
    await requestJSON(`/api/admin/events/${event.id}`, {
      method: "DELETE",
    });
    if (eventState.selectedEventId === event.id) {
      eventState.selectedEventId = null;
    }
    setStatus("Szavazási esemény törölve.", "success");
    await refreshEventData();
  } catch (error) {
    handleAuthError(error);
  }
}

async function handleVotingAccessToggle(event, toggleElement) {
  if (!ensureAdminSession(true)) {
    toggleElement.checked = !toggleElement.checked;
    return;
  }
  const desired = toggleElement.checked;
  try {
    await requestJSON(`/api/admin/events/${event.id}/access`, {
      method: "POST",
      body: JSON.stringify({ is_voting_enabled: desired }),
    });
    setStatus(
      desired
        ? "A szavazási felület engedélyezve ezen az eseményen."
        : "A szavazási felület letiltva ezen az eseményen.",
      "success",
    );
    await refreshEventData();
  } catch (error) {
    toggleElement.checked = !desired;
    handleAuthError(error);
  }
}

async function handleDelegateChange(organizationId, selectElement) {
  if (!ensureAdminSession(true)) {
    return;
  }
  const value = selectElement.value;
  const userId = value ? Number.parseInt(value, 10) : null;
  const previous = currentDelegateInfo(organizationId);
  const selectedEvent = getSelectedEvent();
  const delegateLimit = selectedEvent?.delegate_limit ?? null;
  const assignedCount = countAssignedDelegates();
  const hadDelegate = Boolean(previous && previous.user_id);
  const isAssigning = userId !== null;
  if (
    delegateLimit !== null &&
    delegateLimit > 0 &&
    isAssigning &&
    !hadDelegate &&
    assignedCount >= delegateLimit
  ) {
    const fallback = previous && previous.user_id ? String(previous.user_id) : "";
    selectElement.value = fallback;
    setStatus(
      "Elérte a kijelölhető delegáltak maximális számát ezen az eseményen.",
      "error",
    );
    return;
  }
  try {
    await requestJSON(
      `/api/admin/events/${eventState.selectedEventId}/organizations/${organizationId}/delegate`,
      {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
      },
    );
    setStatus("A delegált sikeresen frissítve.", "success");
    await refreshEventDelegates();
    renderDelegateTable();
    renderSelectedEventInfo();
  } catch (error) {
    handleAuthError(error);
    const fallback = previous && previous.user_id ? String(previous.user_id) : "";
    selectElement.value = fallback;
    await refreshEventDelegates();
    renderDelegateTable();
    renderSelectedEventInfo();
  }
}

async function initEventsPage() {
  if (!ensureAdminSession()) {
    return;
  }
  await refreshEventData(true);

  const refreshButton = document.querySelector("[data-admin-refresh]");
  refreshButton?.addEventListener("click", async () => {
    await refreshEventData(true);
  });

  eventSelector?.addEventListener("change", async (event) => {
    const selected = Number.parseInt(event.target.value, 10);
    eventState.selectedEventId = Number.isFinite(selected) ? selected : null;
    await refreshEventDelegates();
    renderSelectedEventInfo();
    renderDelegateTable();
  });

  createEventForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ensureAdminSession(true)) {
      return;
    }
    const formData = new FormData(createEventForm);
    const eventDateValue = formData.get("event_date");
    const deadlineValue = formData.get("delegate_deadline");
    const limitValue = formData.get("delegate_limit");
    if (!eventDateValue || !deadlineValue) {
      setStatus("Kérjük, add meg az esemény dátumát és a delegált határidejét.", "error");
      return;
    }
    const delegateLimit = limitValue ? Number.parseInt(String(limitValue), 10) : NaN;
    if (!Number.isFinite(delegateLimit) || delegateLimit < 1) {
      setStatus("Kérjük, válaszd ki a delegáltak maximális számát.", "error");
      return;
    }
    const payload = {
      title: formData.get("title"),
      description: formData.get("description") || null,
      event_date: String(eventDateValue),
      delegate_deadline: String(deadlineValue),
      delegate_limit: delegateLimit,
      activate: formData.get("activate") === "on",
    };
    try {
      const created = await requestJSON("/api/admin/events", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setStatus("Új szavazási esemény létrehozva.", "success");
      createEventForm.reset();
      if (created?.id) {
        eventState.selectedEventId = created.id;
      }
      await refreshEventData();
    } catch (error) {
      handleAuthError(error);
    }
  });
}

async function initSettingsPage() {
  if (!ensureAdminSession()) {
    return;
  }

  const resetButton = document.querySelector("[data-reset-events]");
  if (!resetButton) {
    return;
  }

  resetButton.addEventListener("click", async () => {
    if (!ensureAdminSession(true)) {
      return;
    }

    const confirmed = window.confirm(
      "Biztosan törölni szeretnéd az összes szavazási eseményt? Ez a művelet végleges.",
    );
    if (!confirmed) {
      return;
    }

    const keyword = window.prompt(
      "A folytatáshoz írd be a következő kulcsszót: TÖRLÉS",
    );
    if (!keyword || keyword.trim().toUpperCase() !== "TÖRLÉS") {
      setStatus("A művelet megszakítva. A megerősítő kulcsszó nem egyezett.", "error");
      return;
    }

    resetButton.disabled = true;
    try {
      setStatus("Szavazási események törlése folyamatban...");
      const response = await requestJSON("/api/admin/events/reset", { method: "POST" });
      const message = response?.message || "Az események törlése megtörtént.";
      setStatus(message, "success");
    } catch (error) {
      handleAuthError(error);
    } finally {
      resetButton.disabled = false;
    }
  });
}

attachSignOut();

switch (pageType) {
  case "organizations":
    initOrganizationsPage();
    break;
  case "pending":
    initPendingPage();
    break;
  case "events":
    initEventsPage();
    break;
  case "settings":
    initSettingsPage();
    break;
  default:
    initOverviewPage();
    break;
}
