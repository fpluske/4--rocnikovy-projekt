import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const emptyPairing = { name: "", serial_number: "", model: "Meta Quest 2", pin: "" };

const statusLabels = {
  online: "online",
  standby: "režim spánku",
  offline: "offline",
  unknown: "neznámý",
};

const connectionLabels = {
  online: "Server připojen",
  offline: "Server odpojen",
  unknown: "Ověřuji server",
};

function isUpdateAvailable(currentVersion, latestVersion) {
  if (!currentVersion || !latestVersion) return false;
  const current = currentVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const latest = latestVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(current.length, latest.length); index += 1) {
    if ((latest[index] || 0) !== (current[index] || 0)) return (latest[index] || 0) > (current[index] || 0);
  }
  return false;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Požadavek se nepodařilo dokončit.");
  }
  return response.status === 204 ? null : response.json();
}

function Dashboard({ user, onLogout }) {
  const [devices, setDevices] = useState([]);
  const [latestUpdate, setLatestUpdate] = useState(null);
  const [pairings, setPairings] = useState([]);
  const [pairingForm, setPairingForm] = useState(emptyPairing);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [serverStatus, setServerStatus] = useState("unknown");
  const [liveDevices, setLiveDevices] = useState([]);
  const [selectedLiveDeviceIds, setSelectedLiveDeviceIds] = useState([]);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("orbit-theme") === "dark");
  const [passwordForm, setPasswordForm] = useState({ current_password: "", new_password: "" });
  const [passwordOpen, setPasswordOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    localStorage.setItem("orbit-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const loadDevices = async () => {
    setLoading(true);
    const [healthResult, devicesResult, pairingsResult, updateResult] = await Promise.allSettled([
      request("/api/health"),
      request("/api/devices"),
      request("/api/pairing"),
      request("/api/updates/latest"),
    ]);
    if (healthResult.status === "fulfilled") setServerStatus("online");
    else setServerStatus("offline");
    if (devicesResult.status === "fulfilled") setDevices(devicesResult.value);
    if (pairingsResult.status === "fulfilled") setPairings(pairingsResult.value);
    if (updateResult.status === "fulfilled") setLatestUpdate(updateResult.value);
    const failedResult = [healthResult, devicesResult, pairingsResult, updateResult].find((result) => result.status === "rejected");
    if (failedResult) setMessage(failedResult.reason.message);
    setLoading(false);
  };

  useEffect(() => {
    loadDevices();
    const refreshTimer = window.setInterval(loadDevices, 10000);
    return () => window.clearInterval(refreshTimer);
  }, []);

  const discoverDevice = async (event) => {
    event.preventDefault();
    try {
      await request("/api/pairing/discover", {
        method: "POST",
        body: JSON.stringify({ ...pairingForm, nonce: crypto.randomUUID() }),
      });
      setPairingForm(emptyPairing);
      setPairingOpen(false);
      setMessage("Nový headset čeká na potvrzení PINem.");
      await loadDevices();
    } catch (error) { setMessage(error.message); }
  };

  const sendCommand = async (device, type) => {
    try {
      await request(`/api/devices/${device.id}/commands`, { method: "POST", body: JSON.stringify({ type }) });
      setMessage(`Příkaz „${type}“ byl zařazen do fronty.`);
    } catch (error) { setMessage(error.message); }
  };

  const removeDevice = async (device) => {
    if (!window.confirm(`Opravdu odstranit zařízení „${device.name}“?`)) return;
    try {
      await request(`/api/devices/${device.id}`, { method: "DELETE" });
      setSelectedLiveDeviceIds((current) => current.filter((id) => id !== device.id));
      setMessage("Zařízení bylo odstraněno.");
      await loadDevices();
    } catch (error) { setMessage(error.message); }
  };

  const confirmPairing = async (pairing) => {
    const pin = window.prompt(`Zadejte 4místný PIN z aplikace headsetu „${pairing.name}“:`);
    if (pin === null) return;
    try {
      await request(`/api/pairing/${pairing.id}/confirm`, { method: "POST", body: JSON.stringify({ pin }) });
      setMessage("Headset byl úspěšně spárován.");
      await loadDevices();
    } catch (error) { setMessage(error.message); }
  };

  const rejectPairing = async (pairing) => {
    if (!window.confirm(`Odmítnout požadavek zařízení „${pairing.name}“?`)) return;
    try {
      await request(`/api/pairing/${pairing.id}/reject`, { method: "POST" });
      setMessage("Požadavek párování byl odmítnut.");
      await loadDevices();
    } catch (error) { setMessage(error.message); }
  };

  const openLiveView = (device) => {
    setLiveDevices((current) => current.some((liveDevice) => liveDevice.id === device.id) ? current : [...current, device]);
  };

  const closeLiveView = (deviceId) => {
    setLiveDevices((current) => current.filter((device) => device.id !== deviceId));
  };

  const toggleLiveDeviceSelection = (deviceId) => {
    setSelectedLiveDeviceIds((current) => current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId]);
  };

  const openSelectedLiveViews = () => {
    devices.filter((device) => selectedLiveDeviceIds.includes(device.id) && device.status === "online").forEach(openLiveView);
  };

  const onlineDevices = devices.filter((device) => device.status === "online");
  const allOnlineSelected = onlineDevices.length > 0 && onlineDevices.every((device) => selectedLiveDeviceIds.includes(device.id));
  const toggleAllOnlineSelection = () => {
    setSelectedLiveDeviceIds((current) => allOnlineSelected
      ? current.filter((id) => !onlineDevices.some((device) => device.id === id))
      : [...new Set([...current, ...onlineDevices.map((device) => device.id)])]);
  };

  const changePassword = async (event) => {
    event.preventDefault();
    try {
      await request("/api/auth/password", { method: "POST", body: JSON.stringify(passwordForm) });
      setPasswordForm({ current_password: "", new_password: "" });
      setPasswordOpen(false);
      setMessage("Heslo bylo změněno.");
    } catch (error) { setMessage(error.message); }
  };

  return <main>
    <header><div><p className="eyebrow">ORBIT / PROTOTYP</p><h1>Správa Quest headsetů</h1><p className="muted">Přehled zařízení a čekajících párování.</p></div><div className="header-actions"><span className="user-badge">{user.username} · {user.role}</span><span className={`server-connection ${serverStatus}`}><span className="connection-dot" />{connectionLabels[serverStatus]}</span><button className="secondary theme-button" onClick={() => setDarkMode((current) => !current)} aria-pressed={darkMode}>{darkMode ? "Světlý režim" : "Tmavý režim"}</button><button className="secondary" onClick={loadDevices}>Obnovit</button><button className="secondary" onClick={() => setPasswordOpen((current) => !current)}>Změnit heslo</button>{user.role === "admin" && <button className="primary pairing-button" onClick={() => setPairingOpen(true)}>Párovat zařízení</button>}<button className="secondary" onClick={onLogout}>Odhlásit</button></div></header>
    {message && <div className="notice">{message}</div>}
    {passwordOpen && <section className="card password-card"><div className="section-heading"><h2>Změnit heslo</h2><button className="close-button" onClick={() => setPasswordOpen(false)} aria-label="Zavřít">×</button></div><form className="password-form" onSubmit={changePassword}><label>Současné heslo<input required type="password" value={passwordForm.current_password} onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })} /></label><label>Nové heslo<input required minLength="12" type="password" value={passwordForm.new_password} onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })} placeholder="min. 12 znaků" /></label><button className="primary">Uložit nové heslo</button></form></section>}
    {pairingOpen && user.role === "admin" && <section className="card pairing-form-card"><div className="section-heading"><div><p className="eyebrow">NOVÉ ZAŘÍZENÍ</p><h2>Spustit párování</h2></div><button className="close-button" onClick={() => setPairingOpen(false)} aria-label="Zavřít">×</button></div><p className="muted">V prototypu zde simulujete discovery packet z aplikace headsetu.</p><form className="pairing-form" onSubmit={discoverDevice}><label>Název headsetu<input required autoFocus value={pairingForm.name} onChange={(e) => setPairingForm({ ...pairingForm, name: e.target.value })} placeholder="Např. Quest učebna 1" /></label><label>Sériové číslo<input required value={pairingForm.serial_number} onChange={(e) => setPairingForm({ ...pairingForm, serial_number: e.target.value })} /></label><label>PIN z headsetu<input required inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={pairingForm.pin} onChange={(e) => setPairingForm({ ...pairingForm, pin: e.target.value.replace(/\D/g, "") })} placeholder="4 číslice" /></label><div className="form-actions"><button type="button" onClick={() => setPairingOpen(false)}>Zrušit</button><button className="primary">Odeslat discovery</button></div></form></section>}
    {pairings.length > 0 && user.role === "admin" && <section className="card pairing-card"><div className="section-heading"><h2>Čekající párování</h2><span>{pairings.length} nové</span></div>{pairings.map((pairing) => <article className="device" key={pairing.id}><div><h3>{pairing.name}</h3><p className="muted">{pairing.model} · {pairing.serial_number}</p><span className="status unknown">čeká na potvrzení</span></div><div className="pairing-actions"><button className="primary" onClick={() => confirmPairing(pairing)}>Potvrdit PINem</button><button className="danger" onClick={() => rejectPairing(pairing)}>Odmítnout</button></div></article>)}</section>}
    <section className="layout">
      <section className="card devices-card"><div className="section-heading"><div><h2>Zařízení</h2><span>{devices.length} celkem</span></div>{devices.length > 0 && <div className="live-selection-actions"><button className="secondary" onClick={toggleAllOnlineSelection} disabled={onlineDevices.length === 0}>{allOnlineSelected ? "Zrušit výběr" : "Vybrat online"}</button><button className="primary" onClick={openSelectedLiveViews} disabled={selectedLiveDeviceIds.length === 0}>Sledovat vybrané ({selectedLiveDeviceIds.length})</button></div>}</div>{loading ? <p className="muted">Načítám...</p> : devices.length === 0 ? <div className="empty"><p>Zatím není spárován žádný headset.</p>{user.role === "admin" && <button className="primary" onClick={() => setPairingOpen(true)}>Párovat první zařízení</button>}</div> : <div className="device-list">{devices.map((device) => { const isLive = liveDevices.some((liveDevice) => liveDevice.id === device.id); const isSelected = selectedLiveDeviceIds.includes(device.id); const updateAvailable = isUpdateAvailable(device.firmware_version, latestUpdate?.version); return <article className="device" key={device.id}><div className="device-info"><label className="live-checkbox"><input type="checkbox" checked={isSelected} disabled={device.status !== "online"} onChange={() => toggleLiveDeviceSelection(device.id)} aria-label={`Vybrat přenos ${device.name}`} /><span>Vybrat přenos</span></label><div><h3>{device.name}</h3><p className="muted">{device.model} · {device.serial_number}</p><span className={`status ${device.status}`}>{statusLabels[device.status] || device.status}</span><p className="firmware-version">Horizon OS: {device.horizon_os_version || "nezjištěna"}{device.horizon_os_update_pending && <strong> · Čeká systémová aktualizace</strong>}</p><p className="firmware-version">Orbit Agent: {device.firmware_version || "nezjištěna"}{updateAvailable && <strong> · Dostupná aktualizace: {latestUpdate.version}</strong>}</p>{device.last_seen_at && <p className="last-seen">Poslední kontakt: {new Date(device.last_seen_at).toLocaleString("cs-CZ")}</p>}</div></div><div className="actions"><button className="live-button" disabled={device.status !== "online" || isLive} onClick={() => openLiveView(device)}>{isLive ? "Sleduji" : "Živě"}</button><button onClick={() => sendCommand(device, "restart")}>Restart</button><button onClick={() => sendCommand(device, "lock")}>Uzamknout</button><button onClick={() => sendCommand(device, "unlock")}>Odemknout</button>{user.role === "admin" && <button className="danger" onClick={() => removeDevice(device)}>Odstranit</button>}</div></article>; })}</div>}</section>
    </section>
    {user.role === "admin" && <UserManagement setMessage={setMessage} />}
    {liveDevices.length > 0 && <LiveViewGallery devices={liveDevices} onClose={closeLiveView} onCloseAll={() => setLiveDevices([])} />}
  </main>;
}

function UserManagement({ setMessage }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: "", password: "", role: "user" });
  const loadUsers = async () => {
    try { setUsers(await request("/api/users")); } catch (error) { setMessage(error.message); }
  };
  useEffect(() => { loadUsers(); }, []);
  const addUser = async (event) => {
    event.preventDefault();
    try {
      await request("/api/users", { method: "POST", body: JSON.stringify(form) });
      setForm({ username: "", password: "", role: "user" });
      setMessage("Uživatel byl přidán.");
      await loadUsers();
    } catch (error) { setMessage(error.message); }
  };
  const removeUser = async (user) => {
    if (!window.confirm(`Opravdu odstranit uživatele „${user.username}“?`)) return;
    try { await request(`/api/users/${user.id}`, { method: "DELETE" }); setMessage("Uživatel byl odstraněn."); await loadUsers(); }
    catch (error) { setMessage(error.message); }
  };
  return <section className="card users-card"><div className="section-heading"><div><p className="eyebrow">ADMINISTRACE</p><h2>Uživatelé</h2></div><span>{users.length} účtů</span></div><form className="user-form" onSubmit={addUser}><label>Uživatelské jméno<input required minLength="3" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label><label>Heslo<input required minLength="12" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min. 12 znaků" /></label><label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="user">user</option><option value="admin">admin</option></select></label><button className="primary">Přidat uživatele</button></form><div className="user-list">{users.map((listedUser) => <div className="user-row" key={listedUser.id}><span>{listedUser.username}</span><span className="status unknown">{listedUser.role}</span>{!listedUser.is_initial_admin && <button className="danger" onClick={() => removeUser(listedUser)}>Odstranit</button>}</div>)}</div></section>;
}

function LiveViewGallery({ devices, onClose, onCloseAll }) {
  return <div className="live-backdrop"><section className="live-modal"><div className="section-heading"><div><p className="eyebrow">ŽIVÉ PŘENOSY</p><h2>{devices.length} {devices.length === 1 ? "headset" : "headsety"} současně</h2></div><button className="close-button" onClick={onCloseAll} aria-label="Zavřít všechny přenosy">×</button></div><div className="live-grid">{devices.map((device) => <LiveView key={device.id} device={device} onClose={() => onClose(device.id)} />)}</div></section></div>;
}

function LiveView({ device, onClose }) {
  const videoRef = useRef(null);
  const [connectionState, setConnectionState] = useState("Připojuji živý obraz…");
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === videoRef.current);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (videoRef.current?.requestFullscreen) {
        await videoRef.current.requestFullscreen();
      } else {
        setConnectionState("Celou obrazovku tento prohlížeč nepodporuje.");
      }
    } catch (error) {
      console.error("Fullscreen failed", error);
      setConnectionState("Obraz se nepodařilo zobrazit na celou obrazovku.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    let peer;
    let socket;
    const pendingCandidates = [];
    let remoteDescriptionSet = false;
    const connect = async () => {
      try {
        const configResponse = await fetch("/api/webrtc/config");
        if (!configResponse.ok) throw new Error(`Konfigurace ICE selhala (HTTP ${configResponse.status}).`);
        const { ice_servers: iceServers } = await configResponse.json();
        if (cancelled) return;
        peer = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 10 });
        socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/webrtc/${encodeURIComponent(device.serial_number)}`);
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.ontrack = (event) => {
          const stream = event.streams[0] || new MediaStream([event.track]);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => setConnectionState("Klikněte do obrazu pro spuštění videa"));
          }
          setConnectionState("Přijímám živý obraz");
        };
        peer.onicecandidate = (event) => {
          if (event.candidate && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "candidate", candidate: event.candidate.toJSON() }));
          }
        };
        peer.onicecandidateerror = (event) => console.warn("WebRTC ICE candidate error", event);
        peer.oniceconnectionstatechange = () => {
          console.info("WebRTC ICE state:", peer.iceConnectionState);
          if (peer.iceConnectionState === "failed") setConnectionState("ICE spojení selhalo. Zkontrolujte TURN server nebo síť.");
          else if (peer.iceConnectionState !== "connected" && peer.iceConnectionState !== "completed") setConnectionState(`ICE: ${peer.iceConnectionState}`);
        };
        peer.onconnectionstatechange = () => {
          console.info("WebRTC connection state:", peer.connectionState);
          if (peer.connectionState === "connected") setConnectionState("Živý obraz");
          else if (peer.connectionState === "failed") setConnectionState("WebRTC spojení selhalo.");
        };
        socket.onopen = async () => {
          try {
            socket.send(JSON.stringify({ type: "viewer" }));
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
          } catch (error) {
            console.error("WebRTC offer failed", error);
            setConnectionState(`Offer selhal: ${error.message}`);
          }
        };
        socket.onmessage = async ({ data }) => {
          try {
            const message = JSON.parse(data);
            if (message.type === "error") {
              setConnectionState(message.message || "Android odmítl WebRTC spojení.");
              return;
            }
            if (message.type === "answer") {
              await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
              remoteDescriptionSet = true;
              while (pendingCandidates.length > 0) await peer.addIceCandidate(pendingCandidates.shift());
            }
            if (message.type === "candidate" && message.candidate) {
              if (remoteDescriptionSet) await peer.addIceCandidate(message.candidate);
              else pendingCandidates.push(message.candidate);
            }
          } catch (error) {
            console.error("WebRTC signal processing failed", error);
            setConnectionState(`Signalizace selhala: ${error.message}`);
          }
        };
        socket.onerror = () => setConnectionState("Signalizační WebSocket není dostupný.");
        socket.onclose = () => {
          if (!cancelled) setConnectionState("Spojení živého obrazu bylo ukončeno.");
        };
      } catch (error) {
        console.error("WebRTC setup failed", error);
        setConnectionState(error.message);
      }
    };
    connect();
    return () => {
      cancelled = true;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "hangup" }));
      socket?.close();
      peer?.close();
    };
  }, [device.id]);

  return <article className="live-card"><div className="live-card-heading"><h3>{device.name}</h3><div className="live-actions"><button className="secondary" onClick={toggleFullscreen}>{isFullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka"}</button><button className="close-button" onClick={onClose} aria-label={`Zavřít přenos ${device.name}`}>×</button></div></div><video ref={videoRef} autoPlay muted playsInline controls={false} onError={() => setConnectionState("Prohlížeč nedokázal přehrát obraz")} /><p className="muted">{connectionState}</p></article>;
}

function AuthApp() {
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    request("/api/auth/status").then(setAuth).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
  }, []);

  if (loading) return <main className="auth-page"><section className="card auth-card"><p className="muted">Ověřuji přihlášení…</p></section></main>;
  if (error) return <main className="auth-page"><section className="card auth-card"><h1>Server není dostupný</h1><p className="notice">{error}</p></section></main>;
  if (auth.user) return <Dashboard user={auth.user} onLogout={async () => { await request("/api/auth/logout", { method: "POST" }); setAuth({ setup_required: false, user: null }); }} />;
  return <AuthForm setupRequired={auth.setup_required} onAuthenticated={(user) => setAuth({ setup_required: false, user })} />;
}

function AuthForm({ setupRequired, onAuthenticated }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    try {
      const user = await request(setupRequired ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: JSON.stringify(form) });
      onAuthenticated(user);
    } catch (requestError) { setError(requestError.message); }
  };
  return <main className="auth-page"><section className="card auth-card"><p className="eyebrow">ORBIT / ZABEZPEČENO</p><h1>{setupRequired ? "Vytvořte admin účet" : "Přihlášení"}</h1><p className="muted">{setupRequired ? "Při prvním spuštění nastavte účet hlavního administrátora." : "Pro pokračování se přihlaste."}</p>{error && <div className="notice error-notice">{error}</div>}<form className="auth-form" onSubmit={submit}><label>Uživatelské jméno<input required minLength={setupRequired ? 3 : 1} autoFocus value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label><label>Heslo<input required minLength={setupRequired ? 12 : 1} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={setupRequired ? "min. 12 znaků" : ""} /></label><button className="primary">{setupRequired ? "Vytvořit admin účet" : "Přihlásit se"}</button></form></section></main>;
}

createRoot(document.getElementById("root")).render(<AuthApp />);
