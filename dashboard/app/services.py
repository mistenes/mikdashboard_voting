from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from io import BytesIO
from typing import Iterable, List, Literal, Optional
from zipfile import BadZipFile, ZipFile

import html
import logging
import secrets
import string
import uuid

import httpx

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from zoneinfo import ZoneInfo

from .models import (
    ApprovalDecision,
    EventDelegate,
    EmailVerificationToken,
    InvitationRole,
    Organization,
    OrganizationInvitation,
    PasswordResetToken,
    SessionToken,
    SiteSettings,
    User,
    VerificationStatus,
    VotingAccessCode,
    VotingEvent,
)
from .security import hash_password, verify_password


logger = logging.getLogger(__name__)


ACCESS_CODE_FONT_DOWNLOAD_SOURCES: tuple[tuple[str, str], ...] = (
    (
        "zip",
        "https://fonts.google.com/download?family=Noto%20Sans",
    ),
    (
        "ttf",
        "https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans-Regular.ttf",
    ),
)

ACCESS_CODE_REGULAR_FONT_NAME = "NotoSans-Regular"
ACCESS_CODE_BOLD_FONT_NAME = "NotoSans-Bold"


DELEGATE_TIMEZONE = ZoneInfo("Europe/Budapest")

ACCESS_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
ACCESS_CODE_LENGTH = 8
ACCESS_CODES_PER_PAGE = 12
SITE_SETTINGS_SINGLETON_ID = 1
SESSION_TOKEN_TTL_HOURS = 24


def _parse_access_code_font_zip(payload: bytes) -> dict[str, bytes]:
    fonts: dict[str, bytes] = {}
    try:
        with ZipFile(BytesIO(payload)) as archive:
            for member in archive.namelist():
                lower_name = member.lower()
                if lower_name.endswith("notosans-regular.ttf"):
                    fonts["regular"] = archive.read(member)
                elif lower_name.endswith("notosans-bold.ttf"):
                    fonts["bold"] = archive.read(member)
                elif lower_name.endswith("notosans-variablefont_wdthwght.ttf") or lower_name.endswith(
                    "notosans[wdth,wght].ttf"
                ):
                    data = archive.read(member)
                    fonts.setdefault("regular", data)
                    fonts.setdefault("bold", data)
    except BadZipFile as exc:
        raise RuntimeError("Érvénytelen Noto Sans ZIP archívum") from exc
    return fonts


def _parse_access_code_font_ttf(payload: bytes) -> dict[str, bytes]:
    if not payload:
        return {}
    return {
        "regular": payload,
        "bold": payload,
    }


@lru_cache(maxsize=1)
def _download_access_code_fonts() -> dict[str, bytes]:
    errors: list[str] = []
    for source_type, url in ACCESS_CODE_FONT_DOWNLOAD_SOURCES:
        try:
            response = httpx.get(url, timeout=20)
            response.raise_for_status()
            if source_type == "zip":
                fonts = _parse_access_code_font_zip(response.content)
            else:
                fonts = _parse_access_code_font_ttf(response.content)
        except Exception as exc:  # pragma: no cover - network error handling
            errors.append(f"{url}: {exc}")
            continue

        if fonts:
            return fonts
        errors.append(f"{url}: nem találtunk felhasználható betűkészletet")

    raise RuntimeError("Nem sikerült letölteni a Noto Sans betűt: " + "; ".join(errors))


@lru_cache(maxsize=1)
def _ensure_access_code_font_names() -> tuple[str, str]:
    fonts = _download_access_code_fonts()
    registered = set(pdfmetrics.getRegisteredFontNames())

    if ACCESS_CODE_REGULAR_FONT_NAME not in registered:
        regular_bytes = fonts.get("regular")
        if not regular_bytes:
            raise RuntimeError("Hiányzik a Noto Sans regular változata")
        pdfmetrics.registerFont(TTFont(ACCESS_CODE_REGULAR_FONT_NAME, BytesIO(regular_bytes)))

    if ACCESS_CODE_BOLD_FONT_NAME not in registered:
        bold_bytes = fonts.get("bold") or fonts.get("regular")
        if not bold_bytes:
            raise RuntimeError("Hiányzik a Noto Sans bold változata")
        pdfmetrics.registerFont(TTFont(ACCESS_CODE_BOLD_FONT_NAME, BytesIO(bold_bytes)))

    return ACCESS_CODE_REGULAR_FONT_NAME, ACCESS_CODE_BOLD_FONT_NAME


def _get_access_code_font_names() -> tuple[str, str]:
    try:
        return _ensure_access_code_font_names()
    except Exception as exc:  # pragma: no cover - fallback when fonts unreachable
        logger.warning("Nem sikerült letölteni a Noto Sans betűt, Helvetica lesz használva: %s", exc)
        return "Helvetica", "Helvetica-Bold"


def _fit_text_within_width(
    text: str,
    font_name: str,
    preferred_size: float,
    max_width: float,
    *,
    min_size: float = 8.0,
) -> float:
    if not text:
        return preferred_size

    width_at_preferred = pdfmetrics.stringWidth(text, font_name, preferred_size)
    if width_at_preferred <= max_width or width_at_preferred == 0:
        return preferred_size

    scaled_size = max_width * preferred_size / width_at_preferred
    return max(min_size, scaled_size)


def _sanitize_optional_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _mark_admin_password_initialized(user: User) -> None:
    if user.is_admin and user.seed_password_changed_at is None:
        user.seed_password_changed_at = datetime.utcnow()


def ensure_site_settings(session: Session) -> SiteSettings:
    settings = session.get(SiteSettings, SITE_SETTINGS_SINGLETON_ID)
    if settings is None:
        settings = SiteSettings(id=SITE_SETTINGS_SINGLETON_ID)
        session.add(settings)
        session.flush()
    return settings


def get_site_settings(session: Session) -> SiteSettings:
    return ensure_site_settings(session)


def update_site_bank_settings(
    session: Session,
    *,
    bank_name: Optional[str] = None,
    bank_account_number: Optional[str] = None,
) -> SiteSettings:
    settings = ensure_site_settings(session)
    settings.bank_name = _sanitize_optional_text(bank_name)
    settings.bank_account_number = _sanitize_optional_text(bank_account_number)
    return settings


def _log_brevo_delivery(kind: str, response: httpx.Response, *, extra: dict | None = None) -> None:
    metadata: dict[str, object] = {
        "brevo_status_code": response.status_code,
    }
    try:
        response_json = response.json()
    except Exception:  # pragma: no cover - defensive JSON parsing
        response_json = None

    if isinstance(response_json, dict):
        message_id = response_json.get("messageId")
        if message_id:
            metadata["brevo_message_id"] = message_id

    if extra:
        metadata.update(extra)

    logger.info("Brevo %s email sent", kind, extra=metadata)


class RegistrationError(Exception):
    pass


class AuthenticationError(Exception):
    pass


class PasswordResetError(Exception):
    pass


class VotingAccessCodeError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class VotingAccessCodeUnavailableError(VotingAccessCodeError):
    pass


def search_organizations(session: Session, query: Optional[str] = None) -> List[Organization]:
    stmt = select(Organization)
    if query:
        stmt = stmt.where(func.lower(Organization.name).contains(query.lower()))
    stmt = stmt.order_by(Organization.name.asc()).limit(20)
    return list(session.scalars(stmt))


def validate_password_strength(password: str) -> None:
    if len(password) < 8:
        raise RegistrationError("A jelszónak legalább 8 karakter hosszúnak kell lennie.")
    if not any(character.isupper() for character in password):
        raise RegistrationError("A jelszónak tartalmaznia kell legalább egy nagybetűt.")
    if not any(not character.isalnum() for character in password):
        raise RegistrationError("A jelszónak tartalmaznia kell legalább egy speciális karaktert.")


def register_user(
    session: Session,
    *,
    email: str,
    first_name: str,
    last_name: str,
    password: str,
    organization_id: int,
    is_admin: bool = False,
) -> EmailVerificationToken:
    validate_password_strength(password)
    organization = session.get(Organization, organization_id)
    if not organization:
        raise RegistrationError("Nem található a kiválasztott szervezet")

    salt, password_hash = hash_password(password)
    user = User(
        email=email.lower(),
        first_name=first_name,
        last_name=last_name,
        password_hash=password_hash,
        password_salt=salt,
        organization=organization,
        is_admin=is_admin,
    )
    if is_admin:
        user.admin_decision = ApprovalDecision.approved
    session.add(user)

    try:
        session.flush()
    except IntegrityError as exc:
        raise RegistrationError("Ezzel az e-mail címmel már létezik felhasználó") from exc

    token_value = EmailVerificationToken.new_token()
    token = EmailVerificationToken(user=user, token=token_value)
    session.add(token)
    return token


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def issue_password_reset_token(
    session: Session,
    *,
    email: str,
    ttl_minutes: int = 60,
) -> PasswordResetToken | None:
    normalized_email = _normalize_email(email)
    if not normalized_email:
        return None

    user = session.scalar(select(User).where(User.email == normalized_email).limit(1))
    if not user:
        return None

    if user.admin_decision == ApprovalDecision.denied:
        return None

    now = datetime.utcnow()
    existing_tokens = session.scalars(
        select(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > now,
        )
        .limit(20)
    )
    for token in existing_tokens:
        token.used_at = now

    reset_token = PasswordResetToken(
        user=user, expires_at=PasswordResetToken.default_expiration(ttl_minutes)
    )
    session.add(reset_token)
    session.flush()
    return reset_token


def get_active_password_reset_token(
    session: Session, *, token: str
) -> PasswordResetToken:
    value = (token or "").strip()
    if not value:
        raise PasswordResetError("Érvénytelen jelszó-visszaállító hivatkozás.")

    reset_token = session.scalar(
        select(PasswordResetToken)
        .options(selectinload(PasswordResetToken.user))
        .where(PasswordResetToken.token == value)
        .limit(1)
    )
    if not reset_token or not reset_token.user:
        raise PasswordResetError("A jelszó-visszaállító link érvénytelen.")

    now = datetime.utcnow()
    if reset_token.used_at is not None or reset_token.expires_at < now:
        raise PasswordResetError("A jelszó-visszaállító link lejárt vagy már felhasználták.")

    return reset_token


def complete_password_reset(
    session: Session,
    *,
    token: str,
    new_password: str,
) -> User:
    reset_token = get_active_password_reset_token(session, token=token)
    validate_password_strength(new_password)

    salt, password_hash = hash_password(new_password)
    user = reset_token.user
    if not user:
        raise PasswordResetError("Nem található a jelszóhoz tartozó felhasználó.")

    user.password_salt = salt
    user.password_hash = password_hash
    user.must_change_password = False
    _mark_admin_password_initialized(user)

    if not user.is_email_verified:
        user.is_email_verified = True
        now = datetime.utcnow()
        for token in getattr(user, "verification_tokens", []) or []:
            token.status = VerificationStatus.confirmed
            if token.confirmed_at is None:
                token.confirmed_at = now

    reset_token.used_at = datetime.utcnow()
    session.flush()
    return user


def list_admin_users(session: Session) -> List[User]:
    stmt = (
        select(User)
        .where(User.is_admin.is_(True))
        .order_by(User.created_at.asc())
    )
    return list(session.scalars(stmt))


def _generate_admin_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*()-_=+"
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(length))
        try:
            validate_password_strength(password)
        except RegistrationError:
            continue
        if not any(character.islower() for character in password):
            continue
        if not any(character.isdigit() for character in password):
            continue
        return password


def create_admin_account(
    session: Session,
    *,
    email: str,
    first_name: str,
    last_name: str,
) -> tuple[User, str]:
    normalized_email = _normalize_email(email)
    _ensure_email_available(session, normalized_email)

    password = _generate_admin_password()
    salt, password_hash = hash_password(password)
    user = User(
        email=normalized_email,
        first_name=first_name.strip() if first_name else None,
        last_name=last_name.strip() if last_name else None,
        password_hash=password_hash,
        password_salt=salt,
        is_admin=True,
        admin_decision=ApprovalDecision.approved,
        is_email_verified=True,
        must_change_password=True,
        is_voting_delegate=False,
        is_organization_contact=False,
        seed_password_changed_at=None,
    )
    session.add(user)
    session.flush()
    return user, password


def reset_admin_temporary_password(
    session: Session, *, user_id: int
) -> tuple[User, str]:
    user = session.get(User, user_id)
    if user is None or not user.is_admin:
        raise RegistrationError("Nem található adminisztrátori fiók.")

    password = _generate_admin_password()
    salt, password_hash = hash_password(password)
    user.password_salt = salt
    user.password_hash = password_hash
    user.must_change_password = True
    user.seed_password_changed_at = None
    user.is_email_verified = True
    user.updated_at = datetime.utcnow()
    session.flush()
    return user, password


def delete_admin_account(
    session: Session, *, admin_id: int, acting_admin_id: int | None = None
) -> None:
    admin_user = session.get(User, admin_id)
    if admin_user is None or not admin_user.is_admin:
        raise RegistrationError("Nem található adminisztrátori fiók.")

    if acting_admin_id is not None and admin_user.id == acting_admin_id:
        raise RegistrationError("A saját adminisztrátori fiókodat nem törölheted.")

    total_admins = session.scalar(
        select(func.count()).select_from(User).where(User.is_admin.is_(True))
    )
    if total_admins is not None and total_admins <= 1:
        raise RegistrationError(
            "Legalább egy adminisztrátornak maradnia kell a rendszerben."
        )

    session.delete(admin_user)


def queue_verification_email(
    token: EmailVerificationToken,
    *,
    base_url: str = "",
    api_key: str | None = None,
    sender_email: str | None = None,
    sender_name: str | None = None,
) -> str:
    if token.status == VerificationStatus.pending:
        token.status = VerificationStatus.sent

    base = base_url.rstrip("/") if base_url else ""
    verification_path = f"/api/verify-email?token={token.token}"
    verification_link = f"{base}{verification_path}" if base else verification_path

    if not api_key or not sender_email:
        logger.error(
            "Verification email attempted without Brevo configuration; email will not be sent",
            extra={"user_email": getattr(token.user, "email", None)},
        )
        raise RegistrationError(
            "Az e-mail megerősítő üzenetek küldése jelenleg nem elérhető. Vedd fel a kapcsolatot az adminisztrátorral."
        )

    recipient_email = getattr(token.user, "email", None)
    logger.info(
        "Dispatching Brevo verification email",
        extra={"user_email": recipient_email, "token_id": getattr(token, "id", None)},
    )

    recipient_name_parts = [token.user.first_name or "", token.user.last_name or ""]
    recipient_name = " ".join(part for part in recipient_name_parts if part).strip()
    if not recipient_name:
        recipient_name = token.user.email

    payload = {
        "sender": {"email": sender_email, "name": sender_name or sender_email},
        "to": [{"email": token.user.email, "name": recipient_name}],
        "subject": "Erősítsd meg az e-mail címedet",
        "htmlContent": (
            "<p>Köszönjük a regisztrációt a MIK Dashboard rendszerben.</p>"
            "<p>A regisztráció befejezéséhez kattints az alábbi gombra:</p>"
            f"<p><a href=\"{verification_link}\">E-mail cím megerősítése</a></p>"
            "<p>Ha nem te kezdeményezted a regisztrációt, kérjük, hagyd figyelmen kívül ezt az üzenetet.</p>"
        ),
        "textContent": (
            "Köszönjük a regisztrációt a MIK Dashboard rendszerben.\n"
            "A regisztráció befejezéséhez másold a böngésződbe az alábbi linket:\n"
            f"{verification_link}\n"
            "Ha nem te kezdeményezted a regisztrációt, kérjük, hagyd figyelmen kívül ezt az üzenetet."
        ),
    }

    headers = {
        "accept": "application/json",
        "api-key": api_key,
        "content-type": "application/json",
    }

    try:
        response = httpx.post(
            "https://api.brevo.com/v3/smtp/email",
            json=payload,
            headers=headers,
            timeout=15.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RegistrationError(
            "Nem sikerült elküldeni az e-mail megerősítést. Kérjük, próbáld újra később."
        ) from exc

    _log_brevo_delivery(
        "verification",
        response,
        extra={"user_email": recipient_email, "token_id": getattr(token, "id", None)},
    )

    return verification_link


def queue_invitation_email(
    invitation: OrganizationInvitation,
    *,
    base_url: str = "",
    api_key: str | None = None,
    sender_email: str | None = None,
    sender_name: str | None = None,
) -> str:
    base = base_url.rstrip("/") if base_url else ""
    accept_path = f"/meghivas/{invitation.token}"
    accept_link = f"{base}{accept_path}" if base else accept_path

    role_text = (
        "kapcsolattartójaként" if invitation.role == InvitationRole.contact else "tagjaként"
    )

    login_hint = (
        "<p>A belépéshez ezt az e-mail címet használd: "
        f"<strong>{html.escape(invitation.email)}</strong></p>"
    )

    subject = "MIK Dashboard meghívó"
    html_body = (
        f"<p>Meghívást kaptál a MIK Dashboard rendszerbe a(z) {invitation.organization.name} "
        f"szervezet {role_text}.</p>"
        "<p>A csatlakozáshoz kattints az alábbi gombra, és állítsd be a jelszavad:</p>"
        f"<p><a href=\"{accept_link}\">Csatlakozás a MIK Dashboardhoz</a></p>"
        f"{login_hint}"
        "<p>Ha nem vártad ezt a meghívót, hagyd figyelmen kívül ezt az üzenetet.</p>"
    )
    text_body = (
        f"Meghívást kaptál a MIK Dashboard rendszerbe a(z) {invitation.organization.name} "
        f"szervezet {role_text}.\n"
        "A csatlakozáshoz másold a böngésződbe az alábbi linket és állítsd be a jelszavad:\n"
        f"{accept_link}\n"
        f"A belépéshez ezt az e-mail címet használd: {invitation.email}\n"
        "Ha nem vártad ezt a meghívót, hagyd figyelmen kívül ezt az üzenetet."
    )

    if not api_key or not sender_email:
        logger.error(
            "Invitation email attempted without Brevo configuration; email will not be sent",
            extra={
                "invitation_email": invitation.email,
                "organization_id": invitation.organization_id,
            },
        )
        raise RegistrationError(
            "A meghívó e-mailek küldése jelenleg nem elérhető. Vedd fel a kapcsolatot az adminisztrátorral."
        )

    logger.info(
        "Dispatching Brevo invitation email",
        extra={
            "invitation_email": invitation.email,
            "organization_id": invitation.organization_id,
            "invitation_id": getattr(invitation, "id", None),
        },
    )

    payload = {
        "sender": {"email": sender_email, "name": sender_name or sender_email},
        "to": [{"email": invitation.email, "name": invitation.email}],
        "subject": subject,
        "htmlContent": html_body,
        "textContent": text_body,
    }

    headers = {
        "accept": "application/json",
        "api-key": api_key,
        "content-type": "application/json",
    }

    try:
        response = httpx.post(
            "https://api.brevo.com/v3/smtp/email",
            json=payload,
            headers=headers,
            timeout=15.0,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.exception("Brevo invitation email request failed with status error")
        error_detail = "Nem sikerült elküldeni a meghívó e-mailt. Kérjük, próbáld újra később."
        try:
            response_json = exc.response.json()
            message = response_json.get("message")
            if isinstance(message, str) and message.strip():
                error_detail = f"{error_detail} (Brevo: {message.strip()})"
        except Exception:  # pragma: no cover - defensive JSON parsing
            try:
                response_text = exc.response.text
                if response_text:
                    error_detail = f"{error_detail} (Brevo: {response_text.strip()})"
            except Exception:  # pragma: no cover - defensive response handling
                pass
        raise RegistrationError(error_detail) from exc
    except httpx.HTTPError as exc:
        logger.exception("Brevo invitation email request failed")
        raise RegistrationError(
            "Nem sikerült elküldeni a meghívó e-mailt. Kérjük, próbáld újra később."
        ) from exc

    _log_brevo_delivery(
        "invitation",
        response,
        extra={
            "invitation_email": invitation.email,
            "organization_id": invitation.organization_id,
            "invitation_id": getattr(invitation, "id", None),
        },
    )

    return accept_link


def queue_admin_invitation_email(
    admin: User,
    temporary_password: str,
    *,
    base_url: str = "",
    api_key: str | None = None,
    sender_email: str | None = None,
    sender_name: str | None = None,
) -> str:
    if not api_key or not sender_email:
        logger.error(
            "Admin invitation email attempted without Brevo configuration; email will not be sent",
            extra={"admin_email": getattr(admin, "email", None)},
        )
        raise RegistrationError(
            "Az adminisztrátori meghívó e-mail küldése jelenleg nem elérhető. Vedd fel a kapcsolatot a rendszer adminisztrátorával."
        )

    if not temporary_password:
        raise RegistrationError("Az ideiglenes jelszó hiányzik a meghívó e-mail küldéséhez.")

    base = base_url.rstrip("/") if base_url else ""
    login_link = f"{base}/" if base else "/"

    recipient_email = getattr(admin, "email", None)
    logger.info(
        "Dispatching Brevo admin invitation email",
        extra={"admin_email": recipient_email, "admin_id": getattr(admin, "id", None)},
    )

    recipient_name_parts = [admin.last_name or "", admin.first_name or ""]
    recipient_name = " ".join(part for part in recipient_name_parts if part).strip()
    if not recipient_name:
        recipient_name = recipient_email or "Adminisztrátor"

    html_content = (
        f"<p>Kedves {recipient_name}!</p>"
        "<p>Adminisztrátori hozzáférést kaptál a MIK Dashboard rendszerhez.</p>"
        f"<p>A belépéshez használd az alábbi ideiglenes jelszót: <strong>{temporary_password}</strong></p>"
        f"<p>A belépéshez ezt az e-mail címet használd: <strong>{html.escape(recipient_email)}</strong></p>"
        f"<p>Belépés: <a href=\"{login_link}\">{login_link}</a></p>"
        "<p>A jelszót az első bejelentkezés után kötelező megváltoztatni.</p>"
    )

    text_content = (
        "Kedves {name}!\n"
        "Adminisztrátori hozzáférést kaptál a MIK Dashboard rendszerhez.\n"
        "A belépéshez használd az alábbi ideiglenes jelszót: {password}\n"
        "A belépéshez ezt az e-mail címet használd: {email}\n"
        "Belépés: {link}\n"
        "A jelszót az első bejelentkezés után kötelező megváltoztatni."
    ).format(
        name=recipient_name,
        password=temporary_password,
        link=login_link,
        email=recipient_email,
    )

    payload = {
        "sender": {"email": sender_email, "name": sender_name or sender_email},
        "to": [{"email": recipient_email, "name": recipient_name}],
        "subject": "Adminisztrátori meghívó a MIK Dashboard rendszerbe",
        "htmlContent": html_content,
        "textContent": text_content,
    }

    headers = {
        "accept": "application/json",
        "api-key": api_key,
        "content-type": "application/json",
    }

    try:
        response = httpx.post(
            "https://api.brevo.com/v3/smtp/email",
            json=payload,
            headers=headers,
            timeout=15.0,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.exception("Brevo admin invitation email request failed with status error")
        raise RegistrationError(
            "Nem sikerült elküldeni az adminisztrátori meghívó e-mailt. Próbáld újra később."
        ) from exc
    except httpx.HTTPError as exc:
        logger.exception("Brevo admin invitation email request failed")
        raise RegistrationError(
            "Nem sikerült elküldeni az adminisztrátori meghívó e-mailt. Próbáld újra később."
        ) from exc

    _log_brevo_delivery(
        "admin_invite",
        response,
        extra={"admin_email": recipient_email, "admin_id": getattr(admin, "id", None)},
    )


def send_issue_report_email(
    *,
    name: str,
    message: str,
    api_key: str | None = None,
    sender_email: str | None = None,
    sender_name: str | None = None,
    recipient_email: str = "mistenes@me.com",
    page_url: str | None = None,
    user_agent: str | None = None,
) -> None:
    clean_message = (message or "").strip()
    if not clean_message:
        raise RegistrationError("Írd le röviden a tapasztalt hibát.")

    reporter_name = (name or "").strip() or "Ismeretlen felhasználó"

    if not api_key or not sender_email:
        logger.error(
            "Issue report email attempted without Brevo configuration; email will not be sent",
            extra={"recipient_email": recipient_email},
        )
        raise RegistrationError(
            "A hibajelentő jelenleg nem elérhető. Kérjük, próbáld meg később vagy jelezd a fejlesztőnek más csatornán."
        )

    preview = " ".join(clean_message.split())[:120]
    if page_url:
        preview = f"{preview} – {page_url}" if preview else page_url

    escaped_message = html.escape(clean_message).replace("\n", "<br />")

    html_lines = [
        f"<p><strong>Felhasználó:</strong> {html.escape(reporter_name)}</p>",
        f"<p><strong>Üzenet:</strong><br />{escaped_message}</p>",
    ]
    text_lines = [
        f"Felhasználó: {reporter_name}",
        "Üzenet:",
        clean_message,
    ]

    if page_url:
        html_lines.append(f"<p><strong>Oldal:</strong> {html.escape(page_url)}</p>")
        text_lines.append(f"Oldal: {page_url}")

    if user_agent:
        html_lines.append(f"<p><strong>Böngésző:</strong> {html.escape(user_agent)}</p>")
        text_lines.append(f"Böngésző: {user_agent}")

    payload = {
        "sender": {"email": sender_email, "name": sender_name or sender_email},
        "to": [{"email": recipient_email, "name": "Fejlesztő"}],
        "subject": f"MIK Dashboard hibajelentés – {preview or reporter_name}",
        "htmlContent": "".join(html_lines),
        "textContent": "\n".join(text_lines),
    }

    headers = {
        "accept": "application/json",
        "api-key": api_key,
        "content-type": "application/json",
    }

    logger.info(
        "Dispatching issue report email",
        extra={"recipient_email": recipient_email, "reporter": reporter_name, "page_url": page_url},
    )

    try:
        response = httpx.post(
            "https://api.brevo.com/v3/smtp/email",
            json=payload,
            headers=headers,
            timeout=15.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.exception("Issue report email request failed")
        raise RegistrationError(
            "Nem sikerült elküldeni a hibajelentést. Kérjük, próbáld újra később."
        ) from exc

    _log_brevo_delivery(
        "issue_report",
        response,
        extra={
            "recipient_email": recipient_email,
            "reporter_name": reporter_name,
            "page_url": page_url,
        },
    )


def queue_password_reset_email(
    token: PasswordResetToken,
    *,
    base_url: str = "",
    api_key: str | None = None,
    sender_email: str | None = None,
    sender_name: str | None = None,
) -> str:
    base = base_url.rstrip("/") if base_url else ""
    reset_path = f"/elfelejtett-jelszo/{token.token}"
    reset_link = f"{base}{reset_path}" if base else reset_path

    if not api_key or not sender_email:
        logger.error(
            "Password reset email attempted without Brevo configuration",
            extra={"user_email": getattr(token.user, "email", None)},
        )
        raise PasswordResetError(
            "A jelszó-visszaállító e-mail küldéséhez nincs beállítva e-mail szolgáltató."
        )

    user = token.user
    recipient_email = getattr(user, "email", None)
    logger.info(
        "Dispatching Brevo password reset email",
        extra={
            "user_email": recipient_email,
            "password_reset_token_id": getattr(token, "id", None),
        },
    )

    recipient_name_parts = [user.first_name or "", user.last_name or ""]
    recipient_name = " ".join(part for part in recipient_name_parts if part).strip()
    if not recipient_name:
        recipient_name = user.email

    subject = "MIK Dashboard jelszó visszaállítás"
    html_body = (
        "<p>Jelszó-visszaállítást kezdeményeztél a MIK Dashboard felületén.</p>"
        "<p>A folyamat befejezéséhez kattints az alábbi gombra, és állíts be új jelszót:</p>"
        f"<p><a href=\"{reset_link}\">Új jelszó beállítása</a></p>"
        "<p>Ha nem te kérted a jelszó módosítását, hagyd figyelmen kívül ezt az üzenetet.</p>"
    )
    text_body = (
        "Jelszó-visszaállítást kezdeményeztél a MIK Dashboard felületén.\n"
        "A folyamat befejezéséhez másold a böngésződbe az alábbi linket és állíts be új jelszót:\n"
        f"{reset_link}\n"
        "Ha nem te kérted a jelszó módosítását, hagyd figyelmen kívül ezt az üzenetet."
    )

    payload = {
        "sender": {"email": sender_email, "name": sender_name or sender_email},
        "to": [{"email": user.email, "name": recipient_name}],
        "subject": subject,
        "htmlContent": html_body,
        "textContent": text_body,
    }

    headers = {
        "accept": "application/json",
        "api-key": api_key,
        "content-type": "application/json",
    }

    try:
        response = httpx.post(
            "https://api.brevo.com/v3/smtp/email",
            json=payload,
            headers=headers,
            timeout=15.0,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        logger.exception("Brevo password reset email request failed with status error")
        error_detail = "Nem sikerült elküldeni a jelszó-visszaállító e-mailt. Kérjük, próbáld újra később."
        try:
            response_json = exc.response.json()
            message = response_json.get("message")
            if isinstance(message, str) and message.strip():
                error_detail = f"{error_detail} (Brevo: {message.strip()})"
        except Exception:  # pragma: no cover - defensive JSON parsing
            try:
                response_text = exc.response.text
                if response_text:
                    error_detail = f"{error_detail} (Brevo: {response_text.strip()})"
            except Exception:  # pragma: no cover - defensive response handling
                pass
        raise PasswordResetError(error_detail) from exc
    except httpx.HTTPError as exc:
        logger.exception("Brevo password reset email request failed")
        raise PasswordResetError(
            "Nem sikerült elküldeni a jelszó-visszaállító e-mailt. Kérjük, próbáld újra később."
        ) from exc

    _log_brevo_delivery(
        "password reset",
        response,
        extra={
            "user_email": recipient_email,
            "password_reset_token_id": getattr(token, "id", None),
        },
    )

    return reset_link


def verify_email(session: Session, token_value: str) -> User:
    stmt = select(EmailVerificationToken).where(EmailVerificationToken.token == token_value)
    token = session.scalar(stmt)
    if not token:
        raise RegistrationError("Érvénytelen megerősítő token")
    if token.status == VerificationStatus.confirmed:
        return token.user

    token.status = VerificationStatus.confirmed
    token.confirmed_at = datetime.utcnow()

    user = token.user
    user.is_email_verified = True
    if user.admin_decision == ApprovalDecision.pending:
        # Once email is verified, the user awaits admin approval.
        user.admin_decision = ApprovalDecision.pending
    return user


def create_session_token(session: Session, *, user: User) -> SessionToken:
    session.query(SessionToken).where(SessionToken.user_id == user.id).delete()
    token = SessionToken(
        user=user, expires_at=SessionToken.default_expiration(SESSION_TOKEN_TTL_HOURS)
    )
    session.add(token)
    session.flush()
    return token


def resolve_session_user(session: Session, token_value: str) -> Optional[User]:
    now = datetime.utcnow()
    stmt = select(SessionToken).where(SessionToken.token == token_value)
    session_token = session.scalar(stmt)
    if not session_token:
        return None
    if session_token.expires_at <= now:
        session.delete(session_token)
        session.flush()
        return None
    return session_token.user


def revoke_session_token(session: Session, token_value: str) -> bool:
    deleted = session.query(SessionToken).where(SessionToken.token == token_value).delete()
    session.flush()
    return bool(deleted)


def authenticate_user(session: Session, *, email: str, password: str) -> User:
    stmt = select(User).where(User.email == email.lower())
    user = session.scalar(stmt)
    if not user:
        raise AuthenticationError("Hibás bejelentkezési adatok")
    password_check = verify_password(password, user.password_salt, user.password_hash)
    if not password_check.is_valid:
        raise AuthenticationError("Hibás bejelentkezési adatok")
    if password_check.needs_rehash:
        salt, password_hash = hash_password(password)
        user.password_salt = salt
        user.password_hash = password_hash
        session.flush()
    if not user.is_email_verified:
        raise AuthenticationError("Bejelentkezés előtt erősítsd meg az e-mail címedet")
    if user.admin_decision == ApprovalDecision.denied:
        raise AuthenticationError("A regisztrációs kérelmed el lett utasítva")
    if user.admin_decision != ApprovalDecision.approved:
        raise AuthenticationError("A fiókod adminisztrátori jóváhagyásra vár")
    return user


def change_user_password(
    session: Session,
    *,
    user: User,
    current_password: str,
    new_password: str,
) -> SessionToken:
    password_check = verify_password(
        current_password, user.password_salt, user.password_hash
    )
    if not password_check.is_valid:
        raise AuthenticationError("A jelenlegi jelszó nem megfelelő")

    validate_password_strength(new_password)
    salt, password_hash = hash_password(new_password)
    user.password_salt = salt
    user.password_hash = password_hash
    user.must_change_password = False
    _mark_admin_password_initialized(user)

    session.query(SessionToken).where(SessionToken.user_id == user.id).delete()
    session.flush()
    return create_session_token(session, user=user)


def pending_registrations(session: Session) -> Iterable[User]:
    stmt = (
        select(User)
        .where(User.admin_decision == ApprovalDecision.pending)
        .order_by(User.is_email_verified.asc(), User.created_at.asc())
    )
    return session.scalars(stmt)


def decide_registration(session: Session, *, user_id: int, approve: bool) -> User:
    user = session.get(User, user_id)
    if not user:
        raise RegistrationError("Nem található felhasználó")
    if user.admin_decision != ApprovalDecision.pending:
        return user

    if approve:
        user.admin_decision = ApprovalDecision.approved
        user.is_email_verified = True
        now = datetime.utcnow()
        for token in user.verification_tokens:
            token.status = VerificationStatus.confirmed
            if token.confirmed_at is None:
                token.confirmed_at = now
    else:
        user.admin_decision = ApprovalDecision.denied
    return user


def create_organization(
    session: Session,
    *,
    name: str,
) -> Organization:
    cleaned = name.strip()
    if len(cleaned) < 2:
        raise RegistrationError("A szervezet neve legalább 2 karakter legyen.")

    existing_stmt = select(Organization).where(
        func.lower(Organization.name) == cleaned.lower()
    )
    if session.scalar(existing_stmt):
        raise RegistrationError("Ilyen nevű szervezet már létezik.")

    organization = Organization(
        name=cleaned,
    )
    session.add(organization)
    session.flush()
    return organization


def delete_organization(session: Session, *, organization_id: int) -> None:
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")
    if organization.users:
        raise RegistrationError(
            "A szervezet addig nem törölhető, amíg vannak hozzárendelt tagok."
        )
    session.delete(organization)


def organizations_with_members(session: Session) -> List[Organization]:
    stmt = (
        select(Organization)
        .options(
            selectinload(Organization.users),
            selectinload(Organization.event_delegates).selectinload(EventDelegate.user),
            selectinload(Organization.invitations).selectinload(
                OrganizationInvitation.invited_by_user
            ),
        )
        .order_by(Organization.name.asc())
    )
    return list(session.scalars(stmt))


def set_organization_fee_status(
    session: Session, *, organization_id: int, fee_paid: bool
) -> Organization:
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")
    organization.fee_paid = fee_paid
    return organization


def set_voting_delegate(
    session: Session, *, user_id: int, is_delegate: bool
) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise RegistrationError("Nem található felhasználó")
    if user.is_admin:
        raise RegistrationError(
            "Az adminisztrátorok jogosultsága nem módosítható ezen a felületen."
        )
    user.is_voting_delegate = is_delegate
    return user


def organization_with_members(session: Session, organization_id: int) -> Organization:
    stmt = (
        select(Organization)
        .where(Organization.id == organization_id)
        .options(
            selectinload(Organization.users),
            selectinload(Organization.event_delegates).selectinload(EventDelegate.user),
            selectinload(Organization.invitations).selectinload(
                OrganizationInvitation.invited_by_user
            ),
        )
    )
    organization = session.scalar(stmt)
    if organization is None:
        raise RegistrationError("Nem található szervezet")
    return organization


def sanitize_optional_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _ensure_user_can_delegate(user: User) -> None:
    if user.organization is None:
        raise RegistrationError("A felhasználó nincs szervezethez rendelve")
    if not user.is_email_verified or user.admin_decision != ApprovalDecision.approved:
        raise RegistrationError(
            "Csak jóváhagyott és megerősített tag jelölhető ki delegáltnak."
        )


def _normalize_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


DelegateLockMode = Literal["auto", "locked", "unlocked"]
DelegateLockReason = Literal[
    "deadline_passed",
    "deadline_pending",
    "manual_locked",
    "manual_unlocked",
    "manual_unlocked_after_deadline",
    "no_deadline",
]


@dataclass
class DelegateLockState:
    locked: bool
    mode: DelegateLockMode
    reason: DelegateLockReason
    message: str


def delegate_lock_state(
    event: VotingEvent, *, current_time: datetime | None = None
) -> DelegateLockState:
    if current_time is None:
        current_time = datetime.utcnow()

    if current_time.tzinfo is None:
        current_reference = current_time.replace(tzinfo=timezone.utc)
    else:
        current_reference = current_time.astimezone(timezone.utc)

    override = (event.delegate_lock_override or "").strip().lower() or None

    if override == "locked":
        return DelegateLockState(
            locked=True,
            mode="locked",
            reason="manual_locked",
            message="A delegáltak módosítása adminisztrátori döntés alapján zárolva.",
        )

    deadline = getattr(event, "delegate_deadline", None)
    deadline_passed = False
    if deadline is not None:
        if deadline.tzinfo is None:
            localized_deadline = deadline.replace(tzinfo=DELEGATE_TIMEZONE)
            comparison_time = current_reference.astimezone(DELEGATE_TIMEZONE)
        else:
            localized_deadline = deadline.astimezone(timezone.utc)
            comparison_time = current_reference
        deadline_passed = localized_deadline < comparison_time

    if override == "unlocked":
        reason: DelegateLockReason
        if deadline_passed:
            reason = "manual_unlocked_after_deadline"
            message = (
                "A delegált kijelölési határidő lejárt, de az adminisztrátor feloldotta a zárolást."
            )
        else:
            reason = "manual_unlocked"
            message = "A delegáltak módosítása adminisztrátori döntés alapján engedélyezett."
        return DelegateLockState(
            locked=False,
            mode="unlocked",
            reason=reason,
            message=message,
        )

    if deadline is None:
        return DelegateLockState(
            locked=False,
            mode="auto",
            reason="no_deadline",
            message="A delegáltak módosítása engedélyezett.",
        )

    if deadline_passed:
        return DelegateLockState(
            locked=True,
            mode="auto",
            reason="deadline_passed",
            message="A delegált kijelölési határidő lejárt, ezért a módosítás zárolva.",
        )

    return DelegateLockState(
        locked=False,
        mode="auto",
        reason="deadline_pending",
        message="A delegáltak módosítása engedélyezett a határidőig.",
    )


def set_delegate_lock_override(
    session: Session, event_id: int, *, mode: DelegateLockMode
) -> VotingEvent:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    if mode == "auto":
        event.delegate_lock_override = None
    elif mode == "locked":
        event.delegate_lock_override = "locked"
    elif mode == "unlocked":
        event.delegate_lock_override = "unlocked"
    else:  # pragma: no cover - defensive
        raise RegistrationError("Érvénytelen zárolási mód")

    session.flush()
    return event


def _canonicalize_access_code(value: str) -> str:
    cleaned = "".join(ch for ch in (value or "").upper() if ch.isalnum())
    if not cleaned:
        return ""
    if len(cleaned) != ACCESS_CODE_LENGTH:
        raise VotingAccessCodeError(
            "A megadott egyszer használható kód formátuma érvénytelen."
        )
    grouped = [cleaned[i : i + 4] for i in range(0, len(cleaned), 4)]
    return "-".join(grouped)


def _generate_access_code(existing: set[str]) -> str:
    while True:
        raw = "".join(secrets.choice(ACCESS_CODE_ALPHABET) for _ in range(ACCESS_CODE_LENGTH))
        formatted = "-".join(raw[i : i + 4] for i in range(0, len(raw), 4))
        if formatted not in existing:
            return formatted


def list_voting_access_codes(session: Session, event_id: int) -> list[VotingAccessCode]:
    stmt = (
        select(VotingAccessCode)
        .where(VotingAccessCode.event_id == event_id)
        .options(selectinload(VotingAccessCode.used_by_user))
        .order_by(VotingAccessCode.code.asc())
    )
    return list(session.scalars(stmt))


def generate_voting_access_codes(
    session: Session,
    event_id: int,
    *,
    regenerate: bool = True,
) -> list[VotingAccessCode]:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    delegate_total = session.scalar(
        select(func.count(EventDelegate.id)).where(EventDelegate.event_id == event_id)
    )
    if not delegate_total:
        raise VotingAccessCodeUnavailableError(
            "Nem található kijelölt delegált ehhez az eseményhez."
        )

    if regenerate:
        session.execute(
            delete(VotingAccessCode).where(VotingAccessCode.event_id == event_id)
        )
        session.flush()

    existing_codes = set(
        session.scalars(
            select(VotingAccessCode.code).where(VotingAccessCode.event_id == event_id)
        )
    )

    missing = max(delegate_total - len(existing_codes), 0)
    for _ in range(missing):
        new_code = _generate_access_code(existing_codes)
        existing_codes.add(new_code)
        session.add(VotingAccessCode(event_id=event_id, code=new_code))

    session.flush()
    return list_voting_access_codes(session, event_id)


def redeem_voting_access_code(
    session: Session,
    *,
    event_id: int,
    code_value: str,
    user: User,
) -> VotingAccessCode:
    if not code_value:
        raise VotingAccessCodeError(
            "Egyszer használható belépőkód megadása szükséges a belépéshez."
        )

    canonical = _canonicalize_access_code(code_value)

    stmt = (
        select(VotingAccessCode)
        .where(
            VotingAccessCode.event_id == event_id,
            VotingAccessCode.code == canonical,
        )
        .limit(1)
    )
    record = session.scalar(stmt)
    if record is None:
        raise VotingAccessCodeError("A megadott egyszer használható kód érvénytelen.")
    if record.used_at:
        raise VotingAccessCodeError("Ezt a belépőkódot már felhasználták.")

    record.used_at = datetime.utcnow()
    record.used_by_user_id = user.id if user and user.id else None
    session.flush()
    return record


def voting_access_code_summary(
    session: Session, event_id: int
) -> tuple[list[VotingAccessCode], int, int, int]:
    codes = list_voting_access_codes(session, event_id)
    total = len(codes)
    used = sum(1 for code in codes if code.used_at)
    available = total - used
    return codes, total, available, used


def build_access_code_pdf(event: VotingEvent, codes: list[VotingAccessCode]) -> bytes:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    margin_x = 25 * mm
    margin_y = 30 * mm
    columns = 3
    rows = 4
    cell_width = (width - 2 * margin_x) / columns
    cell_height = (height - 2 * margin_y) / rows
    regular_font, bold_font = _get_access_code_font_names()
    border_padding_x = 6 * mm
    border_padding_y = 8 * mm
    code_text_margin_x = 8 * mm
    if not codes:
        pdf.save()
        buffer.seek(0)
        return buffer.read()

    for index, code in enumerate(codes):
        if index and index % ACCESS_CODES_PER_PAGE == 0:
            pdf.showPage()

        position = index % ACCESS_CODES_PER_PAGE
        column = position % columns
        row = position // columns
        x = margin_x + column * cell_width
        y = height - margin_y - row * cell_height
        rect_x = x + border_padding_x
        rect_y = y - cell_height + border_padding_y
        rect_width = cell_width - 2 * border_padding_x
        rect_height = cell_height - 2 * border_padding_y
        pdf.setLineWidth(1)
        pdf.roundRect(rect_x, rect_y, rect_width, rect_height, 6, stroke=1, fill=0)
        code_max_width = rect_width - (2 * code_text_margin_x)
        font_size = _fit_text_within_width(
            code.code,
            bold_font,
            22,
            code_max_width,
            min_size=12,
        )
        pdf.setFont(bold_font, font_size)
        pdf.drawCentredString(
            rect_x + rect_width / 2,
            rect_y + rect_height / 2,
            code.code,
        )

    pdf.save()
    buffer.seek(0)
    return buffer.read()


def list_voting_events(session: Session) -> List[VotingEvent]:
    stmt = (
        select(VotingEvent)
        .options(
            selectinload(VotingEvent.delegates).selectinload(EventDelegate.user),
            selectinload(VotingEvent.access_codes).selectinload(
                VotingAccessCode.used_by_user
            ),
        )
        .order_by(VotingEvent.created_at.desc())
    )
    return list(session.scalars(stmt))


def upcoming_voting_events(session: Session) -> List[VotingEvent]:
    stmt = (
        select(VotingEvent)
        .options(
            selectinload(VotingEvent.delegates).selectinload(EventDelegate.user),
            selectinload(VotingEvent.access_codes).selectinload(
                VotingAccessCode.used_by_user
            ),
        )
        .order_by(
            case((VotingEvent.event_date.is_(None), 1), else_=0),
            VotingEvent.event_date.asc(),
            VotingEvent.created_at.desc(),
        )
    )
    return list(session.scalars(stmt))


def get_active_voting_event(session: Session) -> Optional[VotingEvent]:
    stmt = (
        select(VotingEvent)
        .where(VotingEvent.is_active.is_(True))
        .options(
            selectinload(VotingEvent.delegates).selectinload(EventDelegate.user),
            selectinload(VotingEvent.access_codes).selectinload(
                VotingAccessCode.used_by_user
            ),
        )
        .limit(1)
    )
    return session.scalar(stmt)


def create_voting_event(
    session: Session,
    *,
    title: str,
    description: Optional[str] = None,
    event_date: datetime,
    delegate_deadline: datetime,
    delegate_limit: int,
    activate: bool = False,
) -> VotingEvent:
    cleaned_title = title.strip()
    if len(cleaned_title) < 3:
        raise RegistrationError("Az esemény neve legalább 3 karakter legyen.")

    normalized_event_date = _normalize_datetime(event_date)
    normalized_delegate_deadline = _normalize_datetime(delegate_deadline)

    if normalized_delegate_deadline > normalized_event_date:
        raise RegistrationError(
            "A delegált kijelölési határidő nem lehet a rendezvény dátuma után."
        )

    if delegate_limit < 1:
        raise RegistrationError("A delegáltak száma legalább 1 kell legyen.")

    event = VotingEvent(
        title=cleaned_title,
        description=sanitize_optional_text(description),
        event_date=normalized_event_date,
        delegate_deadline=normalized_delegate_deadline,
        is_active=False,
        is_voting_enabled=False,
        delegate_limit=delegate_limit,
    )
    session.add(event)
    session.flush()

    has_active = get_active_voting_event(session)
    if activate or has_active is None:
        event = set_active_voting_event(session, event.id)
        if activate:
            event.is_voting_enabled = True
            session.flush()
    return event


def update_voting_event(
    session: Session,
    event_id: int,
    *,
    title: str,
    description: Optional[str] = None,
    event_date: datetime,
    delegate_deadline: datetime,
    delegate_limit: int,
) -> VotingEvent:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    cleaned_title = title.strip()
    if len(cleaned_title) < 3:
        raise RegistrationError("Az esemény neve legalább 3 karakter legyen.")

    normalized_event_date = _normalize_datetime(event_date)
    normalized_delegate_deadline = _normalize_datetime(delegate_deadline)

    if normalized_delegate_deadline > normalized_event_date:
        raise RegistrationError(
            "A delegált kijelölési határidő nem lehet a rendezvény dátuma után."
        )

    if delegate_limit < 1:
        raise RegistrationError("A delegáltak száma legalább 1 kell legyen.")

    event.title = cleaned_title
    event.description = sanitize_optional_text(description)
    event.event_date = normalized_event_date
    event.delegate_deadline = normalized_delegate_deadline
    event.delegate_limit = delegate_limit
    session.flush()
    return event


def set_active_voting_event(session: Session, event_id: int) -> VotingEvent:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    stmt = select(VotingEvent)
    for item in session.scalars(stmt):
        item.is_active = item.id == event.id
        if item.id != event.id and item.is_voting_enabled:
            item.is_voting_enabled = False
    session.flush()
    synchronize_delegate_flags(session, event)
    return event


def set_voting_event_accessibility(
    session: Session, event_id: int, *, is_voting_enabled: bool
) -> VotingEvent:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    if is_voting_enabled and not event.is_active:
        raise RegistrationError(
            "Csak az aktív esemény tehető elérhetővé a szavazási felületen."
        )

    event.is_voting_enabled = is_voting_enabled
    session.flush()
    return event


def delete_voting_event(session: Session, *, event_id: int) -> None:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    if event.is_active:
        raise RegistrationError("Az aktív esemény nem törölhető.")

    session.delete(event)
    session.flush()


def reset_voting_events(session: Session) -> int:
    event_ids = list(session.scalars(select(VotingEvent.id)))
    if not event_ids:
        return 0

    session.execute(delete(EventDelegate))
    session.execute(delete(VotingEvent))

    user_stmt = select(User).where(User.is_voting_delegate.is_(True))
    for user in session.scalars(user_stmt):
        user.is_voting_delegate = False

    session.flush()
    return len(event_ids)


def synchronize_delegate_flags(session: Session, active_event: Optional[VotingEvent]) -> None:
    active_delegate_ids: set[int] = set()
    if active_event is not None:
        refreshed = session.get(VotingEvent, active_event.id)
        if refreshed is not None:
            session.refresh(refreshed, attribute_names=["delegates"])
            for delegate in refreshed.delegates:
                if delegate.user_id:
                    active_delegate_ids.add(delegate.user_id)

    user_stmt = select(User).where(User.is_admin.is_(False))
    for user in session.scalars(user_stmt):
        user.is_voting_delegate = user.id in active_delegate_ids


def set_event_delegates_for_organization(
    session: Session,
    *,
    event_id: int,
    organization_id: int,
    user_ids: list[int],
) -> list[EventDelegate]:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    lock_state = delegate_lock_state(event)
    if lock_state.locked:
        raise RegistrationError(lock_state.message)

    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")

    normalized_ids: list[int] = []
    seen: set[int] = set()
    for user_id in user_ids:
        if user_id in seen:
            continue
        seen.add(user_id)
        normalized_ids.append(user_id)

    if event.delegate_limit is not None and len(normalized_ids) > event.delegate_limit:
        raise RegistrationError(
            "Egy szervezet legfeljebb a megadott számú delegáltat jelölheti."
        )

    users: dict[int, User] = {}
    for user_id in normalized_ids:
        user = session.get(User, user_id)
        if user is None:
            raise RegistrationError("Nem található felhasználó")
        _ensure_user_can_delegate(user)
        if user.organization_id != organization.id:
            raise RegistrationError(
                "A kiválasztott felhasználó nem ehhez a szervezethez tartozik."
            )
        users[user_id] = user

    stmt = (
        select(EventDelegate)
        .where(
            EventDelegate.event_id == event.id,
            EventDelegate.organization_id == organization.id,
        )
        .options(selectinload(EventDelegate.user))
    )
    existing = list(session.scalars(stmt))
    existing_by_user = {delegate.user_id: delegate for delegate in existing if delegate.user_id}

    updated: list[EventDelegate] = []

    for delegate in existing:
        if delegate.user_id not in seen:
            session.delete(delegate)

    for user_id in normalized_ids:
        delegate = existing_by_user.get(user_id)
        if delegate is None:
            delegate = EventDelegate(event=event, organization=organization, user=users[user_id])
            session.add(delegate)
        updated.append(delegate)

    if event.is_active:
        synchronize_delegate_flags(session, event)

    return updated


def delegates_for_event(
    session: Session, *, event_id: int
) -> dict[int, list[EventDelegate]]:
    stmt = (
        select(EventDelegate)
        .where(EventDelegate.event_id == event_id)
        .options(selectinload(EventDelegate.user), selectinload(EventDelegate.organization))
    )
    delegates: dict[int, list[EventDelegate]] = {}
    for delegate in session.scalars(stmt):
        delegates.setdefault(delegate.organization_id, []).append(delegate)
    for delegate_list in delegates.values():
        delegate_list.sort(key=lambda item: (item.created_at, item.id))
    return delegates


def _pending_invitation_query(
    session: Session,
    *,
    organization_id: int,
    email: str,
    role: InvitationRole,
) -> OrganizationInvitation | None:
    stmt = (
        select(OrganizationInvitation)
        .where(OrganizationInvitation.organization_id == organization_id)
        .where(func.lower(OrganizationInvitation.email) == email.lower())
        .where(OrganizationInvitation.role == role)
        .where(OrganizationInvitation.accepted_at.is_(None))
    )
    return session.scalar(stmt)


def _ensure_email_available(session: Session, email: str) -> None:
    stmt = select(User).where(func.lower(User.email) == email.lower())
    existing = session.scalar(stmt)
    if existing is not None:
        raise RegistrationError("Ezzel az e-mail címmel már létezik felhasználó")


def _create_invitation(
    session: Session,
    *,
    organization: Organization,
    email: str,
    role: InvitationRole,
    invited_by: User | None = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
) -> OrganizationInvitation:
    normalized_email = _normalize_email(email)
    _ensure_email_available(session, normalized_email)

    invitation = _pending_invitation_query(
        session,
        organization_id=organization.id,
        email=normalized_email,
        role=role,
    )
    token = uuid.uuid4().hex

    if invitation is None:
        invitation = OrganizationInvitation(
            organization=organization,
            email=normalized_email,
            role=role,
        )
        session.add(invitation)

    invitation.token = token
    invitation.invited_by_user = invited_by
    invitation.created_at = datetime.utcnow()
    invitation.accepted_at = None
    invitation.accepted_by_user = None
    invitation.first_name = first_name.strip() if first_name else None
    invitation.last_name = last_name.strip() if last_name else None

    session.flush()
    return invitation


def create_contact_invitation(
    session: Session,
    *,
    organization_id: int,
    email: str,
    invited_by: User,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
) -> tuple[OrganizationInvitation | None, User | None]:
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")

    normalized_email = _normalize_email(email)

    stmt = (
        select(User)
        .where(User.organization_id == organization_id)
        .where(User.is_organization_contact.is_(True))
    )
    existing_contact = session.scalar(stmt)
    if existing_contact is not None:
        if existing_contact.email and existing_contact.email.lower() == normalized_email:
            raise RegistrationError(
                "Ez a felhasználó már a szervezet kapcsolattartója"
            )
        raise RegistrationError("Ehhez a szervezethez már tartozik kapcsolattartó")

    user_stmt = select(User).where(func.lower(User.email) == normalized_email)
    existing_user = session.scalar(user_stmt)
    if existing_user is not None:
        raise RegistrationError(
            "Ezzel az e-mail címmel már létezik felhasználó a rendszerben"
        )

    invitation = _create_invitation(
        session,
        organization=organization,
        email=email,
        role=InvitationRole.contact,
        invited_by=invited_by,
        first_name=first_name,
        last_name=last_name,
    )

    return invitation, None


def create_member_invitation(
    session: Session,
    *,
    organization_id: int,
    email: str,
    invited_by: User,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
) -> OrganizationInvitation:
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")

    if invited_by.organization_id != organization.id and not invited_by.is_admin:
        raise RegistrationError(
            "Nincs jogosultság felhasználókat meghívni ehhez a szervezethez"
        )

    return _create_invitation(
        session,
        organization=organization,
        email=email,
        role=InvitationRole.member,
        invited_by=invited_by,
        first_name=first_name,
        last_name=last_name,
    )


def delete_contact_invitation(
    session: Session, *, organization_id: int, invitation_id: int
) -> None:
    invitation = session.get(OrganizationInvitation, invitation_id)
    if invitation is None or invitation.organization_id != organization_id:
        raise RegistrationError("Nem található kapcsolattartói meghívó")
    if invitation.role != InvitationRole.contact:
        raise RegistrationError("Ez a meghívó nem kapcsolattartói szerepkörhöz tartozik")
    if invitation.accepted_at is not None:
        raise RegistrationError("A meghívó már felhasználásra került")

    session.delete(invitation)


def delete_member_invitation(
    session: Session, *, organization_id: int, invitation_id: int
) -> None:
    invitation = session.get(OrganizationInvitation, invitation_id)
    if invitation is None or invitation.organization_id != organization_id:
        raise RegistrationError("Nem található tagmeghívó")
    if invitation.role != InvitationRole.member:
        raise RegistrationError("Ez a meghívó nem tag szerepkörhöz tartozik")
    if invitation.accepted_at is not None:
        raise RegistrationError("A meghívó már felhasználásra került")

    session.delete(invitation)


def pending_invitations(
    session: Session, *, organization_id: int, role: InvitationRole | None = None
) -> list[OrganizationInvitation]:
    stmt = (
        select(OrganizationInvitation)
        .where(OrganizationInvitation.organization_id == organization_id)
        .where(OrganizationInvitation.accepted_at.is_(None))
        .order_by(OrganizationInvitation.created_at.desc())
    )
    if role is not None:
        stmt = stmt.where(OrganizationInvitation.role == role)
    return list(session.scalars(stmt))


def get_invitation_by_token(
    session: Session, *, token: str
) -> OrganizationInvitation | None:
    stmt = (
        select(OrganizationInvitation)
        .where(OrganizationInvitation.token == token)
        .options(
            selectinload(OrganizationInvitation.organization),
            selectinload(OrganizationInvitation.invited_by_user),
        )
    )
    return session.scalar(stmt)


def accept_invitation(
    session: Session,
    *,
    token: str,
    first_name: str,
    last_name: str,
    password: str,
) -> User:
    invitation = get_invitation_by_token(session, token=token)
    if invitation is None or invitation.accepted_at is not None:
        raise RegistrationError("Érvénytelen vagy már felhasznált meghívó")

    organization = invitation.organization
    if organization is None:
        raise RegistrationError("Hiányzó szervezeti meghívó")

    normalized_email = _normalize_email(invitation.email)
    _ensure_email_available(session, normalized_email)

    if invitation.role == InvitationRole.contact:
        stmt = (
            select(User)
            .where(User.organization_id == organization.id)
            .where(User.is_organization_contact.is_(True))
        )
        existing_contact = session.scalar(stmt)
        if existing_contact is not None:
            raise RegistrationError("Ehhez a szervezethez már tartozik kapcsolattartó")

    salt, password_hash = hash_password(password)

    user = User(
        email=normalized_email,
        first_name=first_name,
        last_name=last_name,
        password_hash=password_hash,
        password_salt=salt,
        organization=organization,
        is_email_verified=True,
        admin_decision=ApprovalDecision.approved,
        is_admin=False,
        is_voting_delegate=False,
    )
    user.is_organization_contact = invitation.role == InvitationRole.contact

    session.add(user)
    session.flush()

    invitation.accepted_at = datetime.utcnow()
    invitation.accepted_by_user = user

    return user


def remove_member_from_organization(
    session: Session,
    *,
    organization_id: int,
    member_id: int,
) -> None:
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")

    member = session.get(User, member_id)
    if member is None or member.organization_id != organization_id:
        raise RegistrationError("Nem található tag a szervezetben")

    if member.is_admin:
        raise RegistrationError("Adminisztrátort nem lehet eltávolítani a szervezetből")

    if member.is_organization_contact:
        raise RegistrationError(
            "A kapcsolattartót nem lehet eltávolítani ezen a felületen"
        )

    session.execute(delete(EventDelegate).where(EventDelegate.user_id == member.id))

    member.organization = None
    member.is_voting_delegate = False
    member.is_organization_contact = False


def delete_user_account(session: Session, *, user_id: int) -> None:
    user = session.get(User, user_id)
    if user is None:
        raise RegistrationError("Nem található felhasználó")
    if user.is_admin:
        raise RegistrationError("Adminisztrátori fiókot nem lehet törölni")

    session.execute(delete(SessionToken).where(SessionToken.user_id == user.id))
    session.execute(
        delete(EmailVerificationToken).where(EmailVerificationToken.user_id == user.id)
    )
    session.execute(
        delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id)
    )
    session.execute(delete(EventDelegate).where(EventDelegate.user_id == user.id))

    session.execute(
        update(VotingAccessCode)
        .where(VotingAccessCode.used_by_user_id == user.id)
        .values(used_by_user_id=None)
    )
    session.execute(
        update(OrganizationInvitation)
        .where(OrganizationInvitation.accepted_by_user_id == user.id)
        .values(accepted_by_user_id=None)
    )
    session.execute(
        update(OrganizationInvitation)
        .where(OrganizationInvitation.invited_by_user_id == user.id)
        .values(invited_by_user_id=None)
    )

    user.organization = None
    user.is_voting_delegate = False
    user.is_organization_contact = False
    session.delete(user)


def verify_recaptcha(
    token: str, *, secret: str, remote_ip: str | None = None
) -> None:
    if not token:
        raise RegistrationError("Kérjük, fejezd be a robot elleni ellenőrzést.")

    payload = {"secret": secret, "response": token}
    if remote_ip:
        payload["remoteip"] = remote_ip

    try:
        response = httpx.post(
            "https://www.google.com/recaptcha/api/siteverify",
            data=payload,
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RegistrationError(
            "Nem sikerült ellenőrizni a robot elleni megoldást. Próbáld újra."
        ) from exc

    try:
        result = response.json()
    except ValueError as exc:  # pragma: no cover - defensive parsing
        raise RegistrationError(
            "Nem sikerült feldolgozni a robot elleni ellenőrzés válaszát."
        ) from exc

    if not result.get("success"):
        raise RegistrationError("A robot elleni ellenőrzés nem sikerült. Próbáld újra.")
