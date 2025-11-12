from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import AnyHttpUrl, BaseModel, EmailStr, Field, constr

from .models import ApprovalDecision, InvitationRole


class OrganizationRead(BaseModel):
    id: int
    name: str
    fee_paid: bool
    bank_name: Optional[str] = None
    bank_account_number: Optional[str] = None
    payment_instructions: Optional[str] = None

    class Config:
        orm_mode = True


class RegistrationRequest(BaseModel):
    email: EmailStr
    first_name: constr(strip_whitespace=True, min_length=1, max_length=100)
    last_name: constr(strip_whitespace=True, min_length=1, max_length=100)
    password: constr(min_length=8)
    organization_id: int
    captcha_token: Optional[str] = None


class RegistrationResponse(BaseModel):
    message: str


class VerificationResponse(BaseModel):
    message: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    message: str
    redirect: str
    is_admin: bool
    token: str
    organization_id: Optional[int] = None
    organization_fee_paid: Optional[bool] = None
    must_change_password: bool = False
    is_organization_contact: bool = False


class PendingUser(BaseModel):
    id: int
    email: EmailStr
    first_name: Optional[str]
    last_name: Optional[str]
    organization: str
    is_email_verified: bool
    registered_at: datetime = Field(..., alias="created_at")

    class Config:
        allow_population_by_field_name = True
        orm_mode = True


class AdminDecisionRequest(BaseModel):
    approve: bool
    notes: Optional[str] = None


class AdminDecisionResponse(BaseModel):
    message: str
    decision: ApprovalDecision


class ErrorResponse(BaseModel):
    detail: str


class ActiveEventInfo(BaseModel):
    id: int
    title: str
    description: Optional[str] = None
    event_date: Optional[datetime] = None
    delegate_deadline: Optional[datetime] = None
    is_voting_enabled: bool = False
    delegate_count: int = 0
    delegate_limit: Optional[int] = None


class OrganizationMember(BaseModel):
    id: int
    email: EmailStr
    first_name: Optional[str]
    last_name: Optional[str]
    is_admin: bool
    is_email_verified: bool
    admin_decision: ApprovalDecision
    has_access: bool
    is_voting_delegate: bool
    is_contact: bool = False


class OrganizationInvitationRead(BaseModel):
    id: int
    email: EmailStr
    role: InvitationRole
    created_at: datetime
    invited_by_user_id: Optional[int] = None
    accepted_at: Optional[datetime] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    organization_id: int
    organization_name: str


class OrganizationContactInfo(BaseModel):
    status: constr(strip_whitespace=True, min_length=1)
    user: Optional[OrganizationMember] = None
    invitation: Optional[OrganizationInvitationRead] = None


class OrganizationDetail(BaseModel):
    id: int
    name: str
    fee_paid: bool
    member_count: int
    members: list[OrganizationMember]
    bank_name: Optional[str] = None
    bank_account_number: Optional[str] = None
    payment_instructions: Optional[str] = None
    active_event: Optional[ActiveEventInfo] = None
    active_event_delegate_user_id: Optional[int] = None
    active_event_delegate_user_ids: list[int] = Field(default_factory=list)
    contact: Optional[OrganizationContactInfo] = None
    pending_invitations: list[OrganizationInvitationRead] = Field(default_factory=list)


class OrganizationFeeUpdate(BaseModel):
    fee_paid: bool


class OrganizationBillingUpdate(BaseModel):
    bank_name: Optional[str] = None
    bank_account_number: Optional[str] = None
    payment_instructions: Optional[str] = None


class PublicConfigResponse(BaseModel):
    recaptcha_site_key: Optional[str]
    captcha_provider: Optional[str]


class OrganizationCreateRequest(BaseModel):
    name: constr(strip_whitespace=True, min_length=2, max_length=255)
    bank_name: Optional[constr(strip_whitespace=True, max_length=255)] = None
    bank_account_number: Optional[constr(strip_whitespace=True, max_length=255)] = None
    payment_instructions: Optional[constr(strip_whitespace=True, max_length=500)] = None


class OrganizationMembershipInfo(BaseModel):
    id: int
    name: str
    fee_paid: bool
    bank_name: Optional[str] = None
    bank_account_number: Optional[str] = None
    payment_instructions: Optional[str] = None


class SessionUser(BaseModel):
    id: int
    email: EmailStr
    first_name: Optional[str]
    last_name: Optional[str]
    is_admin: bool
    organization: Optional[OrganizationMembershipInfo]
    is_voting_delegate: Optional[bool] = None
    active_event: Optional[ActiveEventInfo] = None
    is_organization_contact: bool = False


class VotingDelegateUpdate(BaseModel):
    is_delegate: bool


class VotingEventCreateRequest(BaseModel):
    title: constr(strip_whitespace=True, min_length=3, max_length=255)
    description: Optional[constr(strip_whitespace=True, max_length=500)] = None
    event_date: datetime
    delegate_deadline: datetime
    delegate_limit: int = Field(..., ge=1, le=500)
    activate: bool = False


class VotingEventUpdateRequest(BaseModel):
    title: constr(strip_whitespace=True, min_length=3, max_length=255)
    description: Optional[constr(strip_whitespace=True, max_length=500)] = None
    event_date: datetime
    delegate_deadline: datetime
    delegate_limit: int = Field(..., ge=1, le=500)


class VotingEventAccessUpdate(BaseModel):
    is_voting_enabled: bool


class VotingEventRead(BaseModel):
    id: int
    title: str
    description: Optional[str] = None
    event_date: Optional[datetime] = None
    delegate_deadline: Optional[datetime] = None
    is_active: bool
    is_voting_enabled: bool
    delegate_limit: Optional[int] = None
    created_at: datetime
    delegate_count: int = 0
    can_delete: bool = False


class InvitationCreateRequest(BaseModel):
    email: EmailStr
    first_name: Optional[constr(strip_whitespace=True, max_length=100)] = None
    last_name: Optional[constr(strip_whitespace=True, max_length=100)] = None
    role: InvitationRole


class InvitationAcceptRequest(BaseModel):
    first_name: constr(strip_whitespace=True, min_length=1, max_length=100)
    last_name: constr(strip_whitespace=True, min_length=1, max_length=100)
    password: constr(min_length=8)


class EventDelegateMember(BaseModel):
    user_id: int
    user_email: EmailStr
    user_first_name: Optional[str]
    user_last_name: Optional[str]


class EventDelegateInfo(BaseModel):
    organization_id: int
    organization_name: str
    delegates: list[EventDelegateMember] = Field(default_factory=list)


class EventDelegateAssignmentRequest(BaseModel):
    user_ids: list[int] = Field(default_factory=list)


class SimpleMessageResponse(BaseModel):
    message: str


class VotingO2AuthResponse(BaseModel):
    redirect: AnyHttpUrl
    expires_in: int


class VotingO2AuthLaunchRequest(BaseModel):
    view: Literal["default", "admin", "public"] = "default"


class VotingAuthRequest(BaseModel):
    email: EmailStr
    password: str
    timestamp: int
    signature: constr(strip_whitespace=True, min_length=1)


class VotingAuthResponse(BaseModel):
    email: EmailStr
    is_admin: bool
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    organization_id: Optional[int] = None
    organization_fee_paid: Optional[bool] = None
    must_change_password: bool = False
    active_event: Optional[ActiveEventInfo] = None
    is_event_delegate: bool = False


class PasswordChangeRequest(BaseModel):
    current_password: constr(min_length=1)
    new_password: constr(min_length=8)


class PasswordChangeResponse(BaseModel):
    message: str
    token: str
    must_change_password: bool
