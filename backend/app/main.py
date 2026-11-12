from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import json
import secrets

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, SessionLocal, engine, get_db
from .models import (
    AuditEvent, Command, CommandStatus, CommandType, Device, DeviceStatus, EventType, PairingRequest,
    PairingStatus, UpdatePackage, User, UserRole,
)
from .schemas import (
    AuthStatus, LoginCreate, PasswordChange, SetupCreate, UserCreate, UserRead,
    CommandUpdate,
    CommandCreate, CommandRead, DeviceCreate, DeviceHeartbeat, DeviceRead, EventRead, HealthRead,
    PairingConfirm, PairingDiscovery, PairingRead, UpdatePackageRead,
)

Base.metadata.create_all(bind=engine)


def ensure_device_status_columns() -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("devices")}
    with engine.begin() as connection:
        if "horizon_os_version" not in columns:
            connection.execute(text("ALTER TABLE devices ADD COLUMN horizon_os_version VARCHAR(120)"))
        if "horizon_os_update_pending" not in columns:
            connection.execute(text(
                "ALTER TABLE devices ADD COLUMN horizon_os_update_pending BOOLEAN NOT NULL DEFAULT FALSE"
            ))
        if "left_controller_battery_percent" not in columns:
            connection.execute(text(
                "ALTER TABLE devices ADD COLUMN left_controller_battery_percent INTEGER"
            ))
        if "right_controller_battery_percent" not in columns:
            connection.execute(text(
                "ALTER TABLE devices ADD COLUMN right_controller_battery_percent INTEGER"
            ))


ensure_device_status_columns()


def ensure_user_columns() -> None:
    columns = {column["name"] for column in inspect(engine).get_columns("users")}
    with engine.begin() as connection:
        if "is_initial_admin" not in columns:
            connection.execute(text(
                "ALTER TABLE users ADD COLUMN is_initial_admin BOOLEAN NOT NULL DEFAULT FALSE"
            ))
            connection.execute(text(
                "UPDATE users SET is_initial_admin = TRUE "
                "WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1)"
            ))


ensure_user_columns()

DEVICE_OFFLINE_AFTER = timedelta(seconds=30)

app = FastAPI(title="Orbit Quest Management API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

webrtc_connections: dict[str, set[WebSocket]] = {}
SESSION_COOKIE = "orbit_session"
SESSION_DURATION = timedelta(hours=8)
PUBLIC_API_PATHS = {
    "/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/setup",
    "/api/devices/heartbeat", "/api/pairing/discover",
}


def _encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decoded(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def password_digest(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return f"pbkdf2_sha256$310000${_encoded(salt)}${_encoded(digest)}"


def password_matches(password: str, stored_digest: str) -> bool:
    try:
        algorithm, rounds, salt, digest = stored_digest.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        calculated = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), _decoded(salt), int(rounds)
        )
        return hmac.compare_digest(_encoded(calculated), digest)
    except (ValueError, TypeError):
        return False


def create_session(user: User) -> str:
    payload = {
        "user_id": user.id,
        "role": user.role.value if isinstance(user.role, UserRole) else user.role,
        "expires_at": int((utc_now() + SESSION_DURATION).timestamp()),
    }
    encoded_payload = _encoded(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(settings.auth_secret.encode("utf-8"), encoded_payload.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded_payload}.{_encoded(signature)}"


def decode_session(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    encoded_payload, encoded_signature = token.split(".", 1)
    expected = hmac.new(
        settings.auth_secret.encode("utf-8"), encoded_payload.encode("ascii"), hashlib.sha256
    ).digest()
    try:
        if not hmac.compare_digest(_decoded(encoded_signature), expected):
            return None
        payload = json.loads(_decoded(encoded_payload))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if payload.get("expires_at", 0) < int(utc_now().timestamp()):
        return None
    return payload


def find_session_user(request: Request, db: Session) -> User | None:
    session = decode_session(request.cookies.get(SESSION_COOKIE))
    if session is None:
        return None
    return db.get(User, session.get("user_id"))


@app.middleware("http")
async def require_authentication(request: Request, call_next):
    path = request.url.path
    public_pairing_status = (
        request.method == "GET"
        and path.startswith("/api/pairing/")
        and path.count("/") == 3
    )
    path_parts = path.strip("/").split("/")
    public_agent_command = (
        (
            request.method == "GET"
            and len(path_parts) == 4
            and path_parts[0:2] == ["api", "devices"]
            and path_parts[3] == "commands"
        )
        or (
            request.method == "PATCH"
            and len(path_parts) == 5
            and path_parts[0:2] == ["api", "devices"]
            and path_parts[3] == "commands"
        )
    )
    if (
        request.method == "OPTIONS"
        or not path.startswith("/api/")
        or path in PUBLIC_API_PATHS
        or public_pairing_status
        or public_agent_command
    ):
        return await call_next(request)
    with SessionLocal() as db:
        user = find_session_user(request, db)
    if user is None:
        return Response(content='{"detail":"Přihlášení je vyžadováno."}', status_code=401, media_type="application/json")
    request.state.user = user
    return await call_next(request)


def current_user(request: Request) -> User:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(status_code=401, detail="Přihlášení je vyžadováno.")
    return user


def admin_user(request: Request) -> User:
    user = current_user(request)
    if user.role != UserRole.admin:
        raise HTTPException(status_code=403, detail="Tato akce vyžaduje roli admin.")
    return user


def set_session_cookie(response: Response, user: User) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        create_session(user),
        max_age=int(SESSION_DURATION.total_seconds()),
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
    )


@app.get("/api/auth/status", response_model=AuthStatus, tags=["auth"])
def auth_status(request: Request, db: Session = Depends(get_db)) -> AuthStatus:
    user = find_session_user(request, db)
    if user is not None:
        return AuthStatus(setup_required=False, user=user)
    return AuthStatus(setup_required=db.scalar(select(User).limit(1)) is None)


@app.post("/api/auth/setup", response_model=UserRead, status_code=status.HTTP_201_CREATED, tags=["auth"])
def setup_admin(data: SetupCreate, response: Response, db: Session = Depends(get_db)) -> User:
    if db.scalar(select(User).limit(1)) is not None:
        raise HTTPException(status_code=409, detail="Počáteční admin už byl vytvořen.")
    user = User(
        username=data.username,
        password_hash=password_digest(data.password),
        role=UserRole.admin,
        is_initial_admin=True,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Uživatelské jméno již existuje.") from error
    db.refresh(user)
    set_session_cookie(response, user)
    return user


@app.post("/api/auth/login", response_model=UserRead, tags=["auth"])
def login(data: LoginCreate, response: Response, db: Session = Depends(get_db)) -> User:
    user = db.scalar(select(User).where(User.username == data.username))
    if user is None or not password_matches(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Uživatelské jméno nebo heslo není správné.")
    set_session_cookie(response, user)
    return user


@app.post("/api/auth/logout", status_code=status.HTTP_204_NO_CONTENT, tags=["auth"])
def logout(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE)


@app.post("/api/auth/password", response_model=UserRead, tags=["auth"])
def change_password(data: PasswordChange, request: Request, response: Response, db: Session = Depends(get_db)) -> User:
    user = current_user(request)
    if not password_matches(data.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Současné heslo není správné.")
    user.password_hash = password_digest(data.new_password)
    db.commit()
    db.refresh(user)
    set_session_cookie(response, user)
    return user


@app.get("/api/users", response_model=list[UserRead], tags=["users"])
def list_users(request: Request, db: Session = Depends(get_db)) -> list[User]:
    admin_user(request)
    return list(db.scalars(select(User).order_by(User.username)))


@app.post("/api/users", response_model=UserRead, status_code=status.HTTP_201_CREATED, tags=["users"])
def create_user(data: UserCreate, request: Request, db: Session = Depends(get_db)) -> User:
    admin_user(request)
    user = User(username=data.username, password_hash=password_digest(data.password), role=data.role)
    db.add(user)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Uživatelské jméno již existuje.") from error
    db.refresh(user)
    return user


@app.delete("/api/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["users"])
def delete_user(user_id: str, request: Request, db: Session = Depends(get_db)) -> None:
    user = admin_user(request)
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Uživatel nebyl nalezen.")
    if target.is_initial_admin:
        raise HTTPException(status_code=400, detail="Základního admina nelze odstranit.")
    if user.id == user_id:
        raise HTTPException(status_code=400, detail="Vlastní účet nelze odstranit.")
    db.delete(target)
    db.commit()


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


@app.get("/api/updates/latest", response_model=UpdatePackageRead | None, tags=["updates"])
def latest_update(db: Session = Depends(get_db)):
    return db.scalar(select(UpdatePackage).order_by(desc(UpdatePackage.created_at)).limit(1))


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
def confirm_pairing(pairing_id: str, data: PairingConfirm, request: Request, db: Session = Depends(get_db)) -> Device:
    admin_user(request)
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
def reject_pairing(pairing_id: str, request: Request, db: Session = Depends(get_db)) -> PairingRequest:
    admin_user(request)
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
def create_device(data: DeviceCreate, request: Request, db: Session = Depends(get_db)) -> Device:
    admin_user(request)
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
    device.status = data.status
    device.last_seen_at = utc_now()
    device.battery_percent = data.battery_percent
    device.left_controller_battery_percent = data.left_controller_battery_percent
    device.right_controller_battery_percent = data.right_controller_battery_percent
    device.firmware_version = data.firmware_version
    device.horizon_os_version = data.horizon_os_version
    device.horizon_os_update_pending = data.horizon_os_update_pending
    device.current_app = data.current_app
    if request.client is not None:
        device.ip_address = request.client.host
    pending_restart = db.scalar(
        select(Command)
        .where(
            Command.device_id == device.id,
            Command.type == CommandType.restart,
            Command.status == CommandStatus.acknowledged,
        )
        .order_by(Command.created_at.desc())
    )
    if pending_restart is not None:
        pending_restart.status = CommandStatus.completed
        pending_restart.completed_at = utc_now()
        db.add(AuditEvent(
            device=device,
            type=EventType.command_completed,
            message=f"Příkaz {pending_restart.type.value} byl dokončen po restartu zařízení.",
            metadata_json={"command_id": pending_restart.id},
        ))
    db.add(AuditEvent(device=device, type=EventType.heartbeat, message=f"Heartbeat zařízení {device.name}."))
    db.commit()
    db.refresh(device)
    return device


@app.delete("/api/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["devices"])
def delete_device(device_id: str, request: Request, db: Session = Depends(get_db)) -> None:
    admin_user(request)
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
    active_command = db.scalar(
        select(Command)
        .where(
            Command.device_id == device_id,
            Command.status.in_((
                CommandStatus.queued,
                CommandStatus.sent,
                CommandStatus.acknowledged,
            )),
        )
        .limit(1)
    )
    if active_command is not None:
        raise HTTPException(
            status_code=409,
            detail="Headset ještě nepotvrdil dokončení předchozího příkazu.",
        )
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
