from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from datetime import datetime
from typing import Annotated, List

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import inspect, text

import httpx

from .database import Base, SessionLocal, engine
from .models import (
    ApprovalDecision,
    EventDelegate,
    InvitationRole,
    Organization,
    OrganizationInvitation,
    User,
    VotingEvent,
)
from .schemas import (
    ActiveEventInfo,
    AdminDecisionRequest,
    AdminDecisionResponse,
    AdminUserCreateRequest,
    AdminUserCreateResponse,
    AdminUserRead,
    ErrorResponse,
    EventDelegateAssignmentRequest,
    EventDelegateInfo,
    InvitationAcceptRequest,
    InvitationCreateRequest,
    LoginRequest,
    LoginResponse,
    OrganizationBillingUpdate,
    OrganizationContactInfo,
    OrganizationCreateRequest,
    OrganizationDetail,
    OrganizationEventAssignment,
    OrganizationEventDelegate,
    OrganizationFeeUpdate,
    OrganizationInvitationRead,
    OrganizationMembershipInfo,
    OrganizationRead,
    PasswordChangeRequest,
    PasswordChangeResponse,
    PasswordResetConfirmRequest,
    PasswordResetRequest,
    PasswordResetVerifyResponse,
    PendingUser,
    PublicConfigResponse,
    RegistrationRequest,
    RegistrationResponse,
    SessionUser,
    SimpleMessageResponse,
    VerificationResponse,
    VotingAuthRequest,
    VotingAuthResponse,
    VotingEventAccessUpdate,
    VotingEventCreateRequest,
    VotingEventUpdateRequest,
    VotingEventRead,
    VotingO2AuthLaunchRequest,
    VotingO2AuthResponse,
)
from .services import (
    AuthenticationError,
    PasswordResetError,
    RegistrationError,
    accept_invitation,
    authenticate_user,
    complete_password_reset,
    change_user_password,
    create_admin_account,
    create_contact_invitation,
    create_member_invitation,
    create_organization,
    create_session_token,
    create_voting_event,
    decide_registration,
    delegates_for_event,
    delete_organization,
    delete_voting_event,
    delete_user_account,
    get_active_password_reset_token,
    get_active_voting_event,
    get_invitation_by_token,
    issue_password_reset_token,
    list_voting_events,
    upcoming_voting_events,
    list_admin_users,
    organization_with_members,
    organizations_with_members,
    pending_registrations,
    queue_password_reset_email,
    queue_invitation_email,
    queue_admin_invitation_email,
    queue_verification_email,
    register_user,
    reset_voting_events,
    remove_member_from_organization,
    resolve_session_user,
    search_organizations,
    set_active_voting_event,
    set_event_delegates_for_organization,
    set_voting_event_accessibility,
    set_organization_billing_details,
    set_organization_fee_status,
    update_voting_event,
    verify_email,
    verify_recaptcha,
    reset_admin_temporary_password,
    delete_admin_account,
)
from .security import hash_password


logger = logging.getLogger(__name__)

ADMIN_EMAILS = {
    email.strip().lower()
    for email in os.getenv("ADMIN_EMAILS", "").split(",")
    if email.strip()
}

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "").strip().lower() or None
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
ADMIN_FIRST_NAME = os.getenv("ADMIN_FIRST_NAME", "Rendszer").strip() or "Rendszer"
ADMIN_LAST_NAME = os.getenv("ADMIN_LAST_NAME", "Adminisztrátor").strip() or "Adminisztrátor"
if ADMIN_EMAIL:
    ADMIN_EMAILS.add(ADMIN_EMAIL)
USER_REDIRECT_PATH = os.getenv("USER_REDIRECT_PATH", "/")
ADMIN_REDIRECT_PATH = os.getenv("ADMIN_REDIRECT_PATH", "/admin")
RECAPTCHA_SITE_KEY = os.getenv("RECAPTCHA_SITE_KEY", "").strip()
RECAPTCHA_SECRET_KEY = os.getenv("RECAPTCHA_SECRET_KEY", "").strip()
RECAPTCHA_ENABLED = bool(RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY)
VOTING_O2AUTH_SECRET = (
    os.getenv("VOTING_O2AUTH_SECRET", "development-secret") or "development-secret"
)
VOTING_O2AUTH_TTL_SECONDS = int(os.getenv("VOTING_O2AUTH_TTL_SECONDS", "300"))
VOTING_APP_BASE_URL = (
    os.getenv("VOTING_APP_BASE_URL", "http://localhost:3001").strip() or "http://localhost:3001"
)
VOTING_AUTH_TTL_SECONDS = int(os.getenv("VOTING_AUTH_TTL_SECONDS", "60"))
BREVO_API_KEY = os.getenv("BREVO_API_KEY", "").strip()
BREVO_SENDER_EMAIL = os.getenv("BREVO_SENDER_EMAIL", "").strip()
BREVO_SENDER_NAME = os.getenv("BREVO_SENDER_NAME", "MIK Dashboard").strip() or "MIK Dashboard"
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip()
_VOTING_O2AUTH_SECRET_BYTES = VOTING_O2AUTH_SECRET.encode("utf-8")
VOTING_SYNC_TIMEOUT_SECONDS = float(os.getenv("VOTING_SYNC_TIMEOUT_SECONDS", "5"))
PASSWORD_RESET_TOKEN_TTL_MINUTES = int(
    os.getenv("PASSWORD_RESET_TOKEN_TTL_MINUTES", "60")
)


def _serialize_datetime(value):
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None


def _delegate_count(event: VotingEvent | None) -> int:
    if event is None:
        return 0
    delegates = getattr(event, "delegates", None)
    if delegates is None:
        return 0
    count = 0
    try:
        for delegate in delegates:
            if getattr(delegate, "user_id", None):
                count += 1
    except TypeError:
        return 0
    return count


def _build_voting_sync_payload(event: VotingEvent | None) -> dict:
    event_payload = None
    if event is not None:
        event_payload = {
            "id": event.id,
            "title": event.title,
            "event_date": _serialize_datetime(event.event_date),
            "delegate_deadline": _serialize_datetime(event.delegate_deadline),
            "is_voting_enabled": bool(event.is_voting_enabled),
            "delegate_limit": getattr(event, "delegate_limit", None),
        }

    payload = {
        "event": event_payload,
        "delegate_count": _delegate_count(event),
    }
    return payload


def _sync_voting_service(event: VotingEvent | None) -> None:
    payload = _build_voting_sync_payload(event)
    canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    timestamp = int(time.time())
    signature_payload = f"{timestamp}:{canonical}".encode("utf-8")
    signature = hmac.new(
        _VOTING_O2AUTH_SECRET_BYTES, signature_payload, hashlib.sha256
    ).hexdigest()
    url = f"{VOTING_APP_BASE_URL.rstrip('/')}/api/internal/event-sync"
    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "x-voting-timestamp": str(timestamp),
        "x-voting-signature": signature,
    }

    try:
        response = httpx.post(
            url,
            json=payload,
            headers=headers,
            timeout=VOTING_SYNC_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except Exception as exc:  # pragma: no cover - network best effort
        logger.warning("Failed to synchronize voting metadata: %s", exc)


def _sync_active_event(db: Session) -> None:
    active_event = get_active_voting_event(db)
    _sync_voting_service(active_event)

app = FastAPI(title="MIK Dashboard Registration Service")


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_fee_paid_column()
    ensure_billing_columns()
    ensure_is_admin_column()
    ensure_voting_delegate_column()
    ensure_must_change_password_column()
    ensure_organization_contact_column()
    ensure_nullable_organization_column()
    ensure_name_columns()
    ensure_event_metadata_columns()
    ensure_delegate_uniqueness_constraints()
    seed_admin_user()
    app.state.email_queue = []


def ensure_fee_paid_column() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("organizations")}
        if "fee_paid" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE organizations ADD COLUMN fee_paid BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )


def ensure_billing_columns() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("organizations")}
        if "bank_name" not in columns:
            connection.execute(
                text("ALTER TABLE organizations ADD COLUMN bank_name VARCHAR")
            )
        if "bank_account_number" not in columns:
            connection.execute(
                text("ALTER TABLE organizations ADD COLUMN bank_account_number VARCHAR")
            )
        if "payment_instructions" not in columns:
            connection.execute(
                text("ALTER TABLE organizations ADD COLUMN payment_instructions VARCHAR")
            )


def ensure_is_admin_column() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("users")}
        if "is_admin" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )


def ensure_voting_delegate_column() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("users")}
        if "is_voting_delegate" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE users ADD COLUMN is_voting_delegate BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )


def ensure_must_change_password_column() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("users")}
        if "must_change_password" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )


def ensure_organization_contact_column() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("users")}
        if "is_organization_contact" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE users ADD COLUMN is_organization_contact BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )


def ensure_nullable_organization_column() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        for column in inspector.get_columns("users"):
            if column["name"] == "organization_id" and not column.get("nullable", True):
                connection.execute(
                    text("ALTER TABLE users ALTER COLUMN organization_id DROP NOT NULL")
                )
                break


def ensure_name_columns() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("users")}
        if "first_name" not in columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN first_name VARCHAR"))
        if "last_name" not in columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN last_name VARCHAR"))


def ensure_event_metadata_columns() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        columns = {column["name"] for column in inspector.get_columns("voting_events")}
        if "event_date" not in columns:
            connection.execute(text("ALTER TABLE voting_events ADD COLUMN event_date TIMESTAMP"))
        if "delegate_deadline" not in columns:
            connection.execute(
                text("ALTER TABLE voting_events ADD COLUMN delegate_deadline TIMESTAMP")
            )
        if "is_voting_enabled" not in columns:
            connection.execute(
                text(
                    "ALTER TABLE voting_events ADD COLUMN is_voting_enabled BOOLEAN NOT NULL DEFAULT FALSE"
                )
            )
        if "delegate_limit" not in columns:
            connection.execute(
                text("ALTER TABLE voting_events ADD COLUMN delegate_limit INTEGER")
            )


def ensure_delegate_uniqueness_constraints() -> None:
    with engine.begin() as connection:
        inspector = inspect(connection)
        constraint_names = {
            constraint["name"] for constraint in inspector.get_unique_constraints("event_delegates")
        }
        if "uq_event_org" not in constraint_names:
            return

        dialect = connection.dialect.name
        if dialect == "sqlite":
            connection.execute(text("DROP INDEX IF EXISTS uq_event_org"))
        else:
            connection.execute(text("ALTER TABLE event_delegates DROP CONSTRAINT uq_event_org"))


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _effective_o2auth_ttl() -> int:
    return VOTING_O2AUTH_TTL_SECONDS if VOTING_O2AUTH_TTL_SECONDS > 0 else 300


def _validate_voting_auth_request(payload: VotingAuthRequest) -> None:
    now = int(time.time())
    if abs(now - payload.timestamp) > max(VOTING_AUTH_TTL_SECONDS, 1):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A hitelesítési kérelem lejárt.",
        )

    canonical_email = payload.email.lower()
    message = f"{payload.timestamp}:{canonical_email}:{payload.password}".encode("utf-8")
    expected_signature = hmac.new(
        _VOTING_O2AUTH_SECRET_BYTES, message, hashlib.sha256
    ).hexdigest()
    provided_signature = payload.signature.strip().lower()
    if not hmac.compare_digest(expected_signature, provided_signature):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Érvénytelen hitelesítési aláírás.",
        )


def generate_voting_o2auth_token(
    user: User,
    organization: Organization,
    event: VotingEvent,
    *,
    view: str = "default",
) -> str:
    ttl = _effective_o2auth_ttl()
    payload = {
        "uid": user.id,
        "org": organization.id,
        "email": user.email,
        "role": "admin" if user.is_admin else "voter",
        "exp": int(time.time()) + ttl,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "event": event.id,
        "event_title": event.title,
        "event_date": event.event_date.isoformat() if event.event_date else None,
        "delegate_deadline": (
            event.delegate_deadline.isoformat() if event.delegate_deadline else None
        ),
        "is_voting_enabled": event.is_voting_enabled,
        "delegate_count": event_delegate_count(event),
    }
    if view and view != "default":
        payload["view"] = view
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(_VOTING_O2AUTH_SECRET_BYTES, body, hashlib.sha256).hexdigest()
    return f"{_base64url_encode(body)}.{signature}"


def build_voting_redirect_url(token: str, *, view: str = "default") -> str:
    base = VOTING_APP_BASE_URL.rstrip("/")
    query = f"token={token}"
    if view and view != "default":
        query = f"{query}&view={view}"
    return f"{base}/o2auth?{query}"


def seed_admin_user() -> None:
    if not ADMIN_EMAIL or not ADMIN_PASSWORD:
        return

    with SessionLocal() as session:
        existing = (
            session.query(User).filter(User.email == ADMIN_EMAIL).one_or_none()
        )

        salt, password_hash = hash_password(ADMIN_PASSWORD)

        if existing:
            existing.password_salt = salt
            existing.password_hash = password_hash
            existing.organization = None
            existing.is_admin = True
            existing.is_email_verified = True
            existing.admin_decision = ApprovalDecision.approved
            existing.first_name = ADMIN_FIRST_NAME
            existing.last_name = ADMIN_LAST_NAME
            existing.is_voting_delegate = True
            existing.must_change_password = True
        else:
            user = User(
                email=ADMIN_EMAIL,
                first_name=ADMIN_FIRST_NAME,
                last_name=ADMIN_LAST_NAME,
                password_salt=salt,
                password_hash=password_hash,
                organization=None,
                is_admin=True,
                is_email_verified=True,
                admin_decision=ApprovalDecision.approved,
                is_voting_delegate=True,
                must_change_password=True,
            )
            session.add(user)

        session.commit()


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


DatabaseDependency = Annotated[Session, Depends(get_db)]


bearer_scheme = HTTPBearer(auto_error=False)


def get_session_user(
    db: DatabaseDependency,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer_scheme)
    ],
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Hiányzó vagy érvénytelen Bearer jogosultsági fejléc",
        )
    user = resolve_session_user(db, credentials.credentials)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Érvénytelen vagy lejárt munkamenet token",
        )
    return user


def require_admin(user: Annotated[User, Depends(get_session_user)]) -> User:
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Az adminisztrátori szerepkör szükséges",
        )
    return user


def membership_info(organization: Organization | None) -> OrganizationMembershipInfo | None:
    if organization is None:
        return None
    return OrganizationMembershipInfo(
        id=organization.id,
        name=organization.name,
        fee_paid=organization.fee_paid,
        bank_name=organization.bank_name,
        bank_account_number=organization.bank_account_number,
        payment_instructions=organization.payment_instructions,
    )


def ensure_organization_membership(user: User, organization_id: int) -> None:
    if user.is_admin:
        return
    if not user.organization or user.organization.id != organization_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Nincs jogosultságod ehhez a szervezethez",
        )


def event_delegate_count(event: VotingEvent | None) -> int:
    if event is None:
        return 0
    delegates = getattr(event, "delegates", None)
    if not delegates:
        return 0
    count = 0
    for delegate in delegates:
        if getattr(delegate, "user_id", None):
            count += 1
    return count


def active_event_info(event: VotingEvent | None) -> ActiveEventInfo | None:
    if event is None:
        return None
    return ActiveEventInfo(
        id=event.id,
        title=event.title,
        description=event.description,
        event_date=event.event_date,
        delegate_deadline=event.delegate_deadline,
        is_voting_enabled=event.is_voting_enabled,
        delegate_count=event_delegate_count(event),
        delegate_limit=getattr(event, "delegate_limit", None),
    )


def build_member_payload(member: User, organization: Organization) -> dict:
    has_access = (
        member.is_admin
        or (
            member.is_email_verified
            and member.admin_decision == ApprovalDecision.approved
            and organization.fee_paid
        )
    )
    return {
        "id": member.id,
        "email": member.email,
        "first_name": member.first_name,
        "last_name": member.last_name,
        "is_admin": member.is_admin,
        "is_email_verified": member.is_email_verified,
        "admin_decision": member.admin_decision,
        "has_access": has_access,
        "is_voting_delegate": member.is_voting_delegate,
        "is_contact": member.is_organization_contact,
    }


def build_invitation_payload(invitation: OrganizationInvitation) -> dict:
    return {
        "id": invitation.id,
        "email": invitation.email,
        "role": invitation.role,
        "created_at": invitation.created_at,
        "invited_by_user_id": invitation.invited_by_user_id,
        "accepted_at": invitation.accepted_at,
        "first_name": invitation.first_name,
        "last_name": invitation.last_name,
        "organization_id": invitation.organization_id,
        "organization_name": invitation.organization.name if invitation.organization else "",
    }


def build_organization_event_assignment(
    organization: Organization,
    event: VotingEvent,
    *,
    current_time: datetime,
) -> OrganizationEventAssignment | None:
    event_date = getattr(event, "event_date", None)
    if event_date and event_date < current_time and not event.is_active:
        return None

    entries: list[OrganizationEventDelegate] = []
    delegate_user_ids: list[int] = []
    for delegate in getattr(event, "delegates", []) or []:
        if delegate.organization_id != organization.id or not delegate.user_id:
            continue
        user = delegate.user
        if user is None:
            continue
        entries.append(
            OrganizationEventDelegate(
                user_id=user.id,
                email=user.email,
                first_name=user.first_name,
                last_name=user.last_name,
            )
        )
        delegate_user_ids.append(user.id)

    can_manage = bool(
        event.is_active
        or event.delegate_deadline is None
        or event.delegate_deadline >= current_time
    )

    return OrganizationEventAssignment(
        event_id=event.id,
        title=event.title,
        description=event.description,
        event_date=event.event_date,
        delegate_deadline=event.delegate_deadline,
        is_active=event.is_active,
        is_voting_enabled=event.is_voting_enabled,
        delegate_limit=event.delegate_limit,
        delegate_count=len(delegate_user_ids),
        delegate_user_ids=delegate_user_ids,
        delegates=entries,
        can_manage_delegates=can_manage,
    )


def build_organization_detail(
    organization: Organization,
    *,
    active_event: VotingEvent | None,
    events: list[VotingEvent] | None = None,
) -> OrganizationDetail:
    members = [build_member_payload(member, organization) for member in organization.users]
    active_delegate_user_ids: list[int] = []
    if active_event is not None:
        for delegate in organization.event_delegates:
            if delegate.event_id == active_event.id and delegate.user_id:
                if delegate.user_id not in active_delegate_user_ids:
                    active_delegate_user_ids.append(delegate.user_id)
    active_delegate_user_id = (
        active_delegate_user_ids[0] if active_delegate_user_ids else None
    )
    contact_member = next((member for member in members if member.get("is_contact")), None)
    contact_invitation_payload: dict | None = None
    for invitation in getattr(organization, "invitations", []) or []:
        if invitation.role == InvitationRole.contact and invitation.accepted_at is None:
            contact_invitation_payload = build_invitation_payload(invitation)
            break
    if contact_member:
        contact_status = "assigned"
    elif contact_invitation_payload:
        contact_status = "invited"
    else:
        contact_status = "missing"
    contact_info = OrganizationContactInfo(
        status=contact_status,
        user=contact_member,
        invitation=contact_invitation_payload,
    )
    pending_member_invites = [
        build_invitation_payload(invitation)
        for invitation in getattr(organization, "invitations", []) or []
        if invitation.role == InvitationRole.member and invitation.accepted_at is None
    ]
    upcoming_assignments: list[OrganizationEventAssignment] = []
    if events is not None:
        now = datetime.utcnow()
        for event in events:
            assignment = build_organization_event_assignment(
                organization, event, current_time=now
            )
            if assignment is None:
                continue
            upcoming_assignments.append(assignment)

    return OrganizationDetail(
        id=organization.id,
        name=organization.name,
        fee_paid=organization.fee_paid,
        member_count=len(members),
        members=members,
        bank_name=organization.bank_name,
        bank_account_number=organization.bank_account_number,
        payment_instructions=organization.payment_instructions,
        active_event=active_event_info(active_event),
        active_event_delegate_user_id=active_delegate_user_id,
        active_event_delegate_user_ids=active_delegate_user_ids,
        contact=contact_info,
        pending_invitations=pending_member_invites,
        upcoming_events=upcoming_assignments,
    )


def build_event_read(event: VotingEvent) -> VotingEventRead:
    delegate_count = event_delegate_count(event)
    return VotingEventRead(
        id=event.id,
        title=event.title,
        description=event.description,
        event_date=event.event_date,
        delegate_deadline=event.delegate_deadline,
        is_active=event.is_active,
        is_voting_enabled=event.is_voting_enabled,
        delegate_limit=event.delegate_limit,
        created_at=event.created_at,
        delegate_count=delegate_count,
        can_delete=not event.is_active,
    )


def build_delegate_info(
    organization: Organization, delegates: dict[int, list[EventDelegate]]
) -> EventDelegateInfo:
    entries: list[dict] = []
    for delegate in delegates.get(organization.id, []):
        user = delegate.user
        if not user:
            continue
        entries.append(
            {
                "user_id": user.id,
                "user_email": user.email,
                "user_first_name": user.first_name,
                "user_last_name": user.last_name,
            }
        )
    return EventDelegateInfo(
        organization_id=organization.id,
        organization_name=organization.name,
        delegates=entries,
    )


@app.get("/", response_class=FileResponse)
def login_page() -> FileResponse:
    return FileResponse("app/static/login.html")


@app.get("/elfelejtett-jelszo", response_class=FileResponse)
def password_reset_request_page() -> FileResponse:
    return FileResponse("app/static/password-reset-request.html")


@app.get("/elfelejtett-jelszo/{token}", response_class=FileResponse)
def password_reset_confirm_page(token: str) -> FileResponse:
    return FileResponse("app/static/password-reset-confirm.html")


@app.get("/register", response_class=FileResponse)
def register_page() -> FileResponse:
    return FileResponse("app/static/register.html")


@app.get("/meghivas/{token}", response_class=FileResponse)
def invitation_accept_page(token: str) -> FileResponse:  # pragma: no cover - file response
    return FileResponse("app/static/invitation-accept.html")


@app.get("/jelszo-frissites", response_class=FileResponse)
def password_change_page() -> FileResponse:
    return FileResponse("app/static/password-change.html")


@app.get("/admin", response_class=FileResponse)
def admin_overview_page() -> FileResponse:
    return FileResponse("app/static/admin-overview.html")


@app.get("/admin/szervezetek", response_class=FileResponse)
def admin_organizations_page() -> FileResponse:
    return FileResponse("app/static/admin-organizations.html")


@app.get("/admin/jelentkezok", response_class=FileResponse)
def admin_pending_page() -> FileResponse:
    return FileResponse("app/static/admin-pending.html")


@app.get("/admin/esemenyek", response_class=FileResponse)
def admin_events_page() -> FileResponse:
    return FileResponse("app/static/admin-events.html")


@app.get("/admin/felhasznalok", response_class=FileResponse)
def admin_users_page() -> FileResponse:
    return FileResponse("app/static/admin-users.html")


@app.get("/admin/beallitasok", response_class=FileResponse)
def admin_settings_page() -> FileResponse:
    return FileResponse("app/static/admin-settings.html")


@app.get("/szervezetek/{organization_id}/dij", response_class=FileResponse)
def organization_unpaid_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-unpaid.html")


@app.get("/szervezetek/{organization_id}/tagok", response_class=FileResponse)
def organization_member_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-home.html")


@app.get("/szervezetek/{organization_id}/tagkezeles", response_class=FileResponse)
def organization_member_manage_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-members.html")


@app.get("/szervezetek/{organization_id}/szavazas", response_class=FileResponse)
def organization_voting_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-voting.html")


@app.post(
    "/api/organizations/{organization_id}/voting/o2auth",
    response_model=VotingO2AuthResponse,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
)
def create_voting_o2auth_session(
    organization_id: int,
    user: Annotated[User, Depends(get_session_user)],
    db: DatabaseDependency,
    launch: VotingO2AuthLaunchRequest | None = None,
) -> VotingO2AuthResponse:
    ensure_organization_membership(user, organization_id)
    organization = db.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Nem található szervezet",
        )
    if not organization.fee_paid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A szervezet tagsági díja rendezetlen, ezért nem nyitható meg a szavazási felület.",
        )
    active_event = get_active_voting_event(db)
    if active_event is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Jelenleg nincs aktív szavazási esemény.",
        )

    requested_view = (launch.view if launch else "default") or "default"

    if requested_view == "admin" and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Az admin nézet eléréséhez adminisztrátori jogosultság szükséges.",
        )

    if not user.is_admin and requested_view != "public":
        delegate_map = delegates_for_event(db, event_id=active_event.id)
        delegates = delegate_map.get(organization.id, []) if organization else []
        has_access = any(delegate.user_id == user.id for delegate in delegates)
        if not has_access:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Nem vagy kijelölve a szavazási eseményre ennél a szervezetnél.",
            )

    token = generate_voting_o2auth_token(
        user,
        organization,
        active_event,
        view=requested_view,
    )
    redirect = build_voting_redirect_url(token, view=requested_view)
    return VotingO2AuthResponse(
        redirect=redirect, expires_in=_effective_o2auth_ttl()
    )


@app.post(
    "/api/voting/authenticate",
    response_model=VotingAuthResponse,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
    },
)
def authenticate_for_voting(
    payload: VotingAuthRequest, db: DatabaseDependency
) -> VotingAuthResponse:
    _validate_voting_auth_request(payload)
    try:
        user = authenticate_user(db, email=payload.email, password=payload.password)
    except AuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc

    organization = user.organization
    organization_id = organization.id if organization else None
    organization_fee_paid = organization.fee_paid if organization else None

    active_event = get_active_voting_event(db)
    is_delegate = False
    if active_event and organization_id is not None:
        delegate_map = delegates_for_event(db, event_id=active_event.id)
        delegates = delegate_map.get(organization_id, [])
        is_delegate = any(delegate.user_id == user.id for delegate in delegates)

    if active_event is None and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Jelenleg nincs aktív szavazási esemény.",
        )

    if (
        active_event is not None
        and not active_event.is_voting_enabled
        and not user.is_admin
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A szavazási felület még nem elérhető ehhez az eseményhez.",
        )

    return VotingAuthResponse(
        email=user.email,
        is_admin=user.is_admin,
        first_name=user.first_name,
        last_name=user.last_name,
        organization_id=organization_id,
        organization_fee_paid=organization_fee_paid,
        must_change_password=user.must_change_password,
        active_event=active_event_info(active_event),
        is_event_delegate=is_delegate or user.is_admin,
    )


@app.get("/szervezetek/{organization_id}/penzugyek", response_class=FileResponse)
def organization_financial_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-financials.html")


@app.get(
    "/api/organizations",
    response_model=List[OrganizationRead],
    responses={404: {"model": ErrorResponse}},
)
def list_organizations(db: DatabaseDependency, q: str | None = None) -> List[OrganizationRead]:
    organizations = search_organizations(db, q)
    if not organizations:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Nem található szervezet a megadott feltételekkel",
        )
    return [OrganizationRead.from_orm(org) for org in organizations]


@app.get(
    "/api/organizations/lookup",
    response_model=List[OrganizationRead],
)
def lookup_organizations(db: DatabaseDependency, q: str | None = None) -> List[OrganizationRead]:
    return [OrganizationRead.from_orm(org) for org in search_organizations(db, q)]


@app.post(
    "/api/register",
    response_model=RegistrationResponse,
    responses={400: {"model": ErrorResponse}},
)
def register(
    payload: RegistrationRequest,
    request: Request,
    db: DatabaseDependency,
) -> RegistrationResponse:
    if RECAPTCHA_ENABLED:
        try:
            verify_recaptcha(
                payload.captcha_token or "",
                secret=RECAPTCHA_SECRET_KEY,
                remote_ip=request.client.host if request.client else None,
            )
        except RegistrationError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
            ) from exc
    try:
        token = register_user(
            db,
            email=payload.email,
            first_name=payload.first_name,
            last_name=payload.last_name,
            password=payload.password,
            organization_id=payload.organization_id,
            is_admin=payload.email.lower() in ADMIN_EMAILS,
        )
        link = queue_verification_email(
            token,
            base_url=PUBLIC_BASE_URL,
            api_key=BREVO_API_KEY or None,
            sender_email=BREVO_SENDER_EMAIL or None,
            sender_name=BREVO_SENDER_NAME,
        )
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    request.app.state.email_queue.append(
        {
            "email": payload.email,
            "token": token.token,
            "verification_link": link,
            "sent_via": "brevo" if BREVO_API_KEY and BREVO_SENDER_EMAIL else "noop",
        }
    )
    message = "Sikeres regisztráció. Kérjük, erősítsd meg az e-mail címedet."
    return RegistrationResponse(message=message)


@app.get("/api/debug/email-queue")
def email_queue(request: Request) -> list[dict[str, str]]:
    return list(getattr(request.app.state, "email_queue", []))


@app.get(
    "/api/verify-email",
    response_model=VerificationResponse,
    responses={400: {"model": ErrorResponse}},
)
def verify(token: str, db: DatabaseDependency) -> VerificationResponse:
    try:
        user = verify_email(db, token)
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if user.admin_decision == ApprovalDecision.pending:
        message = "Az e-mail cím igazolva. A fiók adminisztrátori jóváhagyásra vár."
    else:
        message = "Az e-mail cím igazolva."
    return VerificationResponse(message=message)


@app.post(
    "/api/login",
    response_model=LoginResponse,
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)
def login(request: LoginRequest, db: DatabaseDependency) -> LoginResponse:
    try:
        user = authenticate_user(db, email=request.email, password=request.password)
    except AuthenticationError as exc:
        detail = str(exc)
        forbidden_phrases = [
            "jóváhagyásra vár",
            "el lett utasítva",
            "erősítsd meg",
        ]
        status_code = (
            status.HTTP_403_FORBIDDEN
            if any(phrase in detail for phrase in forbidden_phrases)
            else status.HTTP_401_UNAUTHORIZED
        )
        raise HTTPException(status_code=status_code, detail=detail) from exc
    organization_id: int | None = user.organization.id if user.organization else None
    organization_fee_paid: bool | None = (
        user.organization.fee_paid if user.organization else None
    )
    if user.is_admin:
        redirect = ADMIN_REDIRECT_PATH
    elif organization_id is not None:
        redirect = (
            f"/szervezetek/{organization_id}/tagok"
            if organization_fee_paid
            else f"/szervezetek/{organization_id}/dij"
        )
    else:
        redirect = USER_REDIRECT_PATH
    session_token = create_session_token(db, user=user)
    db.commit()
    return LoginResponse(
        message="Sikeres bejelentkezés",
        redirect=redirect,
        is_admin=user.is_admin,
        token=session_token.token,
        organization_id=organization_id,
        organization_fee_paid=organization_fee_paid,
        must_change_password=user.must_change_password,
        is_organization_contact=user.is_organization_contact,
    )


@app.post(
    "/api/password-reset/request",
    response_model=SimpleMessageResponse,
    responses={400: {"model": ErrorResponse}},
)
def request_password_reset(
    payload: PasswordResetRequest, request: Request, db: DatabaseDependency
) -> SimpleMessageResponse:
    confirmation = (
        "Ha a megadott e-mail címmel létezik fiók, hamarosan levelet küldünk a folytatáshoz."
    )
    reset_token = issue_password_reset_token(
        db,
        email=payload.email,
        ttl_minutes=PASSWORD_RESET_TOKEN_TTL_MINUTES,
    )
    if not reset_token:
        db.rollback()
        return SimpleMessageResponse(message=confirmation)

    try:
        link = queue_password_reset_email(
            reset_token,
            base_url=PUBLIC_BASE_URL,
            api_key=BREVO_API_KEY or None,
            sender_email=BREVO_SENDER_EMAIL or None,
            sender_name=BREVO_SENDER_NAME,
        )
        db.commit()
    except (RegistrationError, PasswordResetError) as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    request.app.state.email_queue.append(
        {
            "email": reset_token.user.email,
            "token": reset_token.token,
            "reset_link": link,
            "sent_via": "brevo" if BREVO_API_KEY and BREVO_SENDER_EMAIL else "noop",
        }
    )
    return SimpleMessageResponse(message=confirmation)


@app.get(
    "/api/password-reset/verify",
    response_model=PasswordResetVerifyResponse,
    responses={400: {"model": ErrorResponse}},
)
def verify_password_reset(token: str, db: DatabaseDependency) -> PasswordResetVerifyResponse:
    try:
        reset_token = get_active_password_reset_token(db, token=token)
    except PasswordResetError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    message = "A jelszó-visszaállító link érvényes. Állíts be új jelszót az alábbi mezőkben."
    return PasswordResetVerifyResponse(email=reset_token.user.email, message=message)


@app.post(
    "/api/password-reset/confirm",
    response_model=SimpleMessageResponse,
    responses={400: {"model": ErrorResponse}},
)
def confirm_password_reset(
    payload: PasswordResetConfirmRequest, db: DatabaseDependency
) -> SimpleMessageResponse:
    try:
        complete_password_reset(
            db,
            token=payload.token,
            new_password=payload.password,
        )
        db.commit()
    except (PasswordResetError, RegistrationError) as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    return SimpleMessageResponse(
        message="Az új jelszó beállítása sikeres. Most már bejelentkezhetsz."
    )


@app.post(
    "/api/change-password",
    response_model=PasswordChangeResponse,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
def change_password(
    payload: PasswordChangeRequest,
    db: DatabaseDependency,
    user: Annotated[User, Depends(get_session_user)],
) -> PasswordChangeResponse:
    try:
        session_token = change_user_password(
            db,
            user=user,
            current_password=payload.current_password,
            new_password=payload.new_password,
        )
        db.commit()
    except (AuthenticationError, RegistrationError) as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return PasswordChangeResponse(
        message="A jelszavad sikeresen frissült.",
        token=session_token.token,
        must_change_password=user.must_change_password,
    )


@app.get("/api/public/config", response_model=PublicConfigResponse)
def public_config() -> PublicConfigResponse:
    if RECAPTCHA_ENABLED:
        return PublicConfigResponse(
            recaptcha_site_key=RECAPTCHA_SITE_KEY,
            captcha_provider="google_recaptcha",
        )
    return PublicConfigResponse(recaptcha_site_key=None, captcha_provider=None)


@app.get("/api/me", response_model=SessionUser, responses={401: {"model": ErrorResponse}})
def current_user(
    user: Annotated[User, Depends(get_session_user)], db: DatabaseDependency
) -> SessionUser:
    active_event = get_active_voting_event(db)
    return SessionUser(
        id=user.id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        is_admin=user.is_admin,
        organization=membership_info(user.organization),
        is_voting_delegate=user.is_voting_delegate,
        active_event=active_event_info(active_event),
        is_organization_contact=user.is_organization_contact,
    )


@app.get(
    "/api/admin/pending",
    response_model=List[PendingUser],
    responses={401: {"model": ErrorResponse}},
)
def admin_pending(
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> List[PendingUser]:
    users = list(pending_registrations(db))
    return [
        PendingUser(
            id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            organization=user.organization.name if user.organization else "Ismeretlen",
            is_email_verified=user.is_email_verified,
            created_at=user.created_at,
        )
        for user in users
    ]


@app.post(
    "/api/admin/users/{user_id}/decision",
    response_model=AdminDecisionResponse,
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def admin_decide(
    user_id: int,
    request: AdminDecisionRequest,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> AdminDecisionResponse:
    try:
        user = decide_registration(db, user_id=user_id, approve=request.approve)
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if request.approve:
        message = "A felhasználó jóvá lett hagyva és megerősítettnek tekintjük az e-mail címét."
    else:
        message = "A felhasználó elutasítva."
    return AdminDecisionResponse(message=message, decision=user.admin_decision)


@app.post(
    "/api/admin/organizations",
    status_code=status.HTTP_201_CREATED,
    response_model=OrganizationDetail,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
def create_organization_endpoint(
    payload: OrganizationCreateRequest,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> OrganizationDetail:
    try:
        organization = create_organization(
            db,
            name=payload.name,
            bank_name=payload.bank_name,
            bank_account_number=payload.bank_account_number,
            payment_instructions=payload.payment_instructions,
        )
        db.flush()
        active_event = get_active_voting_event(db)
        detail = build_organization_detail(organization, active_event=active_event)
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    db.commit()
    return detail


app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.get(
    "/api/admin/organizations",
    response_model=List[OrganizationDetail],
    responses={401: {"model": ErrorResponse}},
)
def admin_organizations(
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> List[OrganizationDetail]:
    organizations = organizations_with_members(db)
    active_event = get_active_voting_event(db)
    return [build_organization_detail(org, active_event=active_event) for org in organizations]


@app.post(
    "/api/admin/organizations/{organization_id}/fee",
    response_model=OrganizationDetail,
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def update_organization_fee(
    organization_id: int,
    payload: OrganizationFeeUpdate,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> OrganizationDetail:
    try:
        organization = set_organization_fee_status(
            db, organization_id=organization_id, fee_paid=payload.fee_paid
        )
        db.flush()
        active_event = get_active_voting_event(db)
        detail = build_organization_detail(organization, active_event=active_event)
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    db.commit()
    return detail


@app.post(
    "/api/admin/organizations/{organization_id}/billing",
    response_model=OrganizationDetail,
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def update_organization_billing(
    organization_id: int,
    payload: OrganizationBillingUpdate,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> OrganizationDetail:
    try:
        organization = set_organization_billing_details(
            db,
            organization_id=organization_id,
            bank_name=payload.bank_name,
            bank_account_number=payload.bank_account_number,
            payment_instructions=payload.payment_instructions,
        )
        db.flush()
        active_event = get_active_voting_event(db)
        detail = build_organization_detail(organization, active_event=active_event)
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    db.commit()
    return detail


@app.post(
    "/api/admin/organizations/{organization_id}/contact-invitations",
    response_model=OrganizationDetail,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
def create_contact_invitation_endpoint(
    organization_id: int,
    payload: InvitationCreateRequest,
    request: Request,
    db: DatabaseDependency,
    admin: Annotated[User, Depends(require_admin)],
) -> OrganizationDetail:
    invitation: OrganizationInvitation | None = None
    promoted_user: User | None = None
    if payload.role != InvitationRole.contact:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A kapcsolattartó meghívásához a role mezőnek 'contact'-nak kell lennie.",
        )
    try:
        invitation, promoted_user = create_contact_invitation(
            db,
            organization_id=organization_id,
            email=payload.email,
            invited_by=admin,
            first_name=payload.first_name,
            last_name=payload.last_name,
        )
        db.flush()
        organization = organization_with_members(db, organization_id)
        active_event = get_active_voting_event(db)
        detail = build_organization_detail(organization, active_event=active_event)
        link: str | None = None
        if invitation is not None:
            link = queue_invitation_email(
                invitation,
                base_url=PUBLIC_BASE_URL,
                api_key=BREVO_API_KEY or None,
                sender_email=BREVO_SENDER_EMAIL or None,
                sender_name=BREVO_SENDER_NAME,
            )
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        if "nem található" in lowered:
            status_code = status.HTTP_404_NOT_FOUND
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail=detail) from exc

    db.commit()
    if invitation is not None and link is not None:
        request.app.state.email_queue.append(
            {
                "email": invitation.email,
                "invitation_id": invitation.id,
                "token": invitation.token,
                "role": invitation.role.value,
                "link": link,
                "sent_via": "brevo"
                if BREVO_API_KEY and BREVO_SENDER_EMAIL
                else "noop",
            }
        )
    elif promoted_user is not None:
        request.app.state.email_queue.append(
            {
                "email": promoted_user.email,
                "invitation_id": None,
                "token": None,
                "role": InvitationRole.contact.value,
                "link": None,
                "sent_via": "existing-user",
            }
        )
    return detail


@app.get(
    "/api/invitations/{token}",
    response_model=OrganizationInvitationRead,
    responses={404: {"model": ErrorResponse}},
)
def get_invitation(token: str, db: DatabaseDependency) -> OrganizationInvitationRead:
    invitation = get_invitation_by_token(db, token=token)
    if invitation is None or invitation.accepted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="A meghívó nem található vagy már felhasználták.",
        )
    if invitation.organization is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="A meghívóhoz tartozó szervezet nem található.",
        )
    return OrganizationInvitationRead(
        id=invitation.id,
        email=invitation.email,
        role=invitation.role,
        created_at=invitation.created_at,
        invited_by_user_id=invitation.invited_by_user_id,
        accepted_at=invitation.accepted_at,
        first_name=invitation.first_name,
        last_name=invitation.last_name,
        organization_id=invitation.organization.id,
        organization_name=invitation.organization.name,
    )


@app.post(
    "/api/invitations/{token}/accept",
    response_model=SimpleMessageResponse,
    responses={400: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def accept_invitation_endpoint(
    token: str,
    payload: InvitationAcceptRequest,
    db: DatabaseDependency,
) -> SimpleMessageResponse:
    try:
        accept_invitation(
            db,
            token=token,
            first_name=payload.first_name,
            last_name=payload.last_name,
            password=payload.password,
        )
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        if "nem található" in lowered or "érvénytelen" in lowered:
            status_code = status.HTTP_404_NOT_FOUND
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail=detail) from exc

    return SimpleMessageResponse(
        message="Sikeres meghívó elfogadás. Most már bejelentkezhetsz az új jelszóval."
    )


@app.get(
    "/api/admin/events",
    response_model=List[VotingEventRead],
    responses={401: {"model": ErrorResponse}},
)
def list_voting_events_endpoint(
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> List[VotingEventRead]:
    events = list_voting_events(db)
    return [build_event_read(event) for event in events]


@app.post(
    "/api/admin/events",
    response_model=VotingEventRead,
    status_code=status.HTTP_201_CREATED,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
def create_voting_event_endpoint(
    payload: VotingEventCreateRequest,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> VotingEventRead:
    try:
        event = create_voting_event(
            db,
            title=payload.title,
            description=payload.description,
            event_date=payload.event_date,
            delegate_deadline=payload.delegate_deadline,
            delegate_limit=payload.delegate_limit,
            activate=payload.activate,
        )
        db.flush()
        db.refresh(event, attribute_names=["delegates"])
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    db.commit()
    _sync_active_event(db)
    return build_event_read(event)


@app.patch(
    "/api/admin/events/{event_id}",
    response_model=VotingEventRead,
    responses={
        401: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
def update_voting_event_endpoint(
    event_id: int,
    payload: VotingEventUpdateRequest,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> VotingEventRead:
    try:
        event = update_voting_event(
            db,
            event_id=event_id,
            title=payload.title,
            description=payload.description,
            event_date=payload.event_date,
            delegate_deadline=payload.delegate_deadline,
            delegate_limit=payload.delegate_limit,
        )
        db.flush()
        db.refresh(event, attribute_names=["delegates"])
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        status_code = (
            status.HTTP_404_NOT_FOUND
            if "nem található" in lowered
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=status_code, detail=detail) from exc

    db.commit()
    _sync_active_event(db)
    return build_event_read(event)


@app.post(
    "/api/admin/events/{event_id}/activate",
    response_model=VotingEventRead,
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def activate_voting_event_endpoint(
    event_id: int,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> VotingEventRead:
    try:
        event = set_active_voting_event(db, event_id)
        db.flush()
        db.refresh(event, attribute_names=["delegates"])
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    db.commit()
    _sync_active_event(db)
    return build_event_read(event)


@app.post(
    "/api/admin/events/{event_id}/access",
    response_model=VotingEventRead,
    responses={
        401: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
)
def update_event_accessibility(
    event_id: int,
    payload: VotingEventAccessUpdate,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> VotingEventRead:
    try:
        event = set_voting_event_accessibility(
            db, event_id=event_id, is_voting_enabled=payload.is_voting_enabled
        )
        db.flush()
        db.refresh(event, attribute_names=["delegates"])
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        status_code = (
            status.HTTP_404_NOT_FOUND
            if "nem található" in lowered
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=status_code, detail=detail) from exc

    db.commit()
    _sync_active_event(db)
    return build_event_read(event)


@app.get(
    "/api/admin/events/{event_id}/delegates",
    response_model=List[EventDelegateInfo],
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def list_event_delegates(
    event_id: int,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> List[EventDelegateInfo]:
    event = db.get(VotingEvent, event_id)
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nem található szavazási esemény")

    delegate_map = delegates_for_event(db, event_id=event_id)
    organizations = organizations_with_members(db)
    return [build_delegate_info(org, delegate_map) for org in organizations]


@app.post(
    "/api/admin/events/{event_id}/organizations/{organization_id}/delegates",
    response_model=SimpleMessageResponse,
    responses={
        401: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
)
def update_event_delegates(
    event_id: int,
    organization_id: int,
    payload: EventDelegateAssignmentRequest,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> SimpleMessageResponse:
    try:
        set_event_delegates_for_organization(
            db,
            event_id=event_id,
            organization_id=organization_id,
            user_ids=payload.user_ids,
        )
        db.flush()
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        status_code = (
            status.HTTP_404_NOT_FOUND
            if "nem található" in lowered
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=status_code, detail=detail) from exc

    db.commit()
    return SimpleMessageResponse(message="A szervezet delegáltjai frissítve.")


@app.delete(
    "/api/admin/events/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses={
        401: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
def delete_event_endpoint(
    event_id: int,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> Response:
    try:
        delete_voting_event(db, event_id=event_id)
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        status_code = (
            status.HTTP_400_BAD_REQUEST
            if "nem törölhető" in detail.lower()
            else status.HTTP_404_NOT_FOUND
        )
        raise HTTPException(status_code=status_code, detail=detail) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post(
    "/api/admin/events/reset",
    response_model=SimpleMessageResponse,
    responses={401: {"model": ErrorResponse}},
)
def reset_events_endpoint(
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> SimpleMessageResponse:
    removed = reset_voting_events(db)
    db.commit()
    _sync_voting_service(None)

    if removed == 0:
        message = "Nem volt törölhető esemény."
    elif removed == 1:
        message = "1 esemény és a kapcsolódó delegáltak törölve."
    else:
        message = f"{removed} esemény és a kapcsolódó delegáltak törölve."

    return SimpleMessageResponse(message=message)


@app.get(
    "/api/admin/admins",
    response_model=List[AdminUserRead],
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)
def list_admin_accounts(
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> List[AdminUserRead]:
    return list_admin_users(db)


@app.post(
    "/api/admin/admins",
    response_model=AdminUserCreateResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
    },
)
def create_admin_account_endpoint(
    payload: AdminUserCreateRequest,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> AdminUserCreateResponse:
    try:
        admin_user, temporary_password = create_admin_account(
            db,
            email=payload.email,
            first_name=payload.first_name,
            last_name=payload.last_name,
        )
        queue_admin_invitation_email(
            admin_user,
            temporary_password,
            base_url=PUBLIC_BASE_URL,
            api_key=BREVO_API_KEY or None,
            sender_email=BREVO_SENDER_EMAIL or None,
            sender_name=BREVO_SENDER_NAME or None,
        )
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    db.refresh(admin_user)
    message = (
        "Új adminisztrátor sikeresen létrehozva. Az első bejelentkezéskor jelszócsere szükséges."
    )
    return AdminUserCreateResponse(
        message=message, admin=admin_user, temporary_password=temporary_password
    )


@app.post(
    "/api/admin/admins/{admin_id}/resend-invite",
    response_model=SimpleMessageResponse,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
)
def resend_admin_invitation(
    admin_id: int,
    db: DatabaseDependency,
    current_admin: Annotated[User, Depends(require_admin)],
) -> SimpleMessageResponse:
    if admin_id == current_admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A saját adminisztrátori fiókhoz nem küldhetsz új meghívót.",
        )

    try:
        admin_user, temporary_password = reset_admin_temporary_password(
            db, user_id=admin_id
        )
        queue_admin_invitation_email(
            admin_user,
            temporary_password,
            base_url=PUBLIC_BASE_URL,
            api_key=BREVO_API_KEY or None,
            sender_email=BREVO_SENDER_EMAIL or None,
            sender_name=BREVO_SENDER_NAME or None,
        )
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        status_code_value = (
            status.HTTP_404_NOT_FOUND
            if "nem található" in detail.lower()
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=status_code_value, detail=detail) from exc

    message = "Új meghívó e-mail elküldve az adminisztrátornak."
    return SimpleMessageResponse(message=message)


@app.delete(
    "/api/admin/admins/{admin_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
)
def delete_admin(
    admin_id: int,
    db: DatabaseDependency,
    current_admin: Annotated[User, Depends(require_admin)],
) -> Response:
    try:
        delete_admin_account(
            db, admin_id=admin_id, acting_admin_id=current_admin.id
        )
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        status_code_value = (
            status.HTTP_404_NOT_FOUND
            if "nem található" in detail.lower()
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=status_code_value, detail=detail) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.delete(
    "/api/admin/users/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def delete_user(
    user_id: int,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> Response:
    try:
        delete_user_account(db, user_id=user_id)
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        status_code = (
            status.HTTP_400_BAD_REQUEST
            if "nem lehet törölni" in detail.lower()
            else status.HTTP_404_NOT_FOUND
        )
        raise HTTPException(status_code=status_code, detail=detail) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.delete(
    "/api/admin/organizations/{organization_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses={
        401: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
def delete_organization_endpoint(
    organization_id: int,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> Response:
    try:
        delete_organization(db, organization_id=organization_id)
        db.commit()
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        if "nem törölhető" in lowered:
            status_code = status.HTTP_400_BAD_REQUEST
        elif "nem található" in lowered:
            status_code = status.HTTP_404_NOT_FOUND
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail=detail) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get(
    "/api/organizations/{organization_id}/detail",
    response_model=OrganizationDetail,
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
def organization_detail_endpoint(
    organization_id: int,
    db: DatabaseDependency,
    user: Annotated[User, Depends(get_session_user)],
) -> OrganizationDetail:
    ensure_organization_membership(user, organization_id)
    try:
        organization = organization_with_members(db, organization_id)
    except RegistrationError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    active_event = get_active_voting_event(db)
    events = upcoming_voting_events(db)
    return build_organization_detail(
        organization, active_event=active_event, events=events
    )


@app.post(
    "/api/organizations/{organization_id}/invitations",
    response_model=OrganizationDetail,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
def create_member_invitation_endpoint(
    organization_id: int,
    payload: InvitationCreateRequest,
    request: Request,
    db: DatabaseDependency,
    user: Annotated[User, Depends(get_session_user)],
) -> OrganizationDetail:
    ensure_organization_membership(user, organization_id)
    role = payload.role
    if role == InvitationRole.contact and not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Csak az adminisztrátor hívhat meg új kapcsolattartót.",
        )
    if role == InvitationRole.member and not (user.is_admin or user.is_organization_contact):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Csak a szervezet kapcsolattartója küldhet tagmeghívót.",
        )

    invitation: OrganizationInvitation | None = None
    promoted_user: User | None = None
    try:
        if role == InvitationRole.contact:
            invitation, promoted_user = create_contact_invitation(
                db,
                organization_id=organization_id,
                email=payload.email,
                invited_by=user,
                first_name=payload.first_name,
                last_name=payload.last_name,
            )
        else:
            invitation = create_member_invitation(
                db,
                organization_id=organization_id,
                email=payload.email,
                invited_by=user,
                first_name=payload.first_name,
                last_name=payload.last_name,
            )
        db.flush()
        organization = organization_with_members(db, organization_id)
        active_event = get_active_voting_event(db)
        events = upcoming_voting_events(db)
        detail = build_organization_detail(
            organization, active_event=active_event, events=events
        )
        link: str | None = None
        if invitation is not None:
            link = queue_invitation_email(
                invitation,
                base_url=PUBLIC_BASE_URL,
                api_key=BREVO_API_KEY or None,
                sender_email=BREVO_SENDER_EMAIL or None,
                sender_name=BREVO_SENDER_NAME,
            )
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        if "nem található" in lowered:
            status_code = status.HTTP_404_NOT_FOUND
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail=detail) from exc

    db.commit()
    if invitation is not None and link is not None:
        request.app.state.email_queue.append(
            {
                "email": invitation.email,
                "invitation_id": invitation.id,
                "token": invitation.token,
                "role": invitation.role.value,
                "link": link,
                "sent_via": "brevo"
                if BREVO_API_KEY and BREVO_SENDER_EMAIL
                else "noop",
            }
        )
    elif promoted_user is not None:
        request.app.state.email_queue.append(
            {
                "email": promoted_user.email,
                "invitation_id": None,
                "token": None,
                "role": InvitationRole.contact.value,
                "link": None,
                "sent_via": "existing-user",
            }
        )
    return detail


@app.delete(
    "/api/organizations/{organization_id}/members/{member_id}",
    response_model=OrganizationDetail,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
def remove_organization_member_endpoint(
    organization_id: int,
    member_id: int,
    db: DatabaseDependency,
    user: Annotated[User, Depends(get_session_user)],
) -> OrganizationDetail:
    ensure_organization_membership(user, organization_id)
    if not (user.is_admin or user.is_organization_contact):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Csak a kapcsolattartó távolíthat el tagot a szervezetből.",
        )

    try:
        remove_member_from_organization(
            db,
            organization_id=organization_id,
            member_id=member_id,
        )
        db.flush()
        organization = organization_with_members(db, organization_id)
        active_event = get_active_voting_event(db)
        events = upcoming_voting_events(db)
        detail = build_organization_detail(
            organization,
            active_event=active_event,
            events=events,
        )
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        if "nem található" in lowered:
            status_code = status.HTTP_404_NOT_FOUND
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail=detail) from exc

    db.commit()
    return detail


@app.post(
    "/api/organizations/{organization_id}/events/{event_id}/delegates",
    response_model=OrganizationDetail,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
def set_organization_event_delegates(
    organization_id: int,
    event_id: int,
    payload: EventDelegateAssignmentRequest,
    db: DatabaseDependency,
    user: Annotated[User, Depends(get_session_user)],
) -> OrganizationDetail:
    ensure_organization_membership(user, organization_id)
    if not (user.is_admin or user.is_organization_contact):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Csak a szervezet kapcsolattartója jelölhet ki delegáltakat.",
        )

    try:
        set_event_delegates_for_organization(
            db,
            event_id=event_id,
            organization_id=organization_id,
            user_ids=payload.user_ids,
        )
        db.flush()
        organization = organization_with_members(db, organization_id)
        active_event = get_active_voting_event(db)
        events = upcoming_voting_events(db)
        detail = build_organization_detail(
            organization, active_event=active_event, events=events
        )
    except RegistrationError as exc:
        db.rollback()
        detail = str(exc)
        lowered = detail.lower()
        if "nem található" in lowered:
            status_code = status.HTTP_404_NOT_FOUND
        else:
            status_code = status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail=detail) from exc

    db.commit()
    return detail
