from datetime import datetime, timedelta, timezone
import hashlib

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, engine, get_db
from .models import AuditEvent, Command, CommandStatus, Device, DeviceStatus, EventType, PairingRequest, PairingStatus
from .schemas import (
    CommandUpdate,
    CommandCreate, CommandRead, DeviceCreate, DeviceHeartbeat, DeviceRead, EventRead, HealthRead,
    PairingConfirm, PairingDiscovery, PairingRead,
)

Base.metadata.create_all(bind=engine)

DEVICE_OFFLINE_AFTER = timedelta(seconds=30)

app = FastAPI(title="Orbit Quest Management API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

webrtc_connections: dict[str, set[WebSocket]] = {}


@app.websocket("/api/webrtc/{device_id}")
async def webrtc_signaling(device_id: str, websocket: WebSocket) -> None:
    await websocket.accept()
    connections = webrtc_connections.setdefault(device_id, set())
    connections.add(websocket)
    try:
        while True:
            message = await websocket.receive_text()
            for peer in tuple(connections):
                if peer is not websocket:
                    try:
                        await peer.send_text(message)
                    except (RuntimeError, WebSocketDisconnect):
                        connections.discard(peer)
    except WebSocketDisconnect:
        connections.discard(websocket)
    finally:
        if not connections:
            webrtc_connections.pop(device_id, None)


@app.get("/api/webrtc/config", tags=["webrtc"])
def webrtc_config() -> dict[str, list[dict]]:
    return {"ice_servers": settings.webrtc_ice_server_list}


@app.get("/api/health", response_model=HealthRead, tags=["system"])
def health(db: Session = Depends(get_db)) -> HealthRead:
    try:
        db.execute(text("SELECT 1"))
    except Exception as error:
        raise HTTPException(status_code=503, detail="Databáze není dostupná.") from error
    return HealthRead(status="ok", database="ok")


@app.get("/api/devices", response_model=list[DeviceRead], tags=["devices"])
def list_devices(db: Session = Depends(get_db)) -> list[Device]:
    now = utc_now()
    devices = list(db.scalars(select(Device).order_by(Device.created_at.desc())))
    changed = False
    for device in devices:
        if device.last_seen_at is not None and as_utc(device.last_seen_at) + DEVICE_OFFLINE_AFTER < now:
            if device.status != DeviceStatus.offline:
                device.status = DeviceStatus.offline
                changed = True
    if changed:
        db.commit()
    return devices


def pin_digest(nonce: str, pin: str) -> str:
    return hashlib.sha256(f"{nonce}:{pin}".encode("utf-8")).hexdigest()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def expire_pairing_requests(db: Session) -> None:
    now = utc_now()
    requests = db.scalars(
        select(PairingRequest).where(
            PairingRequest.status == PairingStatus.pending,
        )
    )
    for pairing in requests:
        if as_utc(pairing.expires_at) < now:
            pairing.status = PairingStatus.expired


@app.get("/api/pairing", response_model=list[PairingRead], tags=["pairing"])
def list_pairing_requests(db: Session = Depends(get_db)) -> list[PairingRequest]:
    expire_pairing_requests(db)
    db.commit()
    return list(db.scalars(
        select(PairingRequest)
        .where(PairingRequest.status == PairingStatus.pending)
        .order_by(PairingRequest.created_at.desc())
    ))


@app.post("/api/pairing/discover", response_model=PairingRead, status_code=status.HTTP_201_CREATED, tags=["pairing"])
def discover_device(data: PairingDiscovery, db: Session = Depends(get_db)) -> PairingRequest:
    if data.pin is None and data.pin_digest is None:
        raise HTTPException(status_code=400, detail="Discovery musí obsahovat PIN důkaz.")
    digest = data.pin_digest or pin_digest(data.nonce, data.pin or "")
    pairing = PairingRequest(
        name=data.name,
        serial_number=data.serial_number,
        model=data.model,
        nonce=data.nonce,
        pin_digest=digest,
        expires_at=utc_now() + timedelta(minutes=5),
    )
    db.add(pairing)
    db.add(AuditEvent(type=EventType.pairing_discovered, message=f"Objeveno zařízení {data.name}."))
    db.commit()
    db.refresh(pairing)
    return pairing


@app.get("/api/pairing/{pairing_id}", response_model=PairingRead, tags=["pairing"])
def get_pairing(pairing_id: str, db: Session = Depends(get_db)) -> PairingRequest:
    pairing = db.get(PairingRequest, pairing_id)
    if pairing is None:
        raise HTTPException(status_code=404, detail="Pairing žádost nebyla nalezena.")
    if pairing.status == PairingStatus.pending and as_utc(pairing.expires_at) < utc_now():
        pairing.status = PairingStatus.expired
        db.commit()
        db.refresh(pairing)
    return pairing


@app.post("/api/pairing/{pairing_id}/confirm", response_model=DeviceRead, tags=["pairing"])
def confirm_pairing(pairing_id: str, data: PairingConfirm, db: Session = Depends(get_db)) -> Device:
    pairing = db.get(PairingRequest, pairing_id)
    if pairing is None:
        raise HTTPException(status_code=404, detail="Pairing žádost nebyla nalezena.")
    if pairing.status != PairingStatus.pending:
        raise HTTPException(status_code=409, detail="Pairing žádost již není aktivní.")
    if as_utc(pairing.expires_at) < utc_now():
        pairing.status = PairingStatus.expired
        db.commit()
        raise HTTPException(status_code=410, detail="Pairing žádost vypršela.")
    if pin_digest(pairing.nonce, data.pin) != pairing.pin_digest:
        raise HTTPException(status_code=400, detail="PIN není správný.")
    existing = db.scalar(select(Device).where(Device.serial_number == pairing.serial_number))
    if existing is not None:
        raise HTTPException(status_code=409, detail="Zařízení s tímto sériovým číslem již existuje.")
    device = Device(name=pairing.name, serial_number=pairing.serial_number, model=pairing.model)
    pairing.status = PairingStatus.confirmed
    pairing.confirmed_at = utc_now()
    db.add(device)
    db.flush()
    pairing.device_id = device.id
    db.add(AuditEvent(device=device, type=EventType.pairing_confirmed, message=f"Zařízení {device.name} bylo spárováno."))
    db.commit()
    db.refresh(device)
    return device


@app.post("/api/pairing/{pairing_id}/reject", response_model=PairingRead, tags=["pairing"])
def reject_pairing(pairing_id: str, db: Session = Depends(get_db)) -> PairingRequest:
    pairing = db.get(PairingRequest, pairing_id)
    if pairing is None:
        raise HTTPException(status_code=404, detail="Pairing žádost nebyla nalezena.")
    if pairing.status != PairingStatus.pending:
        raise HTTPException(status_code=409, detail="Pairing žádost již není aktivní.")
    pairing.status = PairingStatus.rejected
    db.add(AuditEvent(type=EventType.pairing_rejected, message=f"Pairing zařízení {pairing.name} byl odmítnut."))
    db.commit()
    db.refresh(pairing)
    return pairing


@app.post("/api/devices", response_model=DeviceRead, status_code=status.HTTP_201_CREATED, tags=["devices"])
def create_device(data: DeviceCreate, db: Session = Depends(get_db)) -> Device:
    device = Device(**data.model_dump())
    db.add(device)
    db.add(AuditEvent(device=device, type=EventType.device_registered, message=f"Zařízení {data.name} bylo registrováno."))
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Zařízení s tímto sériovým číslem již existuje.") from error
    db.refresh(device)
    return device


@app.post("/api/devices/heartbeat", response_model=DeviceRead, tags=["devices"])
def heartbeat(
    data: DeviceHeartbeat,
    request: Request,
    db: Session = Depends(get_db),
) -> Device:
    device = db.scalar(select(Device).where(Device.serial_number == data.serial_number))
    if device is None:
        raise HTTPException(status_code=404, detail="Zařízení nebylo nalezeno.")
    device.status = DeviceStatus.online
    device.last_seen_at = utc_now()
    device.battery_percent = data.battery_percent
    device.firmware_version = data.firmware_version
    device.current_app = data.current_app
    if request.client is not None:
        device.ip_address = request.client.host
    db.add(AuditEvent(device=device, type=EventType.heartbeat, message=f"Heartbeat zařízení {device.name}."))
    db.commit()
    db.refresh(device)
    return device


@app.delete("/api/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["devices"])
def delete_device(device_id: str, db: Session = Depends(get_db)) -> None:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Zařízení nebylo nalezeno.")
    db.delete(device)
    db.commit()


@app.get("/api/devices/{device_id}/commands", response_model=list[CommandRead], tags=["commands"])
def list_commands(
    device_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[Command]:
    if db.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="Zařízení nebylo nalezeno.")
    return list(db.scalars(select(Command).where(Command.device_id == device_id).order_by(Command.created_at.desc()).limit(limit)))


@app.post("/api/devices/{device_id}/commands", response_model=CommandRead, status_code=status.HTTP_201_CREATED, tags=["commands"])
def create_command(device_id: str, data: CommandCreate, db: Session = Depends(get_db)) -> Command:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Zařízení nebylo nalezeno.")
    command = Command(device_id=device_id, **data.model_dump())
    db.add(command)
    db.add(AuditEvent(device=device, type=EventType.command_created, message=f"Naplánován příkaz: {data.type.value}."))
    db.commit()
    db.refresh(command)
    return command


@app.patch("/api/devices/{device_id}/commands/{command_id}", response_model=CommandRead, tags=["commands"])
def update_command(
    device_id: str,
    command_id: str,
    data: CommandUpdate,
    db: Session = Depends(get_db),
) -> Command:
    command = db.scalar(select(Command).where(Command.id == command_id, Command.device_id == device_id))
    if command is None:
        raise HTTPException(status_code=404, detail="Příkaz nebyl nalezen.")
    command.status = data.status
    command.error_message = data.error_message
    if data.status in (CommandStatus.completed, CommandStatus.failed):
        command.completed_at = utc_now()
        db.add(AuditEvent(
            device=command.device,
            type=EventType.command_completed,
            message=f"Příkaz {command.type.value} byl dokončen se stavem {data.status.value}.",
            metadata_json={"command_id": command.id, "error_message": data.error_message},
        ))
    db.commit()
    db.refresh(command)
    return command


@app.get("/api/events", response_model=list[EventRead], tags=["events"])
def list_events(
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> list[AuditEvent]:
    return list(db.scalars(select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit)))
