import "./cookie-consent.js";

const body = document.body;
const pageType = body?.dataset?.adminPage || "overview";
const adminStatus = document.querySelector("#admin-status");
const signOutButton = document.querySelector("#admin-sign-out");
const eventListContainer = document.querySelector("#event-list");
const delegateTableBody = document.querySelector("#delegate-table-body");
const createEventForm = document.querySelector("#create-event-form");
const selectedEventInfo = document.querySelector("#selected-event-info");
const createEventTitle = document.querySelector("#create-event-title");
const createEventHint = document.querySelector("#create-event-hint");
const cancelEventEditButton = document.querySelector("#cancel-event-edit");
const activateWrapper = createEventForm?.querySelector("[data-activate-wrapper]");
const activateCheckbox = createEventForm?.querySelector('input[name="activate"]');
const createEventSubmitButton = createEventForm?.querySelector('button[type="submit"]');
const delegateLockModeSelect = document.querySelector("#delegate-lock-mode");
const delegateLockApplyButton = document.querySelector("#delegate-lock-apply");
const delegateLockMessage = document.querySelector("#delegate-lock-message");
const delegateCodeSummary = document.querySelector("#delegate-code-summary");
const delegateCodeStatus = document.querySelector("#delegate-code-status");
const delegateCodeList = document.querySelector("#delegate-code-list");
const delegateGenerateCodesButton = document.querySelector("#delegate-generate-codes");
const delegateDownloadCodesButton = document.querySelector("#delegate-download-codes");
const delegatePanel = document.querySelector("[data-delegate-panel]");
const delegatePanelRefreshButton = document.querySelector("[data-delegate-refresh]");
const delegatePanelCloseButton = document.querySelector("[data-delegate-close]");
const eventTitleInput = createEventForm?.querySelector("#event-title");
const eventDescriptionInput = createEventForm?.querySelector("#event-description");
const eventDateInput = createEventForm?.querySelector("#event-date");
const delegateDeadlineInput = createEventForm?.querySelector("#delegate-deadline");
const delegateLimitSelect = createEventForm?.querySelector("#delegate-limit");
const addEventSection = document.querySelector('[data-collapsible="add-event"]');
const eventListSection = document.querySelector('[data-collapsible="event-list"]');

const defaultEventFormTitle = createEventTitle?.textContent?.trim() || "";
const defaultEventFormHint = createEventHint?.textContent?.trim() || "";
const defaultSubmitLabel = createEventSubmitButton?.textContent?.trim() || "";

const editFormTitle = "Esemény szerkesztése";
const editFormHint =
  "Frissítsd az esemény adatait, majd mentsd a módosításokat.";

const eventState = {
  organizations: [],
  events: [],
  delegates: [],
  selectedEventId: null,
  expandedEventId: null,
  editingEventId: null,
  accessCodes: [],
  accessCodeSummary: null,
};

let currentDelegateHost = null;
let delegatePanelDismissed = false;

const eventDateFormatter = new Intl.DateTimeFormat("hu-HU", {
  dateStyle: "medium",
  timeStyle: "short",
});

const actionStatusAnchors = new WeakMap();

function getActionStatusElement(anchor, create = true) {
  if (!anchor || !(anchor instanceof HTMLElement)) {
    return null;
  }

  let statusEl = actionStatusAnchors.get(anchor);
  if (statusEl && statusEl.isConnected) {
    return statusEl;
  }

  if (!create) {
    return null;
  }

  const parent = anchor.parentElement;
  if (!parent) {
    return null;
  }

  statusEl = document.createElement("p");
  statusEl.classList.add("status", "action-status");
  statusEl.setAttribute("role", "status");
  statusEl.hidden = true;
  anchor.insertAdjacentElement("afterend", statusEl);
  actionStatusAnchors.set(anchor, statusEl);
  return statusEl;
}

function updateActionStatus(anchor, message, type = "") {
  const shouldCreate = Boolean(message);
  const statusEl = getActionStatusElement(anchor, shouldCreate);
  if (!statusEl) {
    return;
  }

  statusEl.textContent = message || "";
  statusEl.classList.remove("error", "success");
  if (message && type) {
    statusEl.classList.add(type);
  }
  statusEl.hidden = !message;
}

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
    if (!item || !Array.isArray(item.delegates)) {
      return count;
    }
    const valid = item.delegates.filter((delegate) => delegate && delegate.user_id);
    return count + valid.length;
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

function setDelegateCodeStatus(message = "", type = "") {
  if (!delegateCodeStatus) {
    return;
  }
  delegateCodeStatus.textContent = message || "";
  delegateCodeStatus.classList.remove("error", "success");
  if (message && type) {
    delegateCodeStatus.classList.add(type);
  }
  delegateCodeStatus.hidden = !message;
}

function setCollapsibleState(container, trigger, body, expanded) {
  const isExpanded = Boolean(expanded);
  if (trigger) {
    trigger.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    const labelTarget = trigger.querySelector("[data-collapse-text]");
    const label = isExpanded
      ? trigger.getAttribute("data-expanded-label")
      : trigger.getAttribute("data-collapsed-label");
    if (labelTarget && label) {
      labelTarget.textContent = label;
    }
  }
  if (body) {
    body.hidden = !isExpanded;
  }
  if (container) {
    container.classList.toggle("collapsed", !isExpanded);
    container.classList.toggle("expanded", isExpanded);
  }
}

function attachCollapsible(container, trigger, body, defaultExpanded = false) {
  if (!trigger || !body) {
    return;
  }
  setCollapsibleState(container, trigger, body, defaultExpanded);
  trigger.addEventListener("click", () => {
    const isExpanded = trigger.getAttribute("aria-expanded") === "true";
    setCollapsibleState(container, trigger, body, !isExpanded);
  });
}

function initCollapsibleSection(section, defaultExpanded = false) {
  if (!section) {
    return;
  }
  const trigger = section.querySelector("[data-collapse-toggle]");
  const body = section.querySelector("[data-collapse-body]");
  attachCollapsible(section, trigger, body, defaultExpanded);
}

function getDelegateHostElement(eventId) {
  if (!Number.isFinite(eventId)) {
    return null;
  }
  return document.querySelector(`[data-delegate-host="${eventId}"]`);
}

function detachDelegatePanel() {
  if (currentDelegateHost) {
    currentDelegateHost.classList.remove("delegate-panel-active");
    currentDelegateHost = null;
  }
  if (delegatePanel) {
    delegatePanel.hidden = true;
  }
}

function mountDelegatePanel() {
  if (!delegatePanel) {
    return;
  }
  if (!eventState.selectedEventId) {
    detachDelegatePanel();
    return;
  }
  const host = getDelegateHostElement(eventState.selectedEventId);
  if (!host) {
    detachDelegatePanel();
    return;
  }
  host.appendChild(delegatePanel);
  delegatePanel.hidden = false;
  if (currentDelegateHost && currentDelegateHost !== host) {
    currentDelegateHost.classList.remove("delegate-panel-active");
  }
  currentDelegateHost = host;
  host.classList.add("delegate-panel-active");
}

function toggleEventCard(eventId) {
  if (!Number.isFinite(eventId)) {
    return;
  }
  if (eventState.expandedEventId === eventId) {
    if (eventState.selectedEventId === eventId) {
      closeDelegatePanel({ preserveExpansion: false });
      return;
    }
    eventState.expandedEventId = null;
    renderEventsList(eventState.events);
    return;
  }
  eventState.expandedEventId = eventId;
  renderEventsList(eventState.events);
}

async function openDelegatePanelForEvent(eventId, { scrollIntoView = true } = {}) {
  if (!ensureAdminSession(true)) {
    return;
  }
  if (!Number.isFinite(eventId)) {
    return;
  }
  delegatePanelDismissed = false;
  const selectionChanged = eventState.selectedEventId !== eventId;
  const expansionChanged = eventState.expandedEventId !== eventId;
  eventState.selectedEventId = eventId;
  eventState.expandedEventId = eventId;
  if (selectionChanged || expansionChanged) {
    renderEventsList(eventState.events);
  }
  await refreshEventDelegates();
  await refreshAccessCodes();
  renderSelectedEventInfo();
  renderDelegateTable();
  renderDelegateLockControls();
  renderAccessCodePanel();
  mountDelegatePanel();
  if (scrollIntoView && delegatePanel) {
    delegatePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function closeDelegatePanel(options = {}) {
  const { preserveExpansion = true } = options;
  delegatePanelDismissed = true;
  if (!eventState.selectedEventId) {
    if (!preserveExpansion) {
      eventState.expandedEventId = null;
      renderEventsList(eventState.events);
    }
    renderSelectedEventInfo();
    renderDelegateTable();
    renderDelegateLockControls();
    renderAccessCodePanel();
    detachDelegatePanel();
    return;
  }
  eventState.selectedEventId = null;
  eventState.delegates = [];
  eventState.accessCodes = [];
  eventState.accessCodeSummary = null;
  if (!preserveExpansion) {
    eventState.expandedEventId = null;
  }
  renderEventsList(eventState.events);
  renderSelectedEventInfo();
  renderDelegateTable();
  renderDelegateLockControls();
  renderAccessCodePanel();
  detachDelegatePanel();
}

function toDateTimeLocalValue(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (number) => String(number).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function ensureDelegateLimitOption(limit) {
  if (!delegateLimitSelect) {
    return;
  }
  if (!Number.isFinite(limit) || limit < 1) {
    return;
  }
  const desiredValue = String(limit);
  const hasOption = Array.from(delegateLimitSelect.options).some(
    (option) => option.value === desiredValue,
  );
  if (!hasOption) {
    const option = document.createElement("option");
    option.value = desiredValue;
    option.textContent = `${limit} delegált / szervezet`;
    delegateLimitSelect.appendChild(option);
  }
}

function resetEventFormPresentation() {
  if (createEventTitle) {
    createEventTitle.textContent = defaultEventFormTitle;
  }
  if (createEventHint) {
    createEventHint.textContent = defaultEventFormHint;
  }
  if (createEventSubmitButton) {
    createEventSubmitButton.textContent = defaultSubmitLabel ||
      createEventSubmitButton.textContent;
  }
  if (activateWrapper) {
    activateWrapper.classList.remove("is-hidden");
  }
  if (activateCheckbox) {
    activateCheckbox.disabled = false;
  }
  cancelEventEditButton?.classList.add("is-hidden");
}

function exitEventEditMode(options = {}) {
  const { resetForm = true } = options;
  eventState.editingEventId = null;
  if (resetForm && createEventForm) {
    createEventForm.reset();
  }
  resetEventFormPresentation();
  clearStatus(createEventSubmitButton);
}

function enterEventEditMode(eventId) {
  if (!createEventForm) {
    return;
  }
  const event = eventState.events.find((item) => item.id === eventId);
  if (!event) {
    return;
  }

  eventState.editingEventId = eventId;

  if (eventTitleInput) {
    eventTitleInput.value = event.title || "";
  }
  if (eventDescriptionInput) {
    eventDescriptionInput.value = event.description || "";
  }
  if (eventDateInput) {
    eventDateInput.value = toDateTimeLocalValue(event.event_date);
  }
  if (delegateDeadlineInput) {
    delegateDeadlineInput.value = toDateTimeLocalValue(event.delegate_deadline);
  }
  ensureDelegateLimitOption(event.delegate_limit);
  if (delegateLimitSelect && Number.isFinite(event.delegate_limit)) {
    delegateLimitSelect.value = String(event.delegate_limit);
  }

  if (activateCheckbox) {
    activateCheckbox.checked = false;
    activateCheckbox.disabled = true;
  }
  if (activateWrapper) {
    activateWrapper.classList.add("is-hidden");
  }

  cancelEventEditButton?.classList.remove("is-hidden");
  if (createEventSubmitButton) {
    createEventSubmitButton.textContent = "Változtatások mentése";
  }
  if (createEventTitle) {
    createEventTitle.textContent = editFormTitle;
  }
  if (createEventHint) {
    createEventHint.textContent = editFormHint;
  }

  setStatus(`"${event.title}" szerkesztése folyamatban.`, "", createEventSubmitButton);
  if (eventTitleInput) {
    eventTitleInput.focus();
    eventTitleInput.select();
  }
  if (typeof window?.scrollTo === "function") {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function setStatus(message, type = "", anchor = null) {
  if (anchor) {
    updateActionStatus(anchor, message, type);
    return;
  }
  if (!adminStatus) {
    return;
  }
  adminStatus.textContent = message || "";
  adminStatus.classList.remove("error", "success");
  if (type) {
    adminStatus.classList.add(type);
  }
}

function clearStatus(anchor = null) {
  setStatus("", "", anchor);
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

function handleAuthError(error, anchor = null) {
  const message = error?.message || "Ismeretlen hiba történt.";
  setStatus(message, "error", anchor);
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

function uniqueIdList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  values.forEach((value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || seen.has(parsed)) {
      return;
    }
    seen.add(parsed);
    result.push(parsed);
  });
  return result;
}

function normalizeIdList(values) {
  return uniqueIdList(values).sort((a, b) => a - b);
}

function sameIdSet(first, second) {
  if (first.length !== second.length) {
    return false;
  }
  return first.every((value, index) => value === second[index]);
}

function memberStatus(member, organizationPaid) {
  if (member.is_admin) {
    return "Adminisztrátor";
  }
  if (member.is_contact) {
    return "Kapcsolattartó";
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

function getExpandedOrganizationIds() {
  const expandedCards = document.querySelectorAll(
    ".organization-card.expanded[data-org-id]",
  );
  return Array.from(expandedCards)
    .map((card) => Number(card.getAttribute("data-org-id")))
    .filter(Number.isFinite);
}

async function loadOrganizations(options = {}) {
  if (!ensureAdminSession(true)) {
    return;
  }
  const { expandOrgIds = null, pendingStatus = null } = options;
  const expandedOrgIds = Array.isArray(expandOrgIds)
    ? expandOrgIds.map((id) => Number(id)).filter(Number.isFinite)
    : getExpandedOrganizationIds();
  clearStatus();
  try {
    const data = await requestJSON("/api/admin/organizations");
    renderOrganizations(data, { expandedOrgIds, pendingStatus });
  } catch (error) {
    handleAuthError(error);
  }
}

function renderOrganizations(items, options = {}) {
  const { expandedOrgIds = [], pendingStatus = null } = options;
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
    card.classList.add("organization-card", "collapsible", "collapsed");
    card.setAttribute("data-org-id", org.id);

    const bodyId = `organization-body-${org.id}`;
    const orgBody = document.createElement("div");
    orgBody.classList.add("organization-body", "collapsible-body");
    orgBody.id = bodyId;
    orgBody.hidden = true;

    const header = document.createElement("header");
    header.classList.add("organization-head", "collapsible-header");

    const titleWrap = document.createElement("div");
    titleWrap.classList.add("organization-title");
    const title = document.createElement("h3");
    title.textContent = org.name;
    const subtitle = document.createElement("p");
    subtitle.classList.add("muted");
    subtitle.textContent = `${org.member_count} tag`;
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.classList.add("collapse-toggle");
    collapseButton.setAttribute("aria-expanded", "false");
    collapseButton.setAttribute("aria-controls", bodyId);
    collapseButton.setAttribute("data-collapsed-label", "Részletek megnyitása");
    collapseButton.setAttribute("data-expanded-label", "Részletek elrejtése");
    const collapseText = document.createElement("span");
    collapseText.classList.add("collapse-toggle-label");
    collapseText.setAttribute("data-collapse-text", "");
    const collapseIcon = document.createElement("span");
    collapseIcon.classList.add("chevron-icon");
    collapseIcon.setAttribute("aria-hidden", "true");
    collapseButton.appendChild(collapseText);
    collapseButton.appendChild(collapseIcon);

    const controls = document.createElement("div");
    controls.classList.add("organization-controls");

    const feeBadge = document.createElement("span");
    feeBadge.classList.add("badge", org.fee_paid ? "badge-success" : "badge-warning");
    feeBadge.textContent = org.fee_paid
      ? "Tagsági díj rendezve"
      : "Tagsági díj rendezetlen";

    const feeToggleButton = document.createElement("button");
    feeToggleButton.classList.add("primary-btn");
    feeToggleButton.type = "button";
    feeToggleButton.textContent = org.fee_paid
      ? "Fizetetlenre állítom"
      : "Fizetettre állítom";
    feeToggleButton.addEventListener("click", async () => {
      try {
        await requestJSON(`/api/admin/organizations/${org.id}/fee`, {
          method: "POST",
          body: JSON.stringify({ fee_paid: !org.fee_paid }),
        });
        setStatus("Tagsági díj státusz frissítve.", "success", feeToggleButton);
        await loadOrganizations();
      } catch (error) {
        handleAuthError(error, feeToggleButton);
      }
    });

    controls.appendChild(feeBadge);
    controls.appendChild(feeToggleButton);

    const headActions = document.createElement("div");
    headActions.classList.add("organization-head-actions");
    headActions.appendChild(collapseButton);
    headActions.appendChild(controls);

    header.appendChild(titleWrap);
    header.appendChild(headActions);

    const bankSection = document.createElement("section");
    bankSection.classList.add("organization-bank");

    const bankTitle = document.createElement("h4");
    bankTitle.textContent = "Banki adatok";
    bankSection.appendChild(bankTitle);

    const bankDetails = document.createElement("dl");
    bankDetails.classList.add("bank-details");

    const createBankRow = (label, value) => {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value || "Nincs megadva";
      wrapper.appendChild(term);
      wrapper.appendChild(detail);
      return wrapper;
    };

    bankDetails.appendChild(
      createBankRow("Bank neve", org.bank_name || "Nincs megadva"),
    );
    bankDetails.appendChild(
      createBankRow("Bankszámlaszám", org.bank_account_number || "Nincs megadva"),
    );
    const instructionsValue = org.payment_instructions || org.name || "Nincs megadva";
    bankDetails.appendChild(createBankRow("Közlemény", instructionsValue));

    bankSection.appendChild(bankDetails);

    const bankNote = document.createElement("p");
    bankNote.classList.add("muted", "small-print");
    bankNote.innerHTML =
      'A banki adatokat minden szervezet azonosan használja. Módosításuk a <a href="/admin/beallitasok">Beállítások</a> oldalon történik, a közlemény mező automatikusan a szervezet nevét tartalmazza.';
    bankSection.appendChild(bankNote);

    const contactSection = document.createElement("section");
    contactSection.classList.add("organization-contact");

    const contactTitle = document.createElement("h4");
    contactTitle.textContent = "Kapcsolattartó";
    contactSection.appendChild(contactTitle);

    const contactStatus = org.contact?.status || "missing";
    let contactSubmit = null;
    if (contactStatus === "assigned" && org.contact?.user) {
      const contactUser = org.contact.user;
      const contactInfo = document.createElement("p");
      contactInfo.innerHTML = `${formatDisplayName(
        contactUser.first_name,
        contactUser.last_name,
        contactUser.email,
      )} <span class="muted">(${contactUser.email})</span>`;
      contactSection.appendChild(contactInfo);

      const contactHint = document.createElement("p");
      contactHint.classList.add("muted");
      contactHint.textContent =
        "Új kapcsolattartó meghívásához először töröld a meglévő felhasználót.";
      contactSection.appendChild(contactHint);
    } else {
      const contactMessage = document.createElement("p");
      contactMessage.classList.add("muted");
      if (contactStatus === "invited" && org.contact?.invitation) {
        const created = formatDateTime(org.contact.invitation.created_at);
        contactMessage.textContent = created
          ? `Folyamatban lévő meghívó: ${org.contact.invitation.email} (${created}).`
          : `Folyamatban lévő meghívó: ${org.contact.invitation.email}.`;
      } else {
        contactMessage.textContent = "Még nincs kapcsolattartó hozzárendelve ehhez a szervezethez.";
      }
      contactSection.appendChild(contactMessage);

      const contactForm = document.createElement("form");
      contactForm.classList.add("organization-contact-form");

      const contactEmailLabel = document.createElement("label");
      contactEmailLabel.setAttribute("for", `contact-email-${org.id}`);
      contactEmailLabel.textContent = "Kapcsolattartó e-mail címe";
      const contactEmailInput = document.createElement("input");
      contactEmailInput.id = `contact-email-${org.id}`;
      contactEmailInput.type = "email";
      contactEmailInput.required = true;
      contactEmailInput.placeholder = "pelda@email.hu";

      const contactFirstLabel = document.createElement("label");
      contactFirstLabel.setAttribute("for", `contact-first-${org.id}`);
      contactFirstLabel.textContent = "Keresztnév (opcionális)";
      const contactFirstInput = document.createElement("input");
      contactFirstInput.id = `contact-first-${org.id}`;
      contactFirstInput.type = "text";

      const contactLastLabel = document.createElement("label");
      contactLastLabel.setAttribute("for", `contact-last-${org.id}`);
      contactLastLabel.textContent = "Vezetéknév (opcionális)";
      const contactLastInput = document.createElement("input");
      contactLastInput.id = `contact-last-${org.id}`;
      contactLastInput.type = "text";

      const contactActions = document.createElement("div");
      contactActions.classList.add("organization-contact-actions");
      contactSubmit = document.createElement("button");
      contactSubmit.type = "submit";
      contactSubmit.classList.add("primary-btn");
      contactSubmit.textContent =
        contactStatus === "invited" ? "Meghívó újraküldése" : "Kapcsolattartó meghívása";
      contactActions.appendChild(contactSubmit);

      if (contactStatus === "invited" && org.contact?.invitation?.id) {
        const cancelInvite = document.createElement("button");
        cancelInvite.type = "button";
        cancelInvite.classList.add("ghost-btn");
        cancelInvite.textContent = "Meghívó visszavonása";
        cancelInvite.addEventListener("click", async () => {
          try {
            await requestJSON(
              `/api/admin/organizations/${org.id}/contact-invitations/${org.contact.invitation.id}`,
              { method: "DELETE" },
            );
            setStatus("Kapcsolattartó meghívó visszavonva.", "success", cancelInvite);
            await loadOrganizations();
          } catch (error) {
            handleAuthError(error, cancelInvite);
          }
        });
        contactActions.appendChild(cancelInvite);
      }

      contactForm.appendChild(contactEmailLabel);
      contactForm.appendChild(contactEmailInput);
      contactForm.appendChild(contactFirstLabel);
      contactForm.appendChild(contactFirstInput);
      contactForm.appendChild(contactLastLabel);
      contactForm.appendChild(contactLastInput);
      contactForm.appendChild(contactActions);

      contactForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          const detail = await requestJSON(
            `/api/admin/organizations/${org.id}/contact-invitations`,
            {
              method: "POST",
              body: JSON.stringify({
                email: contactEmailInput.value,
                first_name: contactFirstInput.value,
                last_name: contactLastInput.value,
                role: "contact",
              }),
            },
          );
          const contactStatus = detail?.contact?.status;
          const successMessage =
            contactStatus === "assigned"
              ? "Kapcsolattartó sikeresen beállítva."
              : "Kapcsolattartó meghívó elküldve.";
          setStatus(successMessage, "success", contactSubmit);
          await loadOrganizations({
            expandOrgIds: [org.id],
            pendingStatus: {
              orgId: org.id,
              target: "contact",
              type: "success",
              message: successMessage,
            },
          });
        } catch (error) {
          handleAuthError(error, contactSubmit);
        }
      });

      contactSection.appendChild(contactForm);
    }

    const invitationSection = document.createElement("section");
    invitationSection.classList.add("organization-invitations");

    const invitationTitle = document.createElement("h4");
    invitationTitle.textContent = "Függő meghívók";
    invitationSection.appendChild(invitationTitle);

    const pendingInvites = Array.isArray(org.pending_invitations)
      ? org.pending_invitations
      : [];
    if (!pendingInvites.length) {
      const emptyInvites = document.createElement("p");
      emptyInvites.classList.add("muted");
      emptyInvites.textContent = "Nincs folyamatban lévő tagmeghívó.";
      invitationSection.appendChild(emptyInvites);
    } else {
      const inviteTable = document.createElement("table");
      inviteTable.classList.add("organization-invitations-table");
      inviteTable.innerHTML = `
        <thead>
          <tr>
            <th>E-mail</th>
            <th>Szerepkör</th>
            <th>Meghívva</th>
          </tr>
        </thead>
      `;
      const inviteBody = document.createElement("tbody");
      pendingInvites.forEach((invite) => {
        const row = document.createElement("tr");
        const emailCell = document.createElement("td");
        emailCell.textContent = invite.email;
        const roleCell = document.createElement("td");
        roleCell.textContent = invite.role === "contact" ? "Kapcsolattartó" : "Tag";
        const createdCell = document.createElement("td");
        createdCell.textContent = formatDateTime(invite.created_at) || "";
        row.appendChild(emailCell);
        row.appendChild(roleCell);
        row.appendChild(createdCell);
        inviteBody.appendChild(row);
      });
      inviteTable.appendChild(inviteBody);
      invitationSection.appendChild(inviteTable);
    }

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
            setStatus("Felhasználó törölve.", "success", deleteButton);
            await loadOrganizations();
          } catch (error) {
            handleAuthError(error, deleteButton);
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
        setStatus("Szervezet törölve.", "success", deleteButton);
        await loadOrganizations();
      } catch (error) {
        handleAuthError(error, deleteButton);
      }
    });

    footer.appendChild(deleteButton);

    orgBody.appendChild(bankSection);
    orgBody.appendChild(contactSection);
    orgBody.appendChild(invitationSection);
    orgBody.appendChild(membersSection);
    orgBody.appendChild(footer);

    card.appendChild(header);
    card.appendChild(orgBody);
    const shouldExpand = expandedOrgIds.includes(org.id);
    attachCollapsible(card, collapseButton, orgBody, shouldExpand);

    if (pendingStatus?.orgId === org.id && pendingStatus.message) {
      const statusAnchor = contactSubmit || collapseButton;
      setStatus(pendingStatus.message, pendingStatus.type, statusAnchor);
    }

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

function initAddOrganizationCollapsible() {
  const section = document.querySelector('[data-collapsible="add-organization"]');
  if (!section) {
    return;
  }
  const trigger = section.querySelector("[data-collapse-toggle]");
  const body = section.querySelector("[data-collapse-body]");
  attachCollapsible(section, trigger, body);
}

async function initOrganizationsPage() {
  if (!ensureAdminSession()) {
    return;
  }
  initAddOrganizationCollapsible();
  await loadOrganizations();

  const addOrganizationForm = document.querySelector("#add-organization-form");
  const refreshButton = document.querySelector("[data-admin-refresh]");

  addOrganizationForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ensureAdminSession(true)) {
      return;
    }
    const submitButton = addOrganizationForm.querySelector(
      'button[type="submit"]',
    );
    const formData = new FormData(addOrganizationForm);
    const payload = {
      name: formData.get("name"),
    };
    try {
      await requestJSON("/api/admin/organizations", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setStatus("Új szervezet hozzáadva.", "success", submitButton);
      addOrganizationForm.reset();
      await loadOrganizations();
    } catch (error) {
      handleAuthError(error, submitButton);
    }
  });

  refreshButton?.addEventListener("click", async () => {
    await loadOrganizations();
  });
}

async function loadPending(options = {}) {
  if (!ensureAdminSession(true)) {
    return false;
  }
  const { silent = false, anchor = null } = options || {};
  if (!silent) {
    clearStatus(anchor);
  }
  try {
    const users = await requestJSON("/api/admin/pending");
    renderPending(users);
    return true;
  } catch (error) {
    handleAuthError(error, anchor);
    return false;
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
      await decideRegistration(user.id, true, approveButton);
    });

    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.classList.add("ghost-btn");
    rejectButton.textContent = "Elutasítás";
    rejectButton.addEventListener("click", async () => {
      await decideRegistration(user.id, false, rejectButton);
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

async function decideRegistration(userId, approve, anchor) {
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
      anchor,
    );
    await loadPending({ silent: true });
  } catch (error) {
    handleAuthError(error, anchor);
  }
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
    if (eventState.selectedEventId === event.id) {
      card.classList.add("event-card-selected");
    }
    const isExpanded = eventState.expandedEventId === event.id;
    card.classList.toggle("event-card-expanded", isExpanded);
    card.classList.toggle("event-card-collapsed", !isExpanded);
    card.dataset.eventId = String(event.id);

    const header = document.createElement("header");
    header.classList.add("event-head");

    const headContent = document.createElement("div");
    headContent.classList.add("event-head-main");

    const headline = document.createElement("div");
    headline.classList.add("event-headline");

    const title = document.createElement("h3");
    title.textContent = event.title;
    headline.appendChild(title);

    const badge = document.createElement("span");
    badge.classList.add("badge");
    const votingEnabled = Boolean(event.is_voting_enabled);
    badge.classList.add(votingEnabled ? "badge-success" : "badge-muted");
    badge.textContent = votingEnabled ? "Aktív" : "Inaktív";
    headline.appendChild(badge);

    headContent.appendChild(headline);

    const summary = document.createElement("p");
    summary.classList.add("muted", "event-head-summary");
    const summaryParts = [];
    const eventDateLabel = formatDateTime(event.event_date);
    if (eventDateLabel) {
      summaryParts.push(`Időpont: ${eventDateLabel}`);
    }
    const deadlineLabel = formatDateTime(event.delegate_deadline);
    if (deadlineLabel) {
      summaryParts.push(`Delegált határidő: ${deadlineLabel}`);
    }
    summaryParts.push(`Összes delegált: ${event.delegate_count}`);
    if (event.delegate_limit) {
      summaryParts.push(`Keret: ${event.delegate_limit}/szervezet`);
    }
    summary.textContent =
      summaryParts.filter(Boolean).join(" • ") ||
      "Nyisd meg a kártyát a részletek megtekintéséhez.";
    headContent.appendChild(summary);

    header.appendChild(headContent);

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.classList.add("collapse-toggle", "event-card-toggle");
    toggleButton.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    const toggleLabel = document.createElement("span");
    toggleLabel.classList.add("collapse-toggle-label");
    toggleLabel.textContent = isExpanded
      ? "Esemény bezárása"
      : "Esemény megnyitása";
    const toggleChevron = document.createElement("span");
    toggleChevron.classList.add("chevron-icon");
    toggleButton.appendChild(toggleLabel);
    toggleButton.appendChild(toggleChevron);
    toggleButton.addEventListener("click", () => {
      toggleEventCard(event.id);
    });
    header.appendChild(toggleButton);

    const body = document.createElement("div");
    body.classList.add("event-card-body");
    body.hidden = !isExpanded;

    const description = document.createElement("p");
    description.classList.add("muted");
    description.textContent = event.description || "Nincs megadott leírás.";

    const meta = document.createElement("p");
    meta.classList.add("event-meta");
    const createdLabel = event.created_at
      ? eventDateFormatter.format(new Date(event.created_at))
      : "Ismeretlen időpont";
    const delegateSummary = event.delegate_limit
      ? `Összes delegált: ${event.delegate_count} • ${event.delegate_limit}/szervezet`
      : `Összes delegált: ${event.delegate_count}`;
    const codeSummary = event.access_codes_total
      ? `Belépőkódok: ${Math.max(event.access_codes_available || 0, 0)}/${event.access_codes_total}`
      : "Belépőkódok: nincs";
    meta.textContent = `Létrehozva: ${createdLabel} • ${delegateSummary} • ${codeSummary}`;

    const details = document.createElement("ul");
    details.classList.add("event-details");
    if (eventDateLabel) {
      const item = document.createElement("li");
      item.textContent = `Esemény időpontja: ${eventDateLabel}`;
      details.appendChild(item);
    }
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
      ? `Delegált keret: szervezetenként legfeljebb ${event.delegate_limit}`
      : "Delegált keret: nincs felső határ";
    details.appendChild(limitItem);
    const lockItem = document.createElement("li");
    if (event.delegates_locked) {
      lockItem.textContent = "Delegált módosítás: zárolva";
    } else if (event.delegate_lock_mode === "unlocked") {
      lockItem.textContent = "Delegált módosítás: kézi feloldás aktív";
    } else {
      lockItem.textContent = "Delegált módosítás: engedélyezett";
    }
    details.appendChild(lockItem);
    const codeItem = document.createElement("li");
    if (event.access_codes_total) {
      codeItem.textContent = `Belépőkódok: ${Math.max(event.access_codes_available || 0, 0)} / ${event.access_codes_total}`;
    } else {
      codeItem.textContent = "Belépőkódok: még nincs generálva";
    }
    details.appendChild(codeItem);

    const actions = document.createElement("div");
    actions.classList.add("event-actions");

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.classList.add("ghost-btn");
    editButton.textContent = "Szerkesztés";
    editButton.addEventListener("click", () => {
      enterEventEditMode(event.id);
    });
    actions.appendChild(editButton);

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
    const accessToggleLabel = document.createElement("span");
    accessToggleLabel.textContent = "Szavazási felület engedélyezése";
    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(accessToggleLabel);
    actions.appendChild(toggleWrapper);

    if (!event.is_active) {
      const activateButton = document.createElement("button");
      activateButton.type = "button";
      activateButton.classList.add("primary-btn");
      activateButton.textContent = "Aktiválás";
      activateButton.addEventListener("click", async () => {
        await handleEventActivation(event.id, activateButton);
      });
      actions.appendChild(activateButton);
    } else {
      const activeLabel = document.createElement("span");
      activeLabel.classList.add("muted");
      activeLabel.textContent = event.is_voting_enabled
        ? "Ez az esemény jelenleg aktív."
        : "Ez az esemény jelenleg inaktív a szavazási felületen.";
      actions.appendChild(activeLabel);
    }

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.classList.add("danger-btn");
    deleteButton.textContent = "Esemény törlése";
    const canDeleteEvent = Boolean(event.can_delete);
    deleteButton.disabled = !canDeleteEvent;
    deleteButton.title = canDeleteEvent
      ? ""
      : "Kapcsold ki a szavazási felületet az esemény törlése előtt.";
    deleteButton.addEventListener("click", async () => {
      await handleEventDeletion(event, deleteButton);
    });
    actions.appendChild(deleteButton);

    const delegateButton = document.createElement("button");
    delegateButton.type = "button";
    delegateButton.classList.add("primary-btn", "delegate-manage-trigger");
    const isSelected = eventState.selectedEventId === event.id;
    delegateButton.textContent = isSelected
      ? "Delegáltak bezárása"
      : "Delegáltak kezelése";
    delegateButton.setAttribute(
      "aria-pressed",
      isSelected ? "true" : "false",
    );
    delegateButton.addEventListener("click", async () => {
      if (eventState.selectedEventId === event.id) {
        closeDelegatePanel();
        return;
      }
      await openDelegatePanelForEvent(event.id);
    });
    actions.appendChild(delegateButton);

    body.appendChild(description);
    body.appendChild(meta);
    body.appendChild(details);
    body.appendChild(actions);

    const delegateHost = document.createElement("div");
    delegateHost.classList.add("delegate-panel-host");
    delegateHost.dataset.delegateHost = String(event.id);
    body.appendChild(delegateHost);

    card.appendChild(header);
    card.appendChild(body);

    eventListContainer.appendChild(card);
  });
}

function currentDelegateInfo(organizationId) {
  return eventState.delegates.find((item) => item.organization_id === organizationId) || null;
}

function renderSelectedEventInfo() {
  if (!selectedEventInfo) {
    return;
  }
  if (!eventState.selectedEventId) {
    selectedEventInfo.textContent =
      "Válaszd ki egy esemény kártyáján a „Delegáltak kezelése” gombot a részletek megjelenítéséhez.";
    if (delegatePanelRefreshButton) {
      delegatePanelRefreshButton.disabled = true;
    }
    return;
  }
  const event = getSelectedEvent();
  if (!event) {
    selectedEventInfo.textContent =
      "Válaszd ki egy esemény kártyáján a „Delegáltak kezelése” gombot a részletek megjelenítéséhez.";
    if (delegatePanelRefreshButton) {
      delegatePanelRefreshButton.disabled = true;
    }
    return;
  }
  const parts = [];
  parts.push(event.title);
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
  parts.push(`Összes delegált: ${assignedCount}`);
  if (event.delegate_limit) {
    parts.push(`Keret: ${event.delegate_limit}/szervezet`);
  }
  if (event.access_codes_total) {
    parts.push(
      `Belépőkódok: ${Math.max(event.access_codes_available || 0, 0)}/${event.access_codes_total}`,
    );
  }
  if (event.delegates_locked) {
    parts.push("Delegált módosítás: zárolva");
  } else if (event.delegate_lock_mode === "unlocked") {
    parts.push("Delegált módosítás: kézi feloldás aktív");
  } else {
    parts.push("Delegált módosítás: engedélyezett");
  }
  selectedEventInfo.textContent = parts.join(" • ");
  if (delegatePanelRefreshButton) {
    delegatePanelRefreshButton.disabled = false;
  }
}

function renderAccessCodePanel() {
  if (
    !delegateCodeSummary ||
    !delegateCodeList ||
    !delegateGenerateCodesButton ||
    !delegateDownloadCodesButton
  ) {
    return;
  }

  setDelegateCodeStatus("");

  if (!eventState.selectedEventId) {
    delegateCodeSummary.textContent =
      "Nyisd meg a megfelelő esemény kártyáját a belépőkódok kezeléséhez.";
    delegateGenerateCodesButton.disabled = true;
    delegateDownloadCodesButton.disabled = true;
    delegateCodeList.innerHTML = "";
    const placeholder = document.createElement("p");
    placeholder.classList.add("muted");
    placeholder.textContent = "Nincs kiválasztott esemény.";
    delegateCodeList.appendChild(placeholder);
    return;
  }

  delegateGenerateCodesButton.disabled = false;
  const summary = eventState.accessCodeSummary;
  const codes = Array.isArray(summary?.codes) ? summary.codes : [];
  const total = Number(summary?.total || 0);
  const available = Number(summary?.available || 0);
  const used = Number(summary?.used || 0);
  delegateDownloadCodesButton.disabled = !codes.length;

  delegateCodeSummary.textContent = codes.length
    ? `Összes kód: ${total} • Felhasználható: ${available} • Felhasznált: ${used}`
    : "Még nincs generált belépőkód.";

  delegateCodeList.innerHTML = "";
  if (!codes.length) {
    const empty = document.createElement("p");
    empty.classList.add("muted");
    empty.textContent = "A kiválasztott eseményhez még nem készült belépőkódkészlet.";
    delegateCodeList.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.classList.add("code-grid");
  codes.forEach((codeInfo) => {
    const item = document.createElement("li");
    item.classList.add("code-card");
    if (codeInfo?.used_at) {
      item.classList.add("is-used");
    }

    const value = document.createElement("span");
    value.classList.add("code-value");
    value.textContent = codeInfo?.code || "";
    item.appendChild(value);

    const meta = document.createElement("span");
    meta.classList.add("code-meta");
    if (codeInfo?.used_at) {
      const usedAt = formatDateTime(codeInfo.used_at);
      const usedBy = codeInfo?.used_by || {};
      const nameParts = [];
      if (usedBy.last_name) {
        nameParts.push(usedBy.last_name);
      }
      if (usedBy.first_name) {
        nameParts.push(usedBy.first_name);
      }
      const displayName = nameParts.join(" ") || usedBy.email || "Ismeretlen felhasználó";
      meta.textContent = usedAt
        ? `Felhasználva: ${usedAt} – ${displayName}`
        : `Felhasználva – ${displayName}`;
    } else {
      meta.textContent = "Még nem használták fel.";
    }
    item.appendChild(meta);

    list.appendChild(item);
  });

  delegateCodeList.appendChild(list);
}

async function refreshAccessCodes() {
  if (!ensureAdminSession(true)) {
    return;
  }
  if (!eventState.selectedEventId) {
    eventState.accessCodes = [];
    eventState.accessCodeSummary = null;
    renderAccessCodePanel();
    return;
  }
  try {
    const response = await requestJSON(
      `/api/admin/events/${eventState.selectedEventId}/codes`,
    );
    eventState.accessCodes = Array.isArray(response?.codes) ? response.codes : [];
    eventState.accessCodeSummary = response || null;
  } catch (error) {
    eventState.accessCodes = [];
    eventState.accessCodeSummary = null;
    handleAuthError(error);
  }
  renderAccessCodePanel();
}

function renderDelegateLockControls() {
  if (!delegateLockModeSelect || !delegateLockApplyButton || !delegateLockMessage) {
    return;
  }
  const event = getSelectedEvent();
  if (!event) {
    delegateLockModeSelect.value = "auto";
    delegateLockModeSelect.disabled = true;
    delegateLockApplyButton.disabled = true;
    delegateLockMessage.textContent =
      "Nyisd meg a kívánt eseményt a „Delegáltak kezelése” gombbal a zárolási állapot módosításához.";
    delegateLockMessage.classList.remove("success", "error");
    return;
  }

  delegateLockModeSelect.disabled = false;
  delegateLockApplyButton.disabled = false;
  const mode = event.delegate_lock_mode || "auto";
  delegateLockModeSelect.value = mode;
  const message = event.delegate_lock_message || "";
  delegateLockMessage.textContent = message;
  delegateLockMessage.classList.remove("success", "error");
  if (event.delegates_locked) {
    delegateLockMessage.classList.add("error");
  } else if (mode === "unlocked") {
    delegateLockMessage.classList.add("success");
  }
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
    cell.textContent =
      "Nyisd meg a kezelendő esemény kártyáját a „Delegáltak kezelése” gombbal.";
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
  const delegatesLocked = Boolean(selectedEvent?.delegates_locked);

  eventState.organizations.forEach((organization) => {
    const info = currentDelegateInfo(organization.id);
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = organization.name;

    const delegateCell = document.createElement("td");
    const delegateNames = info?.delegates?.map((delegate) =>
      formatDisplayName(
        delegate.user_first_name,
        delegate.user_last_name,
        delegate.user_email,
      ),
    ).filter(Boolean);
    if (delegateNames && delegateNames.length) {
      delegateCell.textContent = delegateNames.join(", ");
    } else {
      delegateCell.classList.add("muted");
      delegateCell.textContent = "Nincs kijelölt delegált";
    }

    const selectCell = document.createElement("td");
    const selector = document.createElement("div");
    selector.classList.add("delegate-selector");
    selector.dataset.delegateSelector = "1";
    selector.dataset.organizationId = String(organization.id);

    const selectedIds = uniqueIdList(
      (info?.delegates || []).map((delegate) => delegate.user_id),
    );
    selector.dataset.previousSelection = JSON.stringify(selectedIds);

    if (delegateLimit) {
      const hint = document.createElement("p");
      hint.classList.add("delegate-limit-hint", "muted");
      hint.textContent = `Max. ${delegateLimit} delegált / szervezet`;
      selector.appendChild(hint);
    }

    const eligibleMembers = eligibleDelegatesForOrganization(organization);
    if (!eligibleMembers.length) {
      const empty = document.createElement("p");
      empty.classList.add("muted");
      empty.textContent = "Nincs kijelölhető tag";
      selector.appendChild(empty);
    } else {
      eligibleMembers.forEach((member) => {
        const label = document.createElement("label");
        label.classList.add("delegate-checkbox");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = String(member.id);
        checkbox.checked = selectedIds.includes(member.id);
        checkbox.disabled = delegatesLocked;
        if (!delegatesLocked) {
          checkbox.addEventListener("change", async () => {
            await handleDelegateSelection(organization.id, checkbox);
          });
        }

        const span = document.createElement("span");
        span.textContent = formatDisplayName(
          member.first_name,
          member.last_name,
          member.email,
        );

        label.appendChild(checkbox);
        label.appendChild(span);
        selector.appendChild(label);
      });
    }

    const status = document.createElement("p");
    status.classList.add("status", "delegate-status");
    if (delegatesLocked) {
      status.textContent =
        selectedEvent?.delegate_lock_message ||
        "A delegáltak kiosztása lezárult ehhez az eseményhez.";
      status.classList.add("error");
    } else if (selectedEvent?.delegate_lock_mode === "unlocked" && selectedEvent?.delegate_lock_message) {
      status.textContent = selectedEvent.delegate_lock_message;
      status.classList.add("success");
    }
    selector.appendChild(status);

    selectCell.appendChild(selector);

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
    renderSelectedEventInfo();
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

async function refreshEventData(refreshOrganizations = false, preserveStatus = false) {
  if (!ensureAdminSession(true)) {
    return;
  }
  if (!preserveStatus) {
    clearStatus();
  }
  try {
    if (refreshOrganizations || !eventState.organizations.length) {
      const organizations = await requestJSON("/api/admin/organizations");
      eventState.organizations = Array.isArray(organizations) ? organizations : [];
    }
    const events = await requestJSON("/api/admin/events");
    eventState.events = Array.isArray(events) ? events : [];

    if (
      eventState.editingEventId &&
      !eventState.events.some((event) => event.id === eventState.editingEventId)
    ) {
      exitEventEditMode();
    }

    if (!eventState.events.length) {
      eventState.selectedEventId = null;
      eventState.expandedEventId = null;
      eventState.delegates = [];
      eventState.accessCodes = [];
      eventState.accessCodeSummary = null;
      delegatePanelDismissed = false;
      renderEventsList(eventState.events);
      renderSelectedEventInfo();
      renderDelegateTable();
      renderDelegateLockControls();
      renderAccessCodePanel();
      detachDelegatePanel();
      return;
    }

    const hasSelectedEvent =
      Number.isFinite(eventState.selectedEventId) &&
      eventState.events.some((event) => event.id === eventState.selectedEventId);

    if (!hasSelectedEvent) {
      if (delegatePanelDismissed) {
        eventState.selectedEventId = null;
      } else {
        const activeEvent = eventState.events.find((event) => event.is_active);
        eventState.selectedEventId = activeEvent ? activeEvent.id : eventState.events[0].id;
        delegatePanelDismissed = false;
      }
    }

    const hasExpandedEvent =
      Number.isFinite(eventState.expandedEventId) &&
      eventState.events.some((event) => event.id === eventState.expandedEventId);
    if (!hasExpandedEvent) {
      eventState.expandedEventId = eventState.selectedEventId;
    }

    await refreshEventDelegates();
    await refreshAccessCodes();

    renderEventsList(eventState.events);
    renderDelegateTable();
    renderDelegateLockControls();
    renderAccessCodePanel();
    mountDelegatePanel();
  } catch (error) {
    handleAuthError(error);
  }
}

async function handleEventActivation(eventId, anchor) {
  if (!ensureAdminSession(true)) {
    return;
  }
  try {
    await requestJSON(`/api/admin/events/${eventId}/activate`, {
      method: "POST",
    });
    eventState.selectedEventId = eventId;
    delegatePanelDismissed = false;
    setStatus("Az esemény aktívvá vált.", "success", anchor);
    await refreshEventData();
  } catch (error) {
    handleAuthError(error, anchor);
  }
}

async function handleEventDeletion(event, anchor) {
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
    setStatus("Szavazási esemény törölve.", "success", anchor);
    await refreshEventData();
  } catch (error) {
    handleAuthError(error, anchor);
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
      toggleElement,
    );
    await refreshEventData();
  } catch (error) {
    toggleElement.checked = !desired;
    handleAuthError(error, toggleElement);
  }
}

async function handleDelegateSelection(organizationId, checkboxElement) {
  if (!ensureAdminSession(true)) {
    checkboxElement.checked = !checkboxElement.checked;
    return;
  }

  const selector = checkboxElement.closest("[data-delegate-selector]");
  if (!selector) {
    return;
  }

  const selectedValues = Array.from(
    selector.querySelectorAll('input[type="checkbox"]:checked'),
  ).map((input) => input.value);
  const desiredIds = uniqueIdList(selectedValues);
  const normalizedDesired = normalizeIdList(desiredIds);

  const selectedEvent = getSelectedEvent();
  const delegateLimit = selectedEvent?.delegate_limit ?? null;
  if (
    delegateLimit !== null &&
    delegateLimit > 0 &&
    desiredIds.length > delegateLimit
  ) {
    checkboxElement.checked = false;
    setStatus(
      `Legfeljebb ${delegateLimit} delegált jelölhető szervezetenként.`,
      "error",
      selector,
    );
    return;
  }

  const previous = currentDelegateInfo(organizationId);
  const previousIds = uniqueIdList(
    (previous?.delegates || []).map((delegate) => delegate.user_id),
  );
  const normalizedPrevious = normalizeIdList(previousIds);

  if (sameIdSet(normalizedPrevious, normalizedDesired)) {
    return;
  }

  const payload = { user_ids: desiredIds };
  selector.dataset.previousSelection = JSON.stringify(previousIds);

  try {
    await requestJSON(
      `/api/admin/events/${eventState.selectedEventId}/organizations/${organizationId}/delegates`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    selector.dataset.previousSelection = JSON.stringify(desiredIds);
    setStatus("A delegáltlista frissítve.", "success", selector);
    await refreshEventDelegates();
    renderDelegateTable();
    renderSelectedEventInfo();
  } catch (error) {
    handleAuthError(error, selector);
    const fallback = uniqueIdList(
      JSON.parse(selector.dataset.previousSelection || "[]"),
    );
    selector
      .querySelectorAll('input[type="checkbox"]')
      .forEach((input) => {
        const id = Number.parseInt(input.value, 10);
        input.checked = fallback.includes(id);
      });
    await refreshEventDelegates();
    renderDelegateTable();
    renderSelectedEventInfo();
  }
}

async function handleDelegateLockApply() {
  if (!ensureAdminSession(true)) {
    return;
  }
  const event = getSelectedEvent();
  if (!event || !delegateLockModeSelect) {
    return;
  }
  const mode = delegateLockModeSelect.value;
  if (!["auto", "locked", "unlocked"].includes(mode)) {
    setStatus("Érvénytelen zárolási mód.", "error", delegateLockApplyButton);
    return;
  }

  try {
    await requestJSON(`/api/admin/events/${event.id}/delegate-lock`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
    setStatus(
      "A delegált módosítási állapot frissítve.",
      "success",
      delegateLockApplyButton,
    );
    await refreshEventData(false, true);
  } catch (error) {
    handleAuthError(error, delegateLockApplyButton);
  }
}

async function initEventsPage() {
  if (!ensureAdminSession()) {
    return;
  }
  initCollapsibleSection(addEventSection);
  initCollapsibleSection(eventListSection, true);
  await refreshEventData(true);

  const refreshButton = document.querySelector("[data-admin-refresh]");
  refreshButton?.addEventListener("click", async () => {
    await refreshEventData(true);
  });

  delegatePanelCloseButton?.addEventListener("click", () => {
    closeDelegatePanel();
  });

  delegatePanelRefreshButton?.addEventListener("click", async () => {
    if (!eventState.selectedEventId) {
      return;
    }
    delegatePanelRefreshButton.disabled = true;
    try {
      await refreshEventDelegates();
      await refreshAccessCodes();
      renderSelectedEventInfo();
      renderDelegateTable();
      renderDelegateLockControls();
      renderAccessCodePanel();
      mountDelegatePanel();
    } finally {
      delegatePanelRefreshButton.disabled = false;
    }
  });

  delegateLockApplyButton?.addEventListener("click", async () => {
    await handleDelegateLockApply();
  });

  cancelEventEditButton?.addEventListener("click", () => {
    if (!eventState.editingEventId) {
      createEventForm?.reset();
      resetEventFormPresentation();
      return;
    }
    exitEventEditMode();
    setStatus("Az esemény szerkesztése megszakítva.", "", cancelEventEditButton);
  });

  delegateGenerateCodesButton?.addEventListener("click", async () => {
    if (!ensureAdminSession(true)) {
      return;
    }
    if (!eventState.selectedEventId) {
      setDelegateCodeStatus(
        "Nyisd meg a megfelelő esemény kártyáját, mielőtt belépőkódokat generálsz.",
        "error",
      );
      return;
    }

    const confirmed = window.confirm(
      "Ez a művelet új belépőkódokat hoz létre, és felülírja a korábbi kódokat. Folytatod?",
    );
    if (!confirmed) {
      return;
    }

    delegateGenerateCodesButton.disabled = true;
    setDelegateCodeStatus("Belépőkódok generálása folyamatban...", "");

    try {
      const response = await requestJSON(
        `/api/admin/events/${eventState.selectedEventId}/codes`,
        {
          method: "POST",
          body: JSON.stringify({ regenerate: true }),
        },
      );
      eventState.accessCodes = Array.isArray(response?.codes) ? response.codes : [];
      eventState.accessCodeSummary = response || null;
      const selectedEvent = getSelectedEvent();
      if (selectedEvent) {
        selectedEvent.access_codes_total = response?.total ?? 0;
        selectedEvent.access_codes_available = response?.available ?? 0;
        selectedEvent.access_codes_used = response?.used ?? 0;
      }
      setDelegateCodeStatus("Belépőkódok frissítve.", "success");
      renderAccessCodePanel();
      renderSelectedEventInfo();
      renderEventsList(eventState.events);
    } catch (error) {
      const message =
        error?.message || "Nem sikerült generálni a belépőkódokat. Próbáld újra később.";
      setDelegateCodeStatus(message, "error");
      handleAuthError(error, delegateGenerateCodesButton);
    } finally {
      delegateGenerateCodesButton.disabled = false;
    }
  });

  delegateDownloadCodesButton?.addEventListener("click", async () => {
    if (!ensureAdminSession(true)) {
      return;
    }
    if (!eventState.selectedEventId) {
      setDelegateCodeStatus(
        "Nyisd meg a megfelelő esemény kártyáját a belépőkódok PDF-jének letöltéséhez.",
        "error",
      );
      return;
    }

    delegateDownloadCodesButton.disabled = true;
    setDelegateCodeStatus("PDF generálása folyamatban...", "");

    try {
      const response = await fetch(
        `/api/admin/events/${eventState.selectedEventId}/codes.pdf`,
        {
          credentials: "include",
          headers: getAuthHeaders({
            headers: {
              Accept: "application/pdf",
            },
          }),
        },
      );
      if (!response.ok) {
        let detail = `A letöltés sikertelen (HTTP ${response.status}).`;
        try {
          const payload = await response.json();
          detail = payload?.detail || detail;
        } catch (_) {
          // ignore JSON parse errors
        }
        throw new Error(detail);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `esemeny-${eventState.selectedEventId}-belepokodok.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDelegateCodeStatus("A belépőkódok PDF fájlja letöltve.", "success");
    } catch (error) {
      const message =
        error?.message || "Nem sikerült letölteni a belépőkódok PDF fájlját.";
      setDelegateCodeStatus(message, "error");
      handleAuthError(error, delegateDownloadCodesButton);
    } finally {
      delegateDownloadCodesButton.disabled = false;
    }
  });

  createEventForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ensureAdminSession(true)) {
      return;
    }
    const formData = new FormData(createEventForm);
    const titleValue = String(formData.get("title") || "").trim();
    if (titleValue.length < 3) {
      setStatus(
        "Kérjük, adj meg legalább 3 karakter hosszú eseménynevet.",
        "error",
        createEventSubmitButton,
      );
      return;
    }
    const eventDateValue = formData.get("event_date");
    const deadlineValue = formData.get("delegate_deadline");
    const limitValue = formData.get("delegate_limit");
    if (!eventDateValue || !deadlineValue) {
      setStatus(
        "Kérjük, add meg az esemény dátumát és a delegált határidejét.",
        "error",
        createEventSubmitButton,
      );
      return;
    }
    const delegateLimit = limitValue ? Number.parseInt(String(limitValue), 10) : NaN;
    if (!Number.isFinite(delegateLimit) || delegateLimit < 1) {
      setStatus(
        "Kérjük, válaszd ki a delegáltak maximális számát.",
        "error",
        createEventSubmitButton,
      );
      return;
    }
    const descriptionValue = formData.get("description");
    const normalizedDescription = descriptionValue
      ? String(descriptionValue).trim() || null
      : null;

    const basePayload = {
      title: titleValue,
      description: normalizedDescription,
      event_date: String(eventDateValue),
      delegate_deadline: String(deadlineValue),
      delegate_limit: delegateLimit,
    };

    if (eventState.editingEventId) {
      try {
        const updated = await requestJSON(`/api/admin/events/${eventState.editingEventId}`, {
          method: "PATCH",
          body: JSON.stringify(basePayload),
        });
        setStatus("Az esemény adatai frissítve.", "success", createEventSubmitButton);
        exitEventEditMode();
        if (updated?.id) {
          eventState.selectedEventId = updated.id;
          delegatePanelDismissed = false;
        }
        await refreshEventData(false, true);
      } catch (error) {
        handleAuthError(error, createEventSubmitButton);
      }
      return;
    }

    const payload = {
      ...basePayload,
      activate: formData.get("activate") === "on",
    };
    try {
      const created = await requestJSON("/api/admin/events", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setStatus("Új szavazási esemény létrehozva.", "success", createEventSubmitButton);
      createEventForm.reset();
      resetEventFormPresentation();
      if (created?.id) {
        eventState.selectedEventId = created.id;
        delegatePanelDismissed = false;
      }
      await refreshEventData(false, true);
    } catch (error) {
      handleAuthError(error, createEventSubmitButton);
    }
  });
}

async function initUsersPage() {
  if (!ensureAdminSession()) {
    return;
  }

  const form = document.querySelector("#create-admin-form");
  const submitButton = form?.querySelector('button[type="submit"]');
  const adminListBody = document.querySelector("[data-admin-list]");
  const emptyState = document.querySelector("[data-admin-empty]");
  const tableWrapper = document.querySelector("[data-admin-table]");
  const countElement = document.querySelector("[data-admin-count]");
  const firstNameInput = document.querySelector("#admin-first-name");
  const pendingSection = document.querySelector("[data-pending-section]");
  const pendingRefreshButton = document.querySelector("[data-pending-refresh]");

  function updateCount(count) {
    if (countElement) {
      countElement.textContent = String(count);
    }
  }

  async function refreshPendingRegistrations(anchor = null) {
    if (!pendingSection) {
      return;
    }
    if (anchor) {
      anchor.disabled = true;
    }
    try {
      const loaded = await loadPending({ silent: true, anchor });
      if (loaded && anchor) {
        setStatus("Függő regisztrációk frissítve.", "success", anchor);
      }
    } finally {
      if (anchor) {
        anchor.disabled = false;
      }
    }
  }

  function renderAdmins(admins) {
    if (!adminListBody) {
      return;
    }

    adminListBody.innerHTML = "";
    const items = Array.isArray(admins) ? admins : [];
    const hasAdmins = items.length > 0;

    if (tableWrapper) {
      tableWrapper.hidden = !hasAdmins;
    }
    if (emptyState) {
      emptyState.hidden = hasAdmins;
    }
    updateCount(items.length);

    items.forEach((admin) => {
      const row = document.createElement("tr");

      const displayName = formatDisplayName(
        admin.first_name,
        admin.last_name,
        admin.email || "–",
      );
      row.dataset.adminId = String(admin.id || "");
      row.dataset.adminEmail = admin.email || "";
      row.dataset.adminName = displayName || "";

      const nameCell = document.createElement("td");
      nameCell.textContent = displayName;
      row.appendChild(nameCell);

      const emailCell = document.createElement("td");
      emailCell.textContent = admin.email || "–";
      row.appendChild(emailCell);

      const createdCell = document.createElement("td");
      createdCell.textContent = formatDateTime(admin.created_at) || "–";
      row.appendChild(createdCell);

      const statusCell = document.createElement("td");
      const statusBadge = document.createElement("span");
      if (admin.must_change_password) {
        statusBadge.className = "badge badge-warning";
        statusBadge.textContent = "Jelszócsere szükséges";
      } else {
        statusBadge.className = "badge badge-success";
        statusBadge.textContent = "Aktív";
      }
      statusCell.appendChild(statusBadge);
      if (admin.must_change_password) {
        const note = document.createElement("div");
        note.className = "muted muted-note";
        note.textContent = "Az első bejelentkezéskor új jelszó megadása kötelező.";
        statusCell.appendChild(note);
      }
      row.appendChild(statusCell);

      const actionsCell = document.createElement("td");
      actionsCell.className = "admin-actions-cell";
      const actionGroup = document.createElement("div");
      actionGroup.className = "action-button-group";

      const resendButton = document.createElement("button");
      resendButton.type = "button";
      resendButton.className = "ghost-btn action-btn";
      resendButton.dataset.adminAction = "resend";
      resendButton.dataset.adminId = String(admin.id || "");
      resendButton.dataset.adminEmail = admin.email || "";
      resendButton.textContent = "Meghívó újraküldése";
      actionGroup.appendChild(resendButton);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "danger-btn action-btn";
      removeButton.dataset.adminAction = "remove";
      removeButton.dataset.adminId = String(admin.id || "");
      removeButton.dataset.adminEmail = admin.email || "";
      removeButton.textContent = "Eltávolítás";
      actionGroup.appendChild(removeButton);

      actionsCell.appendChild(actionGroup);
      row.appendChild(actionsCell);

      adminListBody.appendChild(row);
    });
  }

  async function refreshAdmins() {
    try {
      const admins = await requestJSON("/api/admin/admins");
      renderAdmins(admins);
    } catch (error) {
      handleAuthError(error);
    }
  }

  if (pendingSection) {
    await refreshPendingRegistrations();
    pendingRefreshButton?.addEventListener("click", async () => {
      await refreshPendingRegistrations(pendingRefreshButton);
    });
  }

  async function resendAdminInvite(adminId, anchor) {
    if (!ensureAdminSession(true)) {
      return;
    }

    if (!adminId) {
      return;
    }

    if (anchor) {
      anchor.disabled = true;
    }

    try {
      setStatus("Meghívó újraküldése folyamatban...", "", anchor);
      const response = await requestJSON(
        `/api/admin/admins/${adminId}/resend-invite`,
        {
          method: "POST",
        },
      );
      const message =
        response?.message || "Új meghívó e-mail elküldve az adminisztrátornak.";
      setStatus(message, "success", anchor);
      setStatus(message, "success");
      await refreshAdmins();
    } catch (error) {
      handleAuthError(error, anchor);
    } finally {
      if (anchor) {
        anchor.disabled = false;
      }
    }
  }

  async function removeAdmin(adminId, anchor, adminName = "") {
    if (!ensureAdminSession(true)) {
      return;
    }

    if (!adminId) {
      return;
    }

    const confirmed = window.confirm(
      adminName
        ? `Biztosan eltávolítod ${adminName} adminisztrátort? Ez a művelet nem visszavonható.`
        : "Biztosan eltávolítod az adminisztrátort? Ez a művelet nem visszavonható.",
    );
    if (!confirmed) {
      return;
    }

    if (anchor) {
      anchor.disabled = true;
    }

    try {
      setStatus("Adminisztrátor eltávolítása folyamatban...", "", anchor);
      await requestJSON(`/api/admin/admins/${adminId}`, {
        method: "DELETE",
      });
      const successMessage = adminName
        ? `${adminName} eltávolítva a rendszerből.`
        : "Adminisztrátor eltávolítva a rendszerből.";
      setStatus(successMessage, "success", anchor);
      setStatus(successMessage, "success");
      await refreshAdmins();
    } catch (error) {
      handleAuthError(error, anchor);
    } finally {
      if (anchor) {
        anchor.disabled = false;
      }
    }
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!ensureAdminSession(true)) {
        return;
      }

      const formData = new FormData(form);
      const firstName = String(formData.get("first_name") || "").trim();
      const lastName = String(formData.get("last_name") || "").trim();
      const email = String(formData.get("email") || "").trim();
      if (!firstName || !lastName || !email) {
        setStatus(
          "Kérjük, tölts ki minden mezőt az admin létrehozásához.",
          "error",
          submitButton,
        );
        return;
      }

      const payload = {
        first_name: firstName,
        last_name: lastName,
        email: email.toLowerCase(),
      };

      if (submitButton) {
        submitButton.disabled = true;
      }

      try {
        setStatus("Új adminisztrátor létrehozása folyamatban...", "", submitButton);
        const response = await requestJSON("/api/admin/admins", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const message =
          response?.message || "Új adminisztrátor létrehozva. Első belépéskor jelszócsere szükséges.";
        const tempPassword = response?.temporary_password;
        const finalMessage = tempPassword
          ? `${message} Ideiglenes jelszó: ${tempPassword}`
          : message;
        setStatus(finalMessage, "success", submitButton);
        form.reset();
        await refreshAdmins();
        if (firstNameInput instanceof HTMLElement) {
          firstNameInput.focus();
        }
      } catch (error) {
        handleAuthError(error, submitButton);
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
        }
      }
    });
  }

  if (adminListBody) {
    adminListBody.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-admin-action]");
      if (!button) {
        return;
      }

      const adminId = Number(button.dataset.adminId || "");
      const action = button.dataset.adminAction;
      const row = button.closest("tr");
      const adminName = row?.dataset?.adminName || button.dataset.adminEmail || "";

      if (action === "resend") {
        await resendAdminInvite(adminId, button);
      } else if (action === "remove") {
        await removeAdmin(adminId, button, adminName);
      }
    });
  }

  await refreshAdmins();
}

async function initSettingsPage() {
  if (!ensureAdminSession()) {
    return;
  }

  const bankForm = document.querySelector("#bank-settings-form");
  const bankNameInput = document.querySelector("#global-bank-name");
  const bankAccountInput = document.querySelector("#global-bank-account");
  const bankSubmitButton = bankForm?.querySelector('button[type="submit"]') || null;

  async function loadBankSettings() {
    if (!bankForm) {
      return;
    }
    try {
      const settings = await requestJSON("/api/admin/settings/bank");
      if (bankNameInput) {
        bankNameInput.value = settings?.bank_name || "";
      }
      if (bankAccountInput) {
        bankAccountInput.value = settings?.bank_account_number || "";
      }
      if (bankSubmitButton) {
        setStatus("", "", bankSubmitButton);
      }
    } catch (error) {
      if (bankSubmitButton) {
        handleAuthError(error, bankSubmitButton);
      } else {
        handleAuthError(error);
      }
    }
  }

  if (bankForm) {
    await loadBankSettings();
    bankForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!ensureAdminSession(true)) {
        return;
      }
      const payload = {
        bank_name: bankNameInput?.value || "",
        bank_account_number: bankAccountInput?.value || "",
      };
      try {
        const response = await requestJSON("/api/admin/settings/bank", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (bankNameInput) {
          bankNameInput.value = response?.bank_name || "";
        }
        if (bankAccountInput) {
          bankAccountInput.value = response?.bank_account_number || "";
        }
        setStatus("Banki adatok frissítve.", "success", bankSubmitButton);
      } catch (error) {
        handleAuthError(error, bankSubmitButton);
      }
    });
  }

  const resetButton = document.querySelector("[data-reset-events]");
  if (resetButton) {
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
        setStatus(
          "A művelet megszakítva. A megerősítő kulcsszó nem egyezett.",
          "error",
          resetButton,
        );
        return;
      }

      resetButton.disabled = true;
      try {
        setStatus("Szavazási események törlése folyamatban...", "", resetButton);
        const response = await requestJSON("/api/admin/events/reset", { method: "POST" });
        const message = response?.message || "Az események törlése megtörtént.";
        setStatus(message, "success", resetButton);
      } catch (error) {
        handleAuthError(error, resetButton);
      } finally {
        resetButton.disabled = false;
      }
    });
  }
}

attachSignOut();

switch (pageType) {
  case "organizations":
    initOrganizationsPage();
    break;
  case "events":
    initEventsPage();
    break;
  case "users":
    initUsersPage();
    break;
  case "settings":
    initSettingsPage();
    break;
  default:
    initOverviewPage();
    break;
}
