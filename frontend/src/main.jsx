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

function BatteryIndicator({ label, percent, isCharging }) {
  const level = percent === null || percent === undefined ? "unknown" : percent <= 30 ? "low" : percent <= 60 ? "medium" : "high";
  const fillWidth = percent === null || percent === undefined ? 0 : Math.max(0, Math.min(100, percent));
  const chargingLabel = isCharging === null || isCharging === undefined ? "stav nabíjení nezjištěn" : isCharging ? "nabíjí se" : "nenabíjí se";
  return <div className="battery-indicator" title={`${label}: ${percent === null || percent === undefined ? "nezjištěno" : `${percent} %`}, ${chargingLabel}`}>
    <span className={`battery-icon ${isCharging ? "charging" : ""}`} aria-hidden="true">
      <span style={{ width: `${fillWidth}%` }} />
      {isCharging && <svg className="charging-icon" viewBox="0 0 24 24" focusable="false"><path d="M13.2 2 4.8 13h5.7L9.7 22 19.2 10.1h-5.8L13.2 2Z" /></svg>}
    </span>
    <span className="battery-info"><strong>{label}</strong><span className={`battery-value ${level}`}>{percent === null || percent === undefined ? "—" : `${percent} %`}</span></span>
  </div>;
}

function BatteryIndicators({ device }) {
  return <div className="battery-indicators" aria-label="Stav baterie headsetu">
    <BatteryIndicator label="Headset" percent={device.battery_percent} isCharging={device.is_charging} />
  </div>;
}

function InstalledAppsButton({ apps, onClick }) {
  return <button className="apps-button" onClick={onClick}>Aplikace ({apps.length})</button>;
}

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
  const [appsDevice, setAppsDevice] = useState(null);
  const [appsDevices, setAppsDevices] = useState(null);
  const [lockedDeviceIds, setLockedDeviceIds] = useState([]);
  const [selectedLiveDeviceIds, setSelectedLiveDeviceIds] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [groupName, setGroupName] = useState("");
  const [groupDeviceIds, setGroupDeviceIds] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [expandedDeviceIds, setExpandedDeviceIds] = useState([]);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("orbit-theme") === "dark");
  const [passwordForm, setPasswordForm] = useState({ current_password: "", new_password: "" });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [activeView, setActiveView] = useState("dashboard");

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    localStorage.setItem("orbit-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  const loadDevices = async () => {
    setLoading(true);
    const [healthResult, devicesResult, pairingsResult, updateResult, groupsResult] = await Promise.allSettled([
      request("/api/health"),
      request("/api/devices"),
      request("/api/pairing"),
      request("/api/updates/latest"),
      request("/api/groups"),
    ]);
    if (healthResult.status === "fulfilled") setServerStatus("online");
    else setServerStatus("offline");
    if (devicesResult.status === "fulfilled") setDevices(devicesResult.value);
    if (pairingsResult.status === "fulfilled") setPairings(pairingsResult.value);
    if (updateResult.status === "fulfilled") setLatestUpdate(updateResult.value);
    if (groupsResult.status === "fulfilled") setGroups(groupsResult.value);
    const failedResult = [healthResult, devicesResult, pairingsResult, updateResult, groupsResult].find((result) => result.status === "rejected");
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

  const sendCommand = async (device, type, payload = undefined) => {
    try {
      await request(`/api/devices/${device.id}/commands`, { method: "POST", body: JSON.stringify({ type, ...(payload ? { payload } : {}) }) });
      const message = type === "launch_app"
        ? "Spuštění aplikace bylo zařazeno do fronty."
        : type === "force_stop"
          ? "Vynucené ukončení aplikace bylo zařazeno do fronty."
          : type === "update"
            ? "Aktualizace Orbit Agenta byla zařazena do fronty."
          : `Příkaz „${type}“ byl zařazen do fronty.`;
      setMessage(message);
      return true;
    } catch (error) { setMessage(error.message); return false; }
  };

  const launchApp = async (device, app) => {
    if (await sendCommand(device, "launch_app", { package_name: app.package_name })) setAppsDevice(null);
  };

  const forceStopApp = (device) => {
    const app = (device.installed_apps || []).find((installedApp) => installedApp.label === device.current_app);
    const packageName = device.current_app_package || app?.package_name || (device.current_app?.includes(".") ? device.current_app : undefined);
    sendCommand(device, "force_stop", packageName ? { package_name: packageName } : undefined);
  };

  const toggleDeviceLock = async (device) => {
    const isLocked = lockedDeviceIds.includes(device.id);
    if (await sendCommand(device, isLocked ? "unlock" : "lock")) {
      setLockedDeviceIds((current) => isLocked
        ? current.filter((id) => id !== device.id)
        : [...current, device.id]);
    }
  };

  const launchAppOnSelectedDevices = async (app) => {
    if (!appsDevices) return;
    const results = await Promise.allSettled(appsDevices.map((device) => request(`/api/devices/${device.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ type: "launch_app", payload: { package_name: app.package_name } }),
    })));
    const successful = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - successful;
    if (failed === 0) {
      setMessage(`Spuštění aplikace bylo zařazeno do fronty na ${successful} zařízeních.`);
      setAppsDevices(null);
    } else {
      setMessage(`Spuštění aplikace bylo zařazeno na ${successful} zařízeních, ${failed} zařízení příkaz odmítlo.`);
    }
  };

  const removeDevice = async (device) => {
    if (!window.confirm(`Opravdu odstranit zařízení „${device.name}“?`)) return;
    try {
      await request(`/api/devices/${device.id}`, { method: "DELETE" });
      setSelectedLiveDeviceIds((current) => current.filter((id) => id !== device.id));
      setExpandedDeviceIds((current) => current.filter((id) => id !== device.id));
      setLockedDeviceIds((current) => current.filter((id) => id !== device.id));
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

  const openSelectedApps = () => {
    const selectedDevices = devices.filter((device) => selectedLiveDeviceIds.includes(device.id));
    if (selectedDevices.length > 0) setAppsDevices(selectedDevices);
  };

  const openNewGroup = () => {
    setEditingGroupId(null);
    setGroupName("");
    setGroupDeviceIds([...selectedLiveDeviceIds]);
    setGroupModalOpen(true);
  };

  const openEditGroup = (group) => {
    setEditingGroupId(group.id);
    setGroupName(group.name);
    setGroupDeviceIds([...group.device_ids]);
    setGroupModalOpen(true);
  };

  const saveGroup = async (event) => {
    event.preventDefault();
    if (groupDeviceIds.length === 0) {
      setMessage("Vyberte alespoň jedno zařízení.");
      return;
    }
    try {
      const path = editingGroupId ? `/api/groups/${editingGroupId}` : "/api/groups";
      await request(path, {
        method: editingGroupId ? "PUT" : "POST",
        body: JSON.stringify({ name: groupName, device_ids: groupDeviceIds }),
      });
      setGroupModalOpen(false);
      setEditingGroupId(null);
      setGroupName("");
      setGroupDeviceIds([]);
      setMessage(editingGroupId ? "Skupina byla upravena." : "Skupina byla vytvořena.");
      await loadDevices();
    } catch (error) { setMessage(error.message); }
  };

  const removeGroup = async (group) => {
    if (!window.confirm(`Opravdu odstranit skupinu „${group.name}“?`)) return;
    try {
      await request(`/api/groups/${group.id}`, { method: "DELETE" });
      if (activeGroupId === group.id) setActiveGroupId(null);
      setMessage("Skupina byla odstraněna.");
      await loadDevices();
    } catch (error) { setMessage(error.message); }
  };

  const sendGroupCommand = async (group, type) => {
    const groupDevices = devices.filter((device) =>
      group.device_ids.includes(device.id) && device.status !== "offline" && device.status !== "unknown"
    );
    if (groupDevices.length === 0) {
      setMessage("Ve skupině nejsou žádná zařízení.");
      return;
    }
    const results = await Promise.allSettled(groupDevices.map((device) =>
      request(`/api/devices/${device.id}/commands`, {
        method: "POST",
        body: JSON.stringify({ type }),
      })
    ));
    const successful = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - successful;
    const commandLabels = { restart: "Restart", lock: "Uzamknutí", unlock: "Odemknutí" };
    setMessage(failed === 0
      ? `${commandLabels[type]} bylo zařazeno pro ${successful} zařízení skupiny „${group.name}“.`
      : `${commandLabels[type]} bylo zařazeno pro ${successful} zařízení; ${failed} příkazů bylo odmítnuto.`);
  };

  const watchGroup = (group) => {
    devices
      .filter((device) => group.device_ids.includes(device.id) && device.status === "online")
      .forEach(openLiveView);
  };

  const onlineDevices = devices.filter((device) => device.status === "online");
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const visibleDevices = activeGroup
    ? devices.filter((device) => activeGroup.device_ids.includes(device.id))
    : devices;
  const allOnlineSelected = onlineDevices.length > 0 && onlineDevices.every((device) => selectedLiveDeviceIds.includes(device.id));
  const selectedDevices = devices.filter((device) => selectedLiveDeviceIds.includes(device.id));
  const toggleAllOnlineSelection = () => {
    setSelectedLiveDeviceIds((current) => allOnlineSelected
      ? current.filter((id) => !onlineDevices.some((device) => device.id === id))
      : [...new Set([...current, ...onlineDevices.map((device) => device.id)])]);
  };
  const toggleDeviceDetails = (deviceId) => {
    setExpandedDeviceIds((current) => current.includes(deviceId)
      ? current.filter((id) => id !== deviceId)
      : [...current, deviceId]);
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
    <header><div className="brand"><h1>Orbit Hub</h1></div><div className="header-actions"><span className={`server-connection ${serverStatus}`} aria-label={connectionLabels[serverStatus]} title={connectionLabels[serverStatus]}>{serverStatus === "online" ? "✓" : serverStatus === "offline" ? "×" : "…"}</span><button className="icon-button secondary" onClick={() => setDarkMode((current) => !current)} aria-label={darkMode ? "Přepnout na světlý režim" : "Přepnout na tmavý režim"} title={darkMode ? "Světlý režim" : "Tmavý režim"}>{darkMode ? "☀" : "☾"}</button>{user.role === "admin" && <button className="nav-button secondary" onClick={() => setActiveView((current) => current === "users" ? "dashboard" : "users")}>{activeView === "users" ? "Zařízení" : "Uživatelé"}</button>}<div className="profile-menu"><button className="profile-button" onClick={() => setProfileOpen((current) => !current)} aria-expanded={profileOpen} aria-haspopup="menu" aria-label="Otevřít profil" title="Profil"><span className="profile-avatar">{user.username.slice(0, 1).toUpperCase()}</span></button>{profileOpen && <div className="profile-dropdown" role="menu"><div className="profile-summary"><strong>{user.username}</strong><span>{user.role}</span></div><button role="menuitem" onClick={() => { setPasswordOpen((current) => !current); setProfileOpen(false); }}>Změnit heslo</button><button role="menuitem" onClick={onLogout}>Odhlásit</button></div>}</div></div></header>
    {message && <div className="notice">{message}</div>}
    {passwordOpen && <section className="card password-card"><div className="section-heading"><h2>Změnit heslo</h2><button className="close-button" onClick={() => setPasswordOpen(false)} aria-label="Zavřít">×</button></div><form className="password-form" onSubmit={changePassword}><label>Současné heslo<input required type="password" value={passwordForm.current_password} onChange={(e) => setPasswordForm({ ...passwordForm, current_password: e.target.value })} /></label><label>Nové heslo<input required minLength="12" type="password" value={passwordForm.new_password} onChange={(e) => setPasswordForm({ ...passwordForm, new_password: e.target.value })} placeholder="min. 12 znaků" /></label><button className="primary">Uložit nové heslo</button></form></section>}
    {activeView === "users" ? <UserManagement setMessage={setMessage} /> : <>
    {pairingOpen && user.role === "admin" && <section className="card pairing-form-card"><div className="section-heading"><div><p className="eyebrow">NOVÉ ZAŘÍZENÍ</p><h2>Spustit párování</h2></div><button className="close-button" onClick={() => setPairingOpen(false)} aria-label="Zavřít">×</button></div><p className="muted">V prototypu zde simulujete discovery packet z aplikace headsetu.</p><form className="pairing-form" onSubmit={discoverDevice}><label>Název headsetu<input required autoFocus value={pairingForm.name} onChange={(e) => setPairingForm({ ...pairingForm, name: e.target.value })} placeholder="Např. Quest učebna 1" /></label><label>Sériové číslo<input required value={pairingForm.serial_number} onChange={(e) => setPairingForm({ ...pairingForm, serial_number: e.target.value })} /></label><label>PIN z headsetu<input required inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={pairingForm.pin} onChange={(e) => setPairingForm({ ...pairingForm, pin: e.target.value.replace(/\D/g, "") })} placeholder="4 číslice" /></label><div className="form-actions"><button type="button" onClick={() => setPairingOpen(false)}>Zrušit</button><button className="primary">Odeslat discovery</button></div></form></section>}
    {pairings.length > 0 && user.role === "admin" && <section className="card pairing-card"><div className="section-heading"><h2>Čekající párování</h2><span>{pairings.length} nové</span></div>{pairings.map((pairing) => <article className="device" key={pairing.id}><div><h3>{pairing.name}</h3><p className="muted">{pairing.model} · {pairing.serial_number}</p><span className="status unknown">čeká na potvrzení</span></div><div className="pairing-actions"><button className="primary" onClick={() => confirmPairing(pairing)}>Potvrdit PINem</button><button className="danger" onClick={() => rejectPairing(pairing)}>Odmítnout</button></div></article>)}</section>}
    {groupModalOpen && user.role === "admin" && <section className="card pairing-form-card">
      <div className="section-heading"><div><p className="eyebrow">SKUPINA HEADSETŮ</p><h2>{editingGroupId ? "Upravit skupinu" : "Vytvořit skupinu"}</h2></div><button className="close-button" onClick={() => setGroupModalOpen(false)} aria-label="Zavřít">×</button></div>
      <form className="pairing-form" onSubmit={saveGroup}>
        <label>Název skupiny<input required autoFocus maxLength="120" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Např. Učebna A" /></label>
        <fieldset className="group-device-picker"><legend>Zařízení ve skupině</legend>{devices.map((device) => <label key={device.id}><input type="checkbox" checked={groupDeviceIds.includes(device.id)} onChange={(event) => setGroupDeviceIds((current) => event.target.checked ? [...current, device.id] : current.filter((id) => id !== device.id))} /><span>{device.name}</span></label>)}</fieldset>
        <div className="form-actions"><button type="button" onClick={() => setGroupModalOpen(false)}>Zrušit</button><button className="primary">{editingGroupId ? "Uložit změny" : "Vytvořit skupinu"}</button></div>
      </form>
    </section>}
    <section className="layout">
      <section className="card devices-card"><div className="section-heading"><div><h2>{activeGroup ? `Zařízení — ${activeGroup.name}` : "Zařízení"}</h2><span>{visibleDevices.length} z {devices.length} celkem</span></div>{devices.length > 0 && <div className="live-selection-actions">{user.role === "admin" && <button className="secondary" onClick={openNewGroup} disabled={selectedDevices.length === 0}>Vytvořit skupinu ({selectedDevices.length})</button>}<button className="primary pairing-button" onClick={openSelectedApps} disabled={selectedDevices.length === 0}>Aplikace ({selectedDevices.length})</button><button className="icon-button secondary" onClick={loadDevices} aria-label="Obnovit zařízení" title="Obnovit">↻</button><button className="secondary" onClick={toggleAllOnlineSelection} disabled={onlineDevices.length === 0}>{allOnlineSelected ? "Zrušit výběr" : "Vybrat online"}</button><button className="primary" onClick={openSelectedLiveViews} disabled={selectedLiveDeviceIds.length === 0}>Sledovat vybrané ({selectedLiveDeviceIds.length})</button></div>}</div>{loading ? <p className="muted">Načítám...</p> : visibleDevices.length === 0 ? <div className="empty"><p>{activeGroup ? "Ve skupině zatím není žádné zařízení." : "Zatím není spárován žádný headset."}</p>{!activeGroup && user.role === "admin" && <button className="primary" onClick={() => setPairingOpen(true)}>Párovat první zařízení</button>}</div> : <div className="device-list">{visibleDevices.map((device) => {
        const isLive = liveDevices.some((liveDevice) => liveDevice.id === device.id);
        const isSelected = selectedLiveDeviceIds.includes(device.id);
        const isExpanded = expandedDeviceIds.includes(device.id);
        const updateAvailable = latestUpdate?.download_url && isUpdateAvailable(device.firmware_version, latestUpdate?.version);
        return <article className={`device ${isExpanded ? "expanded" : ""}`} key={device.id}>
          <div className="device-summary">
            <div className="device-info">
              <label className="live-checkbox">
                <input type="checkbox" checked={isSelected} onChange={() => toggleLiveDeviceSelection(device.id)} aria-label={`Vybrat zařízení ${device.name}`} />
              </label>
              <div>
                <div className="device-heading">
                  <h3>{device.name}</h3>
                  <span className={`status ${device.status}`}>{statusLabels[device.status] || device.status}</span>
                </div>
                <p className="muted">{device.model} · {device.serial_number}</p>
                <div className="app-status-row">
                  {(() => {
                    const currentApp = (device.installed_apps || []).find((app) => app.package_name === device.current_app_package);
                    return <div className="current-app">
                      {currentApp?.icon_base64 ? <img className="app-logo" src={`data:image/png;base64,${currentApp.icon_base64}`} alt="" /> : <span className="app-logo" aria-hidden="true">O</span>}
                      <span><span className="current-app-label">Aktuální aplikace</span><strong>{currentApp?.label || device.current_app || "Nezjištěna"}</strong></span>
                    </div>;
                  })()}
                  <button className="force-stop-button" disabled={device.status !== "online" || !device.current_app || device.current_app === "Home" || device.current_app === "Menu"} onClick={() => forceStopApp(device)}>Vynutit ukončení</button>
                  <BatteryIndicators device={device} />
                </div>
              </div>
            </div>
            <div className="actions">
              <button className="live-button" disabled={device.status !== "online" || isLive} onClick={() => openLiveView(device)}>{isLive ? "Sleduji" : "Živě"}</button>
              <InstalledAppsButton apps={device.installed_apps || []} onClick={() => setAppsDevice(device)} />
              <button onClick={() => sendCommand(device, "restart")}>Restart</button>
              {updateAvailable && <button className="primary" disabled={device.status !== "online"} onClick={() => sendCommand(device, "update")}>Aktualizovat</button>}
              <button onClick={() => toggleDeviceLock(device)}>{lockedDeviceIds.includes(device.id) ? "Odemknout" : "Uzamknout"}</button>
              {user.role === "admin" && <button className="danger" onClick={() => removeDevice(device)}>Odstranit</button>}
              <button className="details-toggle" onClick={() => toggleDeviceDetails(device.id)} aria-expanded={isExpanded} aria-label={`${isExpanded ? "Skrýt" : "Zobrazit"} podrobnosti zařízení ${device.name}`}>
                <span aria-hidden="true">{isExpanded ? "⌃" : "⌄"}</span>
              </button>
            </div>
          </div>
          {isExpanded && <div className="device-details">
            <p className="firmware-version">Horizon OS: {device.horizon_os_version || "nezjištěna"}{device.horizon_os_update_pending && <strong> · Čeká systémová aktualizace</strong>}</p>
            <p className="firmware-version">Orbit Agent: {device.firmware_version || "nezjištěna"}{updateAvailable && <strong> · Dostupná aktualizace: {latestUpdate.version}</strong>}</p>
            {device.last_seen_at && <p className="last-seen">Poslední kontakt: {new Date(device.last_seen_at).toLocaleString("cs-CZ")}</p>}
          </div>}
        </article>;
      })}</div>}</section>
    </section>
    {groups.length > 0 && <section className="card device-groups-card">
      <div className="section-heading"><div><p className="eyebrow">SKUPINY HEADSETŮ</p><h2>Skupiny</h2></div><button className={activeGroupId ? "secondary" : "primary"} onClick={() => setActiveGroupId(null)}>Všechny</button></div>
      <div className="group-list">{groups.map((group) => {
        const groupOnlineCount = devices.filter((device) => group.device_ids.includes(device.id) && device.status === "online").length;
        return <article className={`group-row ${activeGroupId === group.id ? "active" : ""}`} key={group.id}>
          <button className="group-select" onClick={() => setActiveGroupId((current) => current === group.id ? null : group.id)}><strong>{group.name}</strong><span>{group.device_ids.length} zařízení · {groupOnlineCount} online</span></button>
          <div className="group-actions">
            <button className="live-button" disabled={groupOnlineCount === 0} onClick={() => watchGroup(group)}>Živě ({groupOnlineCount})</button>
            <button onClick={() => sendGroupCommand(group, "restart")}>Restart</button>
            <button onClick={() => sendGroupCommand(group, "lock")}>Uzamknout</button>
            <button onClick={() => sendGroupCommand(group, "unlock")}>Odemknout</button>
            {user.role === "admin" && <button className="secondary" onClick={() => openEditGroup(group)}>Upravit</button>}
            {user.role === "admin" && <button className="danger" onClick={() => removeGroup(group)}>Odstranit</button>}
          </div>
        </article>;
      })}</div>
    </section>}
    {liveDevices.length > 0 && <LiveViewGallery devices={liveDevices} onClose={closeLiveView} onCloseAll={() => setLiveDevices([])} />}
    {appsDevice && <InstalledAppsModal device={appsDevice} onClose={() => setAppsDevice(null)} onLaunch={(app) => launchApp(appsDevice, app)} />}
    {appsDevices && <CommonInstalledAppsModal devices={appsDevices} onClose={() => setAppsDevices(null)} onLaunch={launchAppOnSelectedDevices} />}
    </>}
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

function InstalledAppsModal({ device, onClose, onLaunch }) {
  const [showSystemApps, setShowSystemApps] = useState(false);
  const [search, setSearch] = useState("");
  const apps = device.installed_apps || [];
  const visibleApps = apps.filter((app) => {
    const matchesFilter = showSystemApps ? app.is_system : !app.is_system;
    const query = search.trim().toLocaleLowerCase();
    return matchesFilter && (!query || `${app.label} ${app.package_name}`.toLocaleLowerCase().includes(query));
  });
  return <div className="live-backdrop"><section className="live-modal apps-modal">
    <div className="section-heading">
      <div><p className="eyebrow">Nainstalované aplikace</p><h2>{device.name}</h2></div>
      <button className="close-button" onClick={onClose} aria-label="Zavřít aplikace">×</button>
    </div>
    <div className="apps-filters">
      <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hledat aplikaci..." aria-label="Hledat aplikaci" />
      <label className="system-apps-toggle"><input type="checkbox" checked={showSystemApps} onChange={(event) => setShowSystemApps(event.target.checked)} /> Zobrazit systémové aplikace ({apps.filter((app) => app.is_system).length})</label>
    </div>
    {visibleApps.length === 0 ? <div className="empty"><p>{apps.length === 0 ? "Seznam aplikací zatím není k dispozici." : "Filtru neodpovídá žádná aplikace."}</p></div> : <div className="apps-grid">
      {visibleApps.map((app) => <article className="app-card" key={app.package_name}>
        {app.icon_base64 ? <img src={`data:image/png;base64,${app.icon_base64}`} alt="" /> : <span className="app-card-placeholder" aria-hidden="true">O</span>}
        <div className="app-card-info"><h3>{app.label}</h3><p>{app.package_name}</p><small>{app.is_system ? "Systémová aplikace" : "Uživatelská aplikace"}{app.version_name && ` · ${app.version_name}`}</small></div>
        {!app.is_system && <button className="app-launch-button" onClick={() => onLaunch(app)}>Spustit</button>}
      </article>)}
    </div>}
  </section></div>;
}

function CommonInstalledAppsModal({ devices, onClose, onLaunch }) {
  const [search, setSearch] = useState("");
  const appsByPackage = devices.map((device) => new Map(
    (device.installed_apps || [])
      .filter((app) => !app.is_system)
      .map((app) => [app.package_name, app]),
  ));
  const commonApps = [...(appsByPackage[0]?.entries() || [])]
    .filter(([packageName]) => appsByPackage.every((apps) => apps.has(packageName)))
    .map(([, app]) => app);
  const query = search.trim().toLocaleLowerCase();
  const visibleApps = commonApps.filter((app) => !query || `${app.label} ${app.package_name}`.toLocaleLowerCase().includes(query));

  return <div className="live-backdrop"><section className="live-modal apps-modal">
    <div className="section-heading">
      <div><p className="eyebrow">SPOLEČNÉ UŽIVATELSKÉ APLIKACE</p><h2>{devices.length} vybraná zařízení</h2></div>
      <button className="close-button" onClick={onClose} aria-label="Zavřít aplikace">×</button>
    </div>
    <p className="muted">Zobrazeny jsou aplikace nainstalované na všech vybraných zařízeních.</p>
    <div className="apps-filters">
      <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hledat aplikaci..." aria-label="Hledat aplikaci" />
    </div>
    {visibleApps.length === 0 ? <div className="empty"><p>{commonApps.length === 0 ? "Vybraná zařízení nemají společnou uživatelskou aplikaci." : "Filtru neodpovídá žádná aplikace."}</p></div> : <div className="apps-grid">
      {visibleApps.map((app) => <article className="app-card" key={app.package_name}>
        {app.icon_base64 ? <img src={`data:image/png;base64,${app.icon_base64}`} alt="" /> : <span className="app-card-placeholder" aria-hidden="true">O</span>}
        <div className="app-card-info"><h3>{app.label}</h3><p>{app.package_name}</p><small>Uživatelská aplikace{app.version_name && ` · ${app.version_name}`}</small></div>
        <button className="app-launch-button" onClick={() => onLaunch(app)}>Spustit na všech</button>
      </article>)}
    </div>}
  </section></div>;
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
