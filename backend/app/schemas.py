from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from .models import CommandStatus, CommandType, DeviceStatus, EventType, PairingStatus


class DeviceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    serial_number: str = Field(min_length=1, max_length=120)
    model: str = Field(default="Meta Quest 2", max_length=80)


class DeviceRead(DeviceCreate):
    id: str
    status: DeviceStatus
    battery_percent: int | None
    firmware_version: str | None
    ip_address: str | None
    current_app: str | None
    last_seen_at: datetime | None
    created_at: datetime
    updated_at: datetime
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
