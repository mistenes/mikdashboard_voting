from __future__ import annotations

import enum
import uuid
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


class VerificationStatus(str, enum.Enum):
    pending = "pending"
    sent = "sent"
    confirmed = "confirmed"


class ApprovalDecision(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    denied = "denied"


class InvitationRole(str, enum.Enum):
    contact = "contact"
    member = "member"


class Organization(Base):
    __tablename__ = "organizations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False, index=True)
    fee_paid = Column(Boolean, default=False, nullable=False)
    bank_name = Column(String, nullable=True)
    bank_account_number = Column(String, nullable=True)
    payment_instructions = Column(String, nullable=True)

    users = relationship("User", back_populates="organization")
    event_delegates = relationship(
        "EventDelegate", back_populates="organization", cascade="all, delete-orphan"
    )
    invitations = relationship(
        "OrganizationInvitation",
        back_populates="organization",
        cascade="all, delete-orphan",
    )


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, nullable=False, index=True)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    password_hash = Column(String, nullable=False)
    password_salt = Column(String, nullable=False)
    organization_id = Column(Integer, ForeignKey("organizations.id"), nullable=True)
    is_email_verified = Column(Boolean, default=False, nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    admin_decision = Column(Enum(ApprovalDecision), default=ApprovalDecision.pending, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    is_voting_delegate = Column(Boolean, default=False, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)
    is_organization_contact = Column(Boolean, default=False, nullable=False)

    organization = relationship("Organization", back_populates="users")
    verification_tokens = relationship("EmailVerificationToken", back_populates="user")
    password_reset_tokens = relationship(
        "PasswordResetToken",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    event_delegations = relationship(
        "EventDelegate", back_populates="user", cascade="all, delete-orphan"
    )
    sent_invitations = relationship(
        "OrganizationInvitation",
        back_populates="invited_by_user",
        foreign_keys="OrganizationInvitation.invited_by_user_id",
    )
    accepted_invitations = relationship(
        "OrganizationInvitation",
        back_populates="accepted_by_user",
        foreign_keys="OrganizationInvitation.accepted_by_user_id",
    )


class EmailVerificationToken(Base):
    __tablename__ = "email_verification_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token = Column(String, unique=True, nullable=False, default=lambda: str(uuid.uuid4()))
    status = Column(Enum(VerificationStatus), default=VerificationStatus.pending, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    confirmed_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="verification_tokens")

    @staticmethod
    def new_token() -> str:
        return str(uuid.uuid4())


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token = Column(String, unique=True, nullable=False, default=lambda: uuid.uuid4().hex)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="password_reset_tokens")

    @staticmethod
    def default_expiration(minutes: int = 60) -> datetime:
        return datetime.utcnow() + timedelta(minutes=minutes)


class SessionToken(Base):
    __tablename__ = "session_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token = Column(String, unique=True, nullable=False, default=lambda: uuid.uuid4().hex)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User")


class VotingEvent(Base):
    __tablename__ = "voting_events"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    description = Column(String, nullable=True)
    event_date = Column(DateTime, nullable=True)
    delegate_deadline = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=False, nullable=False)
    is_voting_enabled = Column(Boolean, default=False, nullable=False)
    delegate_limit = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    delegates = relationship(
        "EventDelegate", back_populates="event", cascade="all, delete-orphan"
    )


class EventDelegate(Base):
    __tablename__ = "event_delegates"
    __table_args__ = (
        UniqueConstraint("event_id", "user_id", name="uq_event_user"),
    )

    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("voting_events.id"), nullable=False, index=True)
    organization_id = Column(
        Integer, ForeignKey("organizations.id"), nullable=False, index=True
    )
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    event = relationship("VotingEvent", back_populates="delegates")
    organization = relationship("Organization", back_populates="event_delegates")
    user = relationship("User", back_populates="event_delegations")


class OrganizationInvitation(Base):
    __tablename__ = "organization_invitations"

    id = Column(Integer, primary_key=True, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id"), nullable=False, index=True)
    email = Column(String, nullable=False, index=True)
    token = Column(String, unique=True, nullable=False, default=lambda: uuid.uuid4().hex)
    role = Column(Enum(InvitationRole), nullable=False)
    invited_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    accepted_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    accepted_at = Column(DateTime, nullable=True)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)

    organization = relationship("Organization", back_populates="invitations")
    invited_by_user = relationship(
        "User", back_populates="sent_invitations", foreign_keys=[invited_by_user_id]
    )
    accepted_by_user = relationship(
        "User", back_populates="accepted_invitations", foreign_keys=[accepted_by_user_id]
    )
