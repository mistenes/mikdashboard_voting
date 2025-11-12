from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, Column, DateTime, Enum, ForeignKey, Integer, String
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


class Organization(Base):
    __tablename__ = "organizations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False, index=True)
    fee_paid = Column(Boolean, default=False, nullable=False)
    bank_name = Column(String, nullable=True)
    bank_account_number = Column(String, nullable=True)
    payment_instructions = Column(String, nullable=True)

    users = relationship("User", back_populates="organization")


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

    organization = relationship("Organization", back_populates="users")
    verification_tokens = relationship("EmailVerificationToken", back_populates="user")


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


class SessionToken(Base):
    __tablename__ = "session_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token = Column(String, unique=True, nullable=False, default=lambda: uuid.uuid4().hex)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User")
