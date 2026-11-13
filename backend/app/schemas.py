from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from .models import CommandStatus, CommandType, DeviceStatus, EventType, PairingStatus, UserRole


class SetupCreate(BaseModel):
    username: str = Field(min_length=3, max_length=120, pattern=r"^[a-zA-Z0-9._-]+$")
    password: str = Field(min_length=12, max_length=128)


class LoginCreate(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=128)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=120, pattern=r"^[a-zA-Z0-9._-]+$")
    password: str = Field(min_length=12, max_length=128)
    role: UserRole = UserRole.user


class UserRead(BaseModel):
    id: str
    username: str
    role: UserRole
    is_initial_admin: bool
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class AuthStatus(BaseModel):
    setup_required: bool
    user: UserRead | None = None


class DeviceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    serial_number: str = Field(min_length=1, max_length=120)
    model: str = Field(default="Meta Quest 2", max_length=80)


class DeviceRead(DeviceCreate):
    id: str
    status: DeviceStatus
    battery_percent: int | None
    is_charging: bool | None
    left_controller_battery_percent: int | None
    right_controller_battery_percent: int | None
    firmware_version: str | None
    horizon_os_version: str | None
    horizon_os_update_pending: bool
    ip_address: str | None
    current_app: str | None
    last_seen_at: datetime | None
    created_at: datetime
    updated_at: datetime
    model_config = ConfigDict(from_attributes=True)


class DeviceHeartbeat(BaseModel):
    serial_number: str = Field(min_length=1, max_length=120)
    status: DeviceStatus = DeviceStatus.online
    battery_percent: int | None = Field(default=None, ge=0, le=100)
    is_charging: bool | None = None
    left_controller_battery_percent: int | None = Field(default=None, ge=0, le=100)
    right_controller_battery_percent: int | None = Field(default=None, ge=0, le=100)
    firmware_version: str | None = Field(default=None, max_length=80)
    horizon_os_version: str | None = Field(default=None, max_length=120)
    horizon_os_update_pending: bool = False
    current_app: str | None = Field(default=None, max_length=200)


class UpdatePackageRead(BaseModel):
    id: str
    version: str
    download_url: str | None
    checksum: str | None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class CommandCreate(BaseModel):
    type: CommandType
    payload: dict | None = None


class CommandRead(CommandCreate):
    id: str
    device_id: str
    status: CommandStatus
    error_message: str | None
    created_at: datetime
    completed_at: datetime | None
    model_config = ConfigDict(from_attributes=True)


class CommandUpdate(BaseModel):
    status: CommandStatus
    error_message: str | None = None


class EventRead(BaseModel):
    id: str
    device_id: str | None
    type: EventType
    message: str
    metadata_json: dict | None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class PairingDiscovery(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    serial_number: str = Field(min_length=1, max_length=120)
    model: str = Field(default="Meta Quest 2", max_length=80)
    nonce: str = Field(min_length=16, max_length=128)
    pin: str | None = Field(default=None, pattern=r"^\d{4}$")
    pin_digest: str | None = Field(default=None, min_length=64, max_length=128)


class PairingRead(BaseModel):
    id: str
    name: str
    serial_number: str
    model: str
    status: PairingStatus
    expires_at: datetime
    confirmed_at: datetime | None
    device_id: str | None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class PairingConfirm(BaseModel):
    pin: str = Field(pattern=r"^\d{4}$")


class HealthRead(BaseModel):
    status: str
    database: str
