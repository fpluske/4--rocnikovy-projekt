from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class DeviceStatus(StrEnum):
    unknown = "unknown"
    online = "online"
    offline = "offline"


class CommandType(StrEnum):
    restart = "restart"
    shutdown = "shutdown"
    lock = "lock"
    unlock = "unlock"
    update = "update"


class CommandStatus(StrEnum):
    queued = "queued"
    sent = "sent"
    acknowledged = "acknowledged"
    completed = "completed"
    failed = "failed"


class EventType(StrEnum):
    device_registered = "device_registered"
    device_updated = "device_updated"
    command_created = "command_created"
    command_completed = "command_completed"
    heartbeat = "heartbeat"
    pairing_discovered = "pairing_discovered"
    pairing_confirmed = "pairing_confirmed"
    pairing_rejected = "pairing_rejected"


class PairingStatus(StrEnum):
    pending = "pending"
    confirmed = "confirmed"
    expired = "expired"
    rejected = "rejected"


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    serial_number: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    model: Mapped[str] = mapped_column(String(80), nullable=False, default="Meta Quest 2")
    status: Mapped[DeviceStatus] = mapped_column(String(20), nullable=False, default=DeviceStatus.unknown)
    battery_percent: Mapped[int | None] = mapped_column(Integer)
    firmware_version: Mapped[str | None] = mapped_column(String(80))
    ip_address: Mapped[str | None] = mapped_column(String(45))
    current_app: Mapped[str | None] = mapped_column(String(200))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    commands: Mapped[list["Command"]] = relationship(back_populates="device", cascade="all, delete-orphan")
    events: Mapped[list["AuditEvent"]] = relationship(back_populates="device", cascade="all, delete-orphan")


class PairingRequest(Base):
    __tablename__ = "pairing_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    serial_number: Mapped[str] = mapped_column(String(120), nullable=False)
    model: Mapped[str] = mapped_column(String(80), nullable=False, default="Meta Quest 2")
    nonce: Mapped[str] = mapped_column(String(128), nullable=False)
    pin_digest: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[PairingStatus] = mapped_column(String(20), nullable=False, default=PairingStatus.pending)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Command(Base):
    __tablename__ = "commands"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True, nullable=False)
    type: Mapped[CommandType] = mapped_column(String(30), nullable=False)
    status: Mapped[CommandStatus] = mapped_column(String(30), nullable=False, default=CommandStatus.queued)
    payload: Mapped[dict | None] = mapped_column(JSON)
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    device: Mapped[Device] = relationship(back_populates="commands")


class UpdatePackage(Base):
    __tablename__ = "update_packages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    version: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    download_url: Mapped[str | None] = mapped_column(String(500))
    checksum: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), index=True)
    type: Mapped[EventType] = mapped_column(String(40), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    device: Mapped[Device | None] = relationship(back_populates="events")
