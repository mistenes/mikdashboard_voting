from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, List, Optional

import httpx

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .models import (
    ApprovalDecision,
    EventDelegate,
    EmailVerificationToken,
    Organization,
    SessionToken,
    VotingEvent,
    User,
    VerificationStatus,
)
from .security import hash_password, verify_password


class RegistrationError(Exception):
    pass


class AuthenticationError(Exception):
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
        return verification_link

    recipient_name_parts = [token.user.first_name or "", token.user.last_name or ""]
    recipient_name = " ".join(part for part in recipient_name_parts if part).strip()
    if not recipient_name:
        recipient_name = token.user.email

    payload = {
        "sender": {"email": sender_email, "name": sender_name or sender_email},
        "to": [{"email": token.user.email, "name": recipient_name}],
        "subject": "Erősítsd meg az e-mail címedet",
        "htmlContent": (
            "<p>Köszönjük a regisztrációt a MikDashboard rendszerben.</p>"
            "<p>A regisztráció befejezéséhez kattints az alábbi gombra:</p>"
            f"<p><a href=\"{verification_link}\">E-mail cím megerősítése</a></p>"
            "<p>Ha nem te kezdeményezted a regisztrációt, kérjük, hagyd figyelmen kívül ezt az üzenetet.</p>"
        ),
        "textContent": (
            "Köszönjük a regisztrációt a MikDashboard rendszerben.\n"
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

    return verification_link


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
    token = SessionToken(user=user)
    session.add(token)
    session.flush()
    return token


def resolve_session_user(session: Session, token_value: str) -> Optional[User]:
    stmt = select(SessionToken).where(SessionToken.token == token_value)
    session_token = session.scalar(stmt)
    if not session_token:
        return None
    return session_token.user


def authenticate_user(session: Session, *, email: str, password: str) -> User:
    stmt = select(User).where(User.email == email.lower())
    user = session.scalar(stmt)
    if not user:
        raise AuthenticationError("Hibás bejelentkezési adatok")
    if not verify_password(password, user.password_salt, user.password_hash):
        raise AuthenticationError("Hibás bejelentkezési adatok")
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
    if not verify_password(current_password, user.password_salt, user.password_hash):
        raise AuthenticationError("A jelenlegi jelszó nem megfelelő")

    validate_password_strength(new_password)
    salt, password_hash = hash_password(new_password)
    user.password_salt = salt
    user.password_hash = password_hash
    user.must_change_password = False

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
    bank_name: Optional[str] = None,
    bank_account_number: Optional[str] = None,
    payment_instructions: Optional[str] = None,
) -> Organization:
    cleaned = name.strip()
    if len(cleaned) < 2:
        raise RegistrationError("A szervezet neve legalább 2 karakter legyen.")

    existing_stmt = select(Organization).where(
        func.lower(Organization.name) == cleaned.lower()
    )
    if session.scalar(existing_stmt):
        raise RegistrationError("Ilyen nevű szervezet már létezik.")

    def sanitize(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    organization = Organization(
        name=cleaned,
        bank_name=sanitize(bank_name),
        bank_account_number=sanitize(bank_account_number),
        payment_instructions=sanitize(payment_instructions),
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


def set_organization_billing_details(
    session: Session,
    *,
    organization_id: int,
    bank_name: Optional[str] = None,
    bank_account_number: Optional[str] = None,
    payment_instructions: Optional[str] = None,
) -> Organization:
    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")

    def sanitize(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    organization.bank_name = sanitize(bank_name)
    organization.bank_account_number = sanitize(bank_account_number)
    organization.payment_instructions = sanitize(payment_instructions)
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


def list_voting_events(session: Session) -> List[VotingEvent]:
    stmt = (
        select(VotingEvent)
        .options(selectinload(VotingEvent.delegates))
        .order_by(VotingEvent.created_at.desc())
    )
    return list(session.scalars(stmt))


def get_active_voting_event(session: Session) -> Optional[VotingEvent]:
    stmt = (
        select(VotingEvent)
        .where(VotingEvent.is_active.is_(True))
        .options(selectinload(VotingEvent.delegates).selectinload(EventDelegate.user))
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

    event = VotingEvent(
        title=cleaned_title,
        description=sanitize_optional_text(description),
        event_date=normalized_event_date,
        delegate_deadline=normalized_delegate_deadline,
        is_active=False,
        is_voting_enabled=False,
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


def assign_event_delegate(
    session: Session,
    *,
    event_id: int,
    organization_id: int,
    user_id: int,
) -> EventDelegate:
    event = session.get(VotingEvent, event_id)
    if event is None:
        raise RegistrationError("Nem található szavazási esemény")

    organization = session.get(Organization, organization_id)
    if organization is None:
        raise RegistrationError("Nem található szervezet")

    user = session.get(User, user_id)
    if user is None:
        raise RegistrationError("Nem található felhasználó")
    _ensure_user_can_delegate(user)

    if user.organization_id != organization.id:
        raise RegistrationError(
            "A kiválasztott felhasználó nem ehhez a szervezethez tartozik."
        )

    stmt = (
        select(EventDelegate)
        .where(
            EventDelegate.event_id == event.id,
            EventDelegate.organization_id == organization.id,
        )
        .options(selectinload(EventDelegate.user))
    )
    existing = session.scalar(stmt)

    if existing:
        previous_user = existing.user
        existing.user = user
        existing.user_id = user.id
        if previous_user and previous_user.is_admin is False and event.is_active:
            previous_user.is_voting_delegate = False
        delegate = existing
    else:
        delegate = EventDelegate(event=event, organization=organization, user=user)
        session.add(delegate)

    if event.is_active:
        synchronize_delegate_flags(session, event)

    return delegate


def remove_event_delegate(
    session: Session,
    *,
    event_id: int,
    organization_id: int,
) -> None:
    stmt = (
        select(EventDelegate)
        .where(
            EventDelegate.event_id == event_id,
            EventDelegate.organization_id == organization_id,
        )
        .options(selectinload(EventDelegate.event), selectinload(EventDelegate.user))
    )
    delegate = session.scalar(stmt)
    if delegate is None:
        return

    event = delegate.event
    was_active = event.is_active if event else False
    session.delete(delegate)
    if was_active and event is not None:
        synchronize_delegate_flags(session, event)


def delegates_for_event(
    session: Session, *, event_id: int
) -> dict[int, EventDelegate]:
    stmt = (
        select(EventDelegate)
        .where(EventDelegate.event_id == event_id)
        .options(selectinload(EventDelegate.user), selectinload(EventDelegate.organization))
    )
    delegates = {}
    for delegate in session.scalars(stmt):
        delegates[delegate.organization_id] = delegate
    return delegates


def delete_user_account(session: Session, *, user_id: int) -> None:
    user = session.get(User, user_id)
    if user is None:
        raise RegistrationError("Nem található felhasználó")
    if user.is_admin:
        raise RegistrationError("Adminisztrátori fiókot nem lehet törölni")
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
