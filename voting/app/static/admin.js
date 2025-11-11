const body = document.body;
const pageType = body?.dataset?.adminPage || "overview";
const adminStatus = document.querySelector("#admin-status");
const signOutButton = document.querySelector("#admin-sign-out");

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

attachSignOut();

switch (pageType) {
  case "organizations":
    initOrganizationsPage();
    break;
  case "pending":
    initPendingPage();
    break;
  default:
    initOverviewPage();
    break;
}
