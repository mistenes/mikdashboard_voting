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
const invitationList = document.querySelector("#member-invitation-list");
const memberDirectory = document.querySelector("#member-directory");
const contactEventsCard = document.querySelector("#contact-events-card");
const contactEventsList = document.querySelector("#contact-events-list");
const contactActionItems = document.querySelectorAll(".contact-only-action");

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
const eventDateFormatter = new Intl.DateTimeFormat("hu-HU", {
  dateStyle: "long",
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

function formatEventTimestamp(value) {
  if (!value) {
    return "";
  }
  try {
    return eventDateFormatter.format(new Date(value));
  } catch (_) {
    return "";
  }
}

function hasContactPrivileges(detail, sessionUser) {
  if (!sessionUser) {
    return false;
  }
  if (sessionUser.is_admin || sessionUser.is_organization_contact) {
    return true;
  }
  if (!detail || !detail.contact || !detail.contact.user) {
    return false;
  }
  return detail.contact.user.id === sessionUser.id;
}

function toggleContactActions(isContact) {
  contactActionItems.forEach((item) => {
    if (!item) {
      return;
    }
    item.classList.toggle("is-hidden", !isContact);
  });
}

function ensureNavLinks(orgId, sessionUser, detail) {
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
    const requiresContact = link.dataset.requiresContact === "1";
    const isContact = hasContactPrivileges(detail, sessionUser);
    const shouldHide = requiresContact && !isContact;
    link.classList.toggle("is-hidden", shouldHide);
  });
}

function renderMembers(detail, sessionUser = null) {
  if (!memberDirectory) {
    return;
  }
  const viewer = sessionUser || cachedSessionUser;
  const viewerId = viewer ? viewer.id : null;
  const canManageMembers = hasContactPrivileges(detail, viewer);
  memberDirectory.innerHTML = "";
  bindMemberDirectoryActions();

  const members = Array.isArray(detail.members) ? detail.members : [];
  if (!members.length) {
    const empty = document.createElement("p");
    empty.classList.add("muted", "member-directory-empty");
    empty.textContent = "Nincs megjeleníthető tag.";
    memberDirectory.appendChild(empty);
    return;
  }

  members.forEach((member) => {
    const card = document.createElement("article");
    card.classList.add("member-card");
    card.setAttribute("role", "listitem");

    if (member.is_contact) {
      card.classList.add("is-contact");
    } else if (member.is_admin) {
      card.classList.add("is-admin");
    }

    const header = document.createElement("div");
    header.classList.add("member-card-header");

    const nameBlock = document.createElement("div");
    nameBlock.classList.add("member-card-name");

    const name = document.createElement("h3");
    name.textContent = formatDisplayName(
      member.first_name,
      member.last_name,
      member.email,
    );

    const email = document.createElement("p");
    email.classList.add("member-card-email");
    email.textContent = member.email;

    const { label: statusLabel, variant: statusVariant } = getMemberStatus(
      member,
      detail,
    );
    const status = document.createElement("span");
    status.classList.add("member-status-badge");
    if (statusVariant) {
      status.classList.add(`is-${statusVariant}`);
    }
    status.textContent = statusLabel;

    nameBlock.appendChild(name);
    nameBlock.appendChild(email);
    header.appendChild(nameBlock);
    header.appendChild(status);

    const metaList = buildMemberMeta(member, detail);

    card.appendChild(header);
    if (metaList.children.length) {
      card.appendChild(metaList);
    }

    const shouldShowRemove =
      canManageMembers &&
      !member.is_admin &&
      !member.is_contact &&
      member.id !== viewerId;

    if (shouldShowRemove) {
      const actions = document.createElement("div");
      actions.classList.add("member-card-actions");

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.classList.add("danger-btn");
      removeButton.dataset.removeMember = "1";
      removeButton.dataset.memberId = String(member.id);
      removeButton.dataset.memberName = name.textContent || member.email;
      removeButton.textContent = "Tag eltávolítása";
      actions.appendChild(removeButton);

      const statusEl = document.createElement("p");
      statusEl.classList.add("status", "action-status", "member-remove-status");
      statusEl.setAttribute("role", "status");
      actions.appendChild(statusEl);

      card.appendChild(actions);
    }

    memberDirectory.appendChild(card);
  });
}

function setActionStatus(statusEl, message, type = "") {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message || "";
  statusEl.classList.remove("error", "success");
  if (type) {
    statusEl.classList.add(type);
  }
}

function bindMemberDirectoryActions() {
  if (!memberDirectory || memberDirectory.dataset.actionsBound === "1") {
    return;
  }

  memberDirectory.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-remove-member]");
    if (!button || !memberDirectory.contains(button)) {
      return;
    }

    event.preventDefault();
    if (!organizationId) {
      return;
    }

    const memberId = Number.parseInt(button.dataset.memberId || "", 10);
    if (!Number.isInteger(memberId)) {
      return;
    }

    const memberName = button.dataset.memberName || "";
    const confirmMessage = memberName
      ? `Biztosan eltávolítod ${memberName} tagot a szervezetből?`
      : "Biztosan eltávolítod a tagot a szervezetből?";
    if (!window.confirm(confirmMessage)) {
      return;
    }

    const actions = button.closest(".member-card-actions");
    const statusEl = actions
      ? actions.querySelector(".member-remove-status")
      : null;
    setActionStatus(statusEl, "Tag eltávolítása folyamatban...", "");
    button.disabled = true;

    try {
      const detail = await requestJSON(
        `/api/organizations/${organizationId}/members/${memberId}`,
        { method: "DELETE" },
      );
      cachedOrganizationDetail = detail;
      setActionStatus(statusEl, "Tag eltávolítva a szervezetből.", "success");
      setTimeout(() => {
        if (!cachedOrganizationDetail || !cachedSessionUser) {
          return;
        }
        renderMembers(cachedOrganizationDetail, cachedSessionUser);
        renderInvitations(cachedOrganizationDetail, cachedSessionUser);
        renderEventAssignments(cachedOrganizationDetail, cachedSessionUser);
      }, 600);
    } catch (error) {
      const message =
        error?.message || "Nem sikerült eltávolítani a tagot. Próbáld újra később.";
      setActionStatus(statusEl, message, "error");
      if (error?.status === 401 || error?.status === 403) {
        handleAuthError(error);
      }
    } finally {
      if (document.body.contains(button)) {
        button.disabled = false;
      }
    }
  });

  memberDirectory.dataset.actionsBound = "1";
}

function getMemberStatus(member, detail) {
  const feePaid = detail?.fee_paid;
  const hasAccess = member.has_access ?? true;
  if (member.is_contact) {
    return { label: "Kapcsolattartó", variant: "contact" };
  }
  if (member.is_admin) {
    return { label: "Adminisztrátor", variant: "admin" };
  }
  if (!member.is_email_verified) {
    return { label: "E-mail megerősítésre vár", variant: "pending" };
  }
  if (member.admin_decision !== "approved") {
    return { label: "Admin jóváhagyásra vár", variant: "pending" };
  }
  if (feePaid === false) {
    return { label: "Tagsági díj rendezetlen", variant: "alert" };
  }
  if (!hasAccess) {
    return { label: "Hozzáférés blokkolva", variant: "blocked" };
  }
  if (member.is_voting_delegate) {
    return { label: "Szavazó delegált", variant: "delegate" };
  }
  return { label: "Aktív", variant: "active" };
}

function buildMemberMeta(member, detail) {
  const list = document.createElement("ul");
  list.classList.add("member-card-meta");

  const metaItems = [];
  const feePaid = detail?.fee_paid;
  const hasAccess = member.has_access ?? true;

  if (member.is_contact) {
    metaItems.push("Elsődleges kapcsolattartó");
  }
  if (member.is_admin) {
    metaItems.push("Admin jogosultság");
  }
  if (member.is_voting_delegate) {
    metaItems.push("Delegálva a szavazásra");
  }
  if (!member.is_email_verified) {
    metaItems.push("E-mail megerősítésre vár");
  }
  if (member.admin_decision !== "approved") {
    metaItems.push("Admin jóváhagyás folyamatban");
  }
  if (feePaid === false) {
    metaItems.push("Tagsági díj rendezetlen");
  }
  if (!hasAccess) {
    metaItems.push("Belépés ideiglenesen blokkolva");
  }

  metaItems.forEach((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    list.appendChild(item);
  });

  return list;
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
  if (!invitationCard || !invitationList) {
    return;
  }
  const isContact = hasContactPrivileges(detail, sessionUser);
  toggleContactActions(isContact);
  if (!isContact) {
    invitationCard.classList.add("is-hidden");
    return;
  }
  invitationCard.classList.remove("is-hidden");
  clearInvitationStatus();

  const pending = Array.isArray(detail.pending_invitations)
    ? detail.pending_invitations
    : [];
  invitationList.innerHTML = "";
  if (!pending.length) {
    const empty = document.createElement("p");
    empty.classList.add("muted", "pending-invite-empty");
    empty.textContent = "Nincs folyamatban lévő meghívó.";
    invitationList.appendChild(empty);
    return;
  }

  pending.forEach((invite) => {
    const card = document.createElement("article");
    card.classList.add("pending-invite-card");
    card.setAttribute("role", "listitem");

    const header = document.createElement("div");
    header.classList.add("pending-invite-header");

    const email = document.createElement("h4");
    email.classList.add("pending-invite-email");
    email.textContent = invite.email;

    const role = document.createElement("span");
    role.classList.add("pending-invite-role");
    role.textContent = formatInviteRole(invite.role);

    header.appendChild(email);
    header.appendChild(role);

    const created = document.createElement("p");
    created.classList.add("pending-invite-meta");
    const timestamp = formatInviteTimestamp(invite.created_at);
    created.textContent = timestamp
      ? `Meghívva: ${timestamp}`
      : "Meghívás folyamatban";

    card.appendChild(header);
    card.appendChild(created);
    invitationList.appendChild(card);
  });
}

function collectDelegateIds(form) {
  return Array.from(
    form.querySelectorAll('input[type="checkbox"][data-member-id]:checked'),
  )
    .map((input) => Number.parseInt(input.dataset.memberId, 10))
    .filter((value) => Number.isInteger(value));
}

function updateDelegateLimitState(form, eventDetail) {
  const limit = Number.isInteger(eventDetail.delegate_limit)
    ? eventDetail.delegate_limit
    : null;
  const checkboxes = Array.from(
    form.querySelectorAll('input[type="checkbox"][data-member-id]'),
  );
  const checkedCount = checkboxes.filter((input) => input.checked).length;
  checkboxes.forEach((input) => {
    const originalDisabled = input.dataset.originalDisabled === "1";
    const option = input.closest(".delegate-option");
    if (originalDisabled || !eventDetail.can_manage_delegates) {
      input.disabled = true;
      if (option) {
        option.classList.toggle("is-disabled", !input.checked);
      }
      return;
    }
    if (!limit) {
      input.disabled = false;
      input.classList.remove("disabled-by-limit");
      if (option) {
        option.classList.toggle("is-disabled", false);
      }
      return;
    }
    const shouldDisable = checkedCount >= limit && !input.checked;
    input.disabled = shouldDisable;
    input.classList.toggle("disabled-by-limit", shouldDisable);
    if (option) {
      option.classList.toggle("is-disabled", shouldDisable);
    }
  });
  const helper = form.querySelector(".delegate-limit-helper");
  if (helper) {
    if (limit) {
      helper.textContent = `Kijelölt delegáltak: ${checkedCount}/${limit}`;
    } else {
      helper.textContent = `Kijelölt delegáltak: ${checkedCount}`;
    }
  }
}

function bindDelegateForm(form, eventDetail, detail, sessionUser) {
  if (!form) {
    return;
  }
  const submitButton = form.querySelector('button[type="submit"]');
  const statusEl = form.querySelector(".delegate-status");

  function setDelegateStatus(message, type = "") {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message || "";
    statusEl.classList.remove("error", "success");
    if (type) {
      statusEl.classList.add(type);
    }
  }

  function clearDelegateStatus() {
    setDelegateStatus("");
  }

  form.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
      return;
    }
    const option = target.closest(".delegate-option");
    if (option) {
      option.classList.toggle("is-selected", target.checked);
    }
    clearDelegateStatus();
    const limit = Number.isInteger(eventDetail.delegate_limit)
      ? eventDetail.delegate_limit
      : null;
    if (limit && target.checked) {
      const selectedIds = collectDelegateIds(form);
      if (selectedIds.length > limit) {
        target.checked = false;
        if (option) {
          option.classList.remove("is-selected");
        }
        setDelegateStatus(
          `Legfeljebb ${limit} delegált jelölhető ki ehhez az eseményhez.`,
          "error",
        );
      }
    }
    updateDelegateLimitState(form, eventDetail);
  });

  if (submitButton) {
    submitButton.disabled = !eventDetail.can_manage_delegates;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!eventDetail.can_manage_delegates || !submitButton) {
      return;
    }
    clearDelegateStatus();
    setStatus("Delegáltak mentése folyamatban...", "");
    submitButton.disabled = true;
    try {
      const userIds = collectDelegateIds(form);
      const payload = { user_ids: userIds };
      const response = await requestJSON(
        `/api/organizations/${organizationId}/events/${eventDetail.event_id}/delegates`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
      cachedOrganizationDetail = response;
      setStatus("Delegáltak frissítve.", "success");
      renderEventAssignments(response, sessionUser);
      renderMembers(response, sessionUser);
      renderInvitations(response, sessionUser);
    } catch (error) {
      const message =
        error?.message ||
        "Nem sikerült menteni a delegáltakat. Próbáld újra később.";
      setStatus(message, "error");
      setDelegateStatus(message, "error");
      if (error?.status === 401 || error?.status === 403) {
        handleAuthError(error);
      }
    } finally {
      if (submitButton && document.body.contains(submitButton)) {
        submitButton.disabled = false;
      }
    }
  });

  updateDelegateLimitState(form, eventDetail);
}

function renderEventAssignments(detail, sessionUser) {
  if (!contactEventsCard || !contactEventsList) {
    return;
  }
  const events = Array.isArray(detail.upcoming_events)
    ? detail.upcoming_events
    : [];
  const isContact = hasContactPrivileges(detail, sessionUser);
  toggleContactActions(isContact);
  if (!isContact) {
    contactEventsCard.classList.add("is-hidden");
    contactEventsList.innerHTML = "";
    return;
  }
  contactEventsCard.classList.remove("is-hidden");
  contactEventsList.innerHTML = "";
  if (!events.length) {
    const empty = document.createElement("p");
    empty.classList.add("muted");
    empty.textContent = "Jelenleg nincs közelgő esemény.";
    contactEventsList.appendChild(empty);
    return;
  }

  events.forEach((eventDetail) => {
    const card = document.createElement("article");
    card.classList.add("event-assignment-card");

    const header = document.createElement("div");
    header.classList.add("event-assignment-header");
    const title = document.createElement("h3");
    title.textContent = eventDetail.title;
    header.appendChild(title);

    const statusBadge = document.createElement("span");
    statusBadge.classList.add("event-status-badge");
    statusBadge.textContent = eventDetail.is_active ? "Aktív" : "Inaktív";
    statusBadge.classList.toggle("is-active", Boolean(eventDetail.is_active));
    header.appendChild(statusBadge);

    card.appendChild(header);

    if (eventDetail.description) {
      const description = document.createElement("p");
      description.classList.add("event-description");
      description.textContent = eventDetail.description;
      card.appendChild(description);
    }

    const metaList = document.createElement("ul");
    metaList.classList.add("event-meta");
    if (eventDetail.event_date) {
      const item = document.createElement("li");
      item.textContent = `Esemény időpontja: ${formatEventTimestamp(eventDetail.event_date)}`;
      metaList.appendChild(item);
    }
    if (eventDetail.delegate_deadline) {
      const item = document.createElement("li");
      item.textContent = `Delegált határidő: ${formatEventTimestamp(eventDetail.delegate_deadline)}`;
      metaList.appendChild(item);
    }
    const availability = document.createElement("li");
    availability.textContent = eventDetail.is_voting_enabled
      ? "Szavazási felület engedélyezve"
      : "Szavazási felület letiltva";
    metaList.appendChild(availability);
    const limitItem = document.createElement("li");
    limitItem.textContent = eventDetail.delegate_limit
      ? `Delegált keret: ${eventDetail.delegate_limit} fő`
      : "Delegált keret: nincs felső határ";
    metaList.appendChild(limitItem);
    const countItem = document.createElement("li");
    countItem.textContent = `Jelenleg kijelölve: ${eventDetail.delegate_count} fő`;
    metaList.appendChild(countItem);
    card.appendChild(metaList);

    if (!eventDetail.can_manage_delegates) {
      const notice = document.createElement("p");
      notice.classList.add("muted");
      notice.textContent =
        eventDetail.delegate_lock_message ||
        "A delegáltak kiosztása lezárult ehhez az eseményhez.";
      card.appendChild(notice);
    } else if (
      eventDetail.delegate_lock_mode === "unlocked" &&
      eventDetail.delegate_lock_message
    ) {
      const notice = document.createElement("p");
      notice.classList.add("muted");
      notice.textContent = eventDetail.delegate_lock_message;
      card.appendChild(notice);
    }

    const form = document.createElement("form");
    form.classList.add("delegate-form");
    form.dataset.eventId = String(eventDetail.event_id);

    const grid = document.createElement("div");
    grid.classList.add("delegate-grid");

    const members = Array.isArray(detail.members) ? detail.members : [];
    if (!members.length) {
      const emptyHint = document.createElement("p");
      emptyHint.classList.add("muted");
      emptyHint.textContent = "Nincs elérhető tag a szervezetben.";
      card.appendChild(emptyHint);
    }

    members.forEach((member) => {
      const checkboxId = `delegate-${eventDetail.event_id}-${member.id}`;
      const option = document.createElement("label");
      option.classList.add("delegate-option");
      option.setAttribute("for", checkboxId);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = checkboxId;
      checkbox.value = member.id;
      checkbox.dataset.memberId = String(member.id);

      const isSelected = Array.isArray(eventDetail.delegate_user_ids)
        ? eventDetail.delegate_user_ids.includes(member.id)
        : false;
      checkbox.checked = isSelected;
      option.classList.toggle("is-selected", isSelected);

      const eligible =
        member.is_email_verified &&
        member.admin_decision === "approved" &&
        member.has_access;
      const originalDisabled = !eligible || !eventDetail.can_manage_delegates;
      checkbox.disabled = originalDisabled;
      checkbox.dataset.originalDisabled = originalDisabled ? "1" : "0";
      option.classList.toggle("is-disabled", originalDisabled && !isSelected);

      const labelBody = document.createElement("div");
      labelBody.classList.add("delegate-option-body");

      const name = document.createElement("span");
      name.classList.add("delegate-option-name");
      name.textContent = formatDisplayName(
        member.first_name,
        member.last_name,
        member.email,
      );
      labelBody.appendChild(name);

      const email = document.createElement("span");
      email.classList.add("delegate-option-subtitle", "muted");
      email.textContent = member.email;
      labelBody.appendChild(email);

      if (!eligible) {
        const warning = document.createElement("span");
        warning.classList.add("delegate-warning");
        warning.textContent =
          "Csak jóváhagyott és megerősített tag jelölhető ki.";
        labelBody.appendChild(warning);
      }

      option.appendChild(checkbox);
      option.appendChild(labelBody);
      grid.appendChild(option);
    });

    form.appendChild(grid);

    const helper = document.createElement("p");
    helper.classList.add("muted", "delegate-limit-helper");
    form.appendChild(helper);

    const formStatus = document.createElement("p");
    formStatus.classList.add("status", "delegate-status");
    formStatus.setAttribute("role", "status");
    form.appendChild(formStatus);

    const actionRow = document.createElement("div");
    actionRow.classList.add("form-row");
    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.classList.add("primary-btn");
    submitButton.textContent = "Delegáltak mentése";
    actionRow.appendChild(submitButton);
    form.appendChild(actionRow);

    card.appendChild(form);
    contactEventsList.appendChild(card);

    bindDelegateForm(form, eventDetail, detail, sessionUser);
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
      renderMembers(detail, sessionUser);
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

    clearStatus();

    const detail = await requestJSON(`/api/organizations/${organizationId}/detail`);
    cachedOrganizationDetail = detail;
    ensureNavLinks(organizationId, sessionUser, detail);
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
      renderEventAssignments(detail, sessionUser);
    } else if (pageType === "tagkezeles") {
      bindInvitationForm(sessionUser);
      renderMembers(detail, sessionUser);
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
