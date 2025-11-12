from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Annotated, List

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import inspect, text

from .database import Base, SessionLocal, engine
from .models import ApprovalDecision, Organization, User
from .schemas import (
    AdminDecisionRequest,
    AdminDecisionResponse,
    ErrorResponse,
    LoginRequest,
    LoginResponse,
    PasswordChangeRequest,
    PasswordChangeResponse,
    OrganizationBillingUpdate,
    OrganizationDetail,
    OrganizationFeeUpdate,
    OrganizationRead,
    PendingUser,
    PublicConfigResponse,
    RegistrationRequest,
    RegistrationResponse,
    OrganizationCreateRequest,
    OrganizationMembershipInfo,
    SessionUser,
    SimpleMessageResponse,
    VotingDelegateUpdate,
    VotingSSOResponse,
    VerificationResponse,
)
from .services import (
    AuthenticationError,
    RegistrationError,
    authenticate_user,
    change_user_password,
    create_organization,
    create_session_token,
    decide_registration,
    delete_organization,
    delete_user_account,
    organization_with_members,
    organizations_with_members,
    pending_registrations,
    queue_verification_email,
    register_user,
    resolve_session_user,
    search_organizations,
    set_organization_billing_details,
    set_organization_fee_status,
    set_voting_delegate,
    verify_email,
    verify_recaptcha,
)
from .security import hash_password

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
VOTING_SSO_SECRET = os.getenv("VOTING_SSO_SECRET", "development-secret") or "development-secret"
VOTING_SSO_TTL_SECONDS = int(os.getenv("VOTING_SSO_TTL_SECONDS", "300"))
VOTING_APP_BASE_URL = (
    os.getenv("VOTING_APP_BASE_URL", "http://localhost:3001").strip() or "http://localhost:3001"
)
BREVO_API_KEY = os.getenv("BREVO_API_KEY", "").strip()
BREVO_SENDER_EMAIL = os.getenv("BREVO_SENDER_EMAIL", "").strip()
BREVO_SENDER_NAME = os.getenv("BREVO_SENDER_NAME", "MikDashboard").strip() or "MikDashboard"
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip()
_VOTING_SSO_SECRET_BYTES = VOTING_SSO_SECRET.encode("utf-8")

app = FastAPI(title="MikDashboard Registration Service")


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_fee_paid_column()
    ensure_billing_columns()
    ensure_is_admin_column()
    ensure_voting_delegate_column()
    ensure_must_change_password_column()
    ensure_nullable_organization_column()
    ensure_name_columns()
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


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _effective_sso_ttl() -> int:
    return VOTING_SSO_TTL_SECONDS if VOTING_SSO_TTL_SECONDS > 0 else 300


def generate_voting_sso_token(user: User, organization: Organization) -> str:
    ttl = _effective_sso_ttl()
    payload = {
        "uid": user.id,
        "org": organization.id,
        "email": user.email,
        "role": "admin" if user.is_admin else "voter",
        "exp": int(time.time()) + ttl,
        "first_name": user.first_name,
        "last_name": user.last_name,
    }
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(_VOTING_SSO_SECRET_BYTES, body, hashlib.sha256).hexdigest()
    return f"{_base64url_encode(body)}.{signature}"


def build_voting_redirect_url(token: str) -> str:
    base = VOTING_APP_BASE_URL.rstrip("/")
    return f"{base}/sso?token={token}"


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


@app.get("/", response_class=FileResponse)
def login_page() -> FileResponse:
    return FileResponse("app/static/login.html")


@app.get("/register", response_class=FileResponse)
def register_page() -> FileResponse:
    return FileResponse("app/static/register.html")


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


@app.get("/szervezetek/{organization_id}/dij", response_class=FileResponse)
def organization_unpaid_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-unpaid.html")


@app.get("/szervezetek/{organization_id}/tagok", response_class=FileResponse)
def organization_member_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-home.html")


@app.get("/szervezetek/{organization_id}/szavazas", response_class=FileResponse)
def organization_voting_page(organization_id: int) -> FileResponse:
    return FileResponse("app/static/member-voting.html")


@app.post(
    "/api/organizations/{organization_id}/voting/sso",
    response_model=VotingSSOResponse,
    responses={
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
)
def create_voting_sso_session(
    organization_id: int,
    user: Annotated[User, Depends(get_session_user)],
    db: DatabaseDependency,
) -> VotingSSOResponse:
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
    if not user.is_admin and not user.is_voting_delegate:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Ehhez a szavazáshoz nincs jogosultságod.",
        )

    token = generate_voting_sso_token(user, organization)
    redirect = build_voting_redirect_url(token)
    return VotingSSOResponse(redirect=redirect, expires_in=_effective_sso_ttl())


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
def current_user(user: Annotated[User, Depends(get_session_user)]) -> SessionUser:
    return SessionUser(
        id=user.id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        is_admin=user.is_admin,
        organization=membership_info(user.organization),
        is_voting_delegate=user.is_voting_delegate,
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
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    detail = OrganizationDetail(
        id=organization.id,
        name=organization.name,
        fee_paid=organization.fee_paid,
        member_count=0,
        members=[],
        bank_name=organization.bank_name,
        bank_account_number=organization.bank_account_number,
        payment_instructions=organization.payment_instructions,
    )
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
    items: List[OrganizationDetail] = []
    for org in organizations:
        members = []
        for member in org.users:
            has_access = (
                member.is_admin
                or (
                    member.is_email_verified
                    and member.admin_decision == ApprovalDecision.approved
                    and org.fee_paid
                )
            )
            members.append(
                {
                    "id": member.id,
                    "email": member.email,
                    "first_name": member.first_name,
                    "last_name": member.last_name,
                    "is_admin": member.is_admin,
                    "is_email_verified": member.is_email_verified,
                    "admin_decision": member.admin_decision,
                    "has_access": has_access,
                    "is_voting_delegate": member.is_voting_delegate,
                }
            )
        items.append(
            OrganizationDetail(
                id=org.id,
                name=org.name,
                fee_paid=org.fee_paid,
                member_count=len(members),
                members=members,
                bank_name=org.bank_name,
                bank_account_number=org.bank_account_number,
                payment_instructions=org.payment_instructions,
            )
        )
    return items


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
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    members = []
    for member in organization.users:
        has_access = (
            member.is_admin
            or (
                member.is_email_verified
                and member.admin_decision == ApprovalDecision.approved
                and organization.fee_paid
            )
        )
        members.append(
            {
                "id": member.id,
                "email": member.email,
                "first_name": member.first_name,
                "last_name": member.last_name,
                "is_admin": member.is_admin,
                "is_email_verified": member.is_email_verified,
                "admin_decision": member.admin_decision,
                "has_access": has_access,
                "is_voting_delegate": member.is_voting_delegate,
            }
        )

    name = organization.name
    org_id = organization.id
    fee_paid = organization.fee_paid

    db.commit()

    return OrganizationDetail(
        id=org_id,
        name=name,
        fee_paid=fee_paid,
        member_count=len(members),
        members=members,
        bank_name=organization.bank_name,
        bank_account_number=organization.bank_account_number,
        payment_instructions=organization.payment_instructions,
    )


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
    except RegistrationError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    members = []
    for member in organization.users:
        has_access = (
            member.is_admin
            or (
                member.is_email_verified
                and member.admin_decision == ApprovalDecision.approved
                and organization.fee_paid
            )
        )
        members.append(
            {
                "id": member.id,
                "email": member.email,
                "first_name": member.first_name,
                "last_name": member.last_name,
                "is_admin": member.is_admin,
                "is_email_verified": member.is_email_verified,
                "admin_decision": member.admin_decision,
                "has_access": has_access,
                "is_voting_delegate": member.is_voting_delegate,
            }
        )

    db.commit()

    return OrganizationDetail(
        id=organization.id,
        name=organization.name,
        fee_paid=organization.fee_paid,
        member_count=len(members),
        members=members,
        bank_name=organization.bank_name,
        bank_account_number=organization.bank_account_number,
        payment_instructions=organization.payment_instructions,
    )


@app.post(
    "/api/admin/users/{user_id}/delegate",
    response_model=SimpleMessageResponse,
    responses={
        401: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
    },
)
def update_voting_delegate_endpoint(
    user_id: int,
    payload: VotingDelegateUpdate,
    db: DatabaseDependency,
    _: Annotated[User, Depends(require_admin)],
) -> SimpleMessageResponse:
    try:
        user = set_voting_delegate(db, user_id=user_id, is_delegate=payload.is_delegate)
        organization = user.organization
        if organization is None:
            raise RegistrationError("A felhasználó nincs szervezethez rendelve")
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
    return SimpleMessageResponse(message="A szavazási jogosultság frissítve.")


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

    members = []
    for member in organization.users:
        has_access = (
            member.is_admin
            or (
                member.is_email_verified
                and member.admin_decision == ApprovalDecision.approved
                and organization.fee_paid
            )
        )
        members.append(
            {
                "id": member.id,
                "email": member.email,
                "first_name": member.first_name,
                "last_name": member.last_name,
                "is_admin": member.is_admin,
                "is_email_verified": member.is_email_verified,
                "admin_decision": member.admin_decision,
                "has_access": has_access,
                "is_voting_delegate": member.is_voting_delegate,
            }
        )

    return OrganizationDetail(
        id=organization.id,
        name=organization.name,
        fee_paid=organization.fee_paid,
        member_count=len(members),
        members=members,
        bank_name=organization.bank_name,
        bank_account_number=organization.bank_account_number,
        payment_instructions=organization.payment_instructions,
    )
