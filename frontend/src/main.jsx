import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, Bell, Check, ChevronDown, CircleHelp, CloudDownload, Command,
  Gamepad2, LayoutDashboard, MoreHorizontal, Play, Power, RefreshCw, Search,
  Settings, ShieldCheck, Signal, Smartphone, Users, Wifi, Zap, UserPlus, Trash2,
} from "lucide-react";
import "./styles.css";

const icons = { update: CloudDownload, power: Power, shield: ShieldCheck, play: Play };
const labels = { dashboard: "Dashboard", headsets: "Headsety", users: "Uživatelé", admins: "Administrátoři", policies: "Omezení aplikací", updates: "Aktualizace", settings: "Nastavení" };
const emptyForm = { name: "", email: "", group: "" };

function Stat({ label, value, note, icon: Icon, color }) {
  return <div className="stat-card"><div className={`stat-icon ${color}`}><Icon size={20} /></div><div><p className="eyebrow">{label}</p><strong>{value}</strong><span>{note}</span></div></div>;
}
function SearchBox({ value, onChange, placeholder = "Hledat..." }) {
  return <div className="search"><Search size={17} /><input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} /></div>;
}
function Modal({ title, subtitle, children, onClose }) {
  return <div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><button className="modal-close" onClick={onClose}>×</button><p className="eyebrow">ORBIT MANAGEMENT</p><h2>{title}</h2>{subtitle && <p className="subheading">{subtitle}</p>}{children}</div></div>;
}

function App() {
  const [section, setSection] = useState("dashboard");
  const [token, setToken] = useState(() => localStorage.getItem("orbit_token"));
  const [login, setLogin] = useState({ email: "admin@localhost", password: "" });
  const [loginError, setLoginError] = useState("");
  const [data, setData] = useState({ headsets: [], activity: [], users: [], admins: [], policies: [], updates: [] });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
    setLoading(true);
    try {
      const resources = ["headsets", "activity", "users", "admins", "policies", "updates"];
      const responses = await Promise.all(resources.map((resource) => fetch(`/api/${resource}`, { headers: { Authorization: `Bearer ${token}` } })));
      if (responses.some((response) => response.status === 401)) {
        localStorage.removeItem("orbit_token");
        setToken(null);
        throw new Error("Relace vypršela. Přihlaste se znovu.");
      }
      if (responses.some((response) => !response.ok)) throw new Error("API není dostupné.");
      const values = await Promise.all(responses.map((response) => response.json()));
      setData(Object.fromEntries(resources.map((resource, index) => [resource, values[index]])));
    } catch (error) { notify(error.message); } finally { setLoading(false); }
  };
  useEffect(() => { if (token) load(); }, [token]);
  const notify = (message) => { setToast(message); window.setTimeout(() => setToast(""), 3500); };
  const request = async (url, options = {}) => {
    const response = await fetch(url, { headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) }, ...options });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(body?.error || "Operace se nepodařila.");
    return body;
  };
  const visibleHeadsets = useMemo(() => data.headsets.filter((item) => `${item.name} ${item.serial}`.toLowerCase().includes(query.toLowerCase()) && (statusFilter === "all" || item.status === statusFilter)), [data.headsets, query, statusFilter]);
  const visibleRows = (items) => items.filter((item) => Object.values(item).join(" ").toLowerCase().includes(query.toLowerCase()));
  const submitResource = async (event, resource, fields) => {
    event.preventDefault();
    try { await request(`/api/${resource}`, { method: "POST", body: JSON.stringify(Object.fromEntries(fields.map((field) => [field, form[field]]))) }); setModal(null); setForm(emptyForm); await load(); notify("Záznam byl úspěšně přidán."); } catch (error) { notify(error.message); }
  };
  const command = async (id, value) => { try { const result = await request(`/api/headsets/${id}/command`, { method: "POST", body: JSON.stringify({ command: value }) }); setSelected(null); await load(); notify(result.message); } catch (error) { notify(error.message); } };
  const remove = async (resource, id) => { if (!window.confirm("Opravdu chcete tento záznam odstranit?")) return; try { await request(`/api/${resource}/${id}`, { method: "DELETE" }); await load(); notify("Záznam byl odstraněn."); } catch (error) { notify(error.message); } };
  const signIn = async (event) => {
    event.preventDefault();
    setLoginError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(login) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      localStorage.setItem("orbit_token", result.token);
      setToken(result.token);
    } catch (error) { setLoginError(error.message); }
  };
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    localStorage.removeItem("orbit_token");
    setToken(null);
  };
  if (!token) return <div className="login-shell"><div className="login-card"><div className="brand login-brand"><div className="brand-mark"><Command size={19} /></div><span>ORBIT<span className="brand-dot">.</span></span></div><p className="eyebrow">ADMINISTRACE VR ZAŘÍZENÍ</p><h1>Přihlášení</h1><p className="subheading">Přihlaste se do své organizace.</p><form className="add-form" onSubmit={signIn}><label>E-mail<input type="email" required value={login.email} onChange={(event) => setLogin({ ...login, email: event.target.value })} /></label><label>Heslo<input type="password" required autoFocus value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} /></label>{loginError && <div className="login-error">{loginError}</div>}<button className="primary login-button" type="submit">Přihlásit se</button></form><small className="login-hint">Přihlašovací údaje pro prvního administrátora vypíše backend při startu.</small></div></div>;

  const nav = (value, Icon, count) => <button className={section === value ? "nav-item active" : "nav-item"} onClick={() => { setSection(value); setQuery(""); }}><Icon size={17} /> {labels[value]} {count !== undefined && <em>{count}</em>}</button>;
  const header = <header><div><p className="breadcrumb">PŘEHLED / <b>{labels[section].toUpperCase()}</b></p><h1>{section === "dashboard" ? <>Dobré ráno, Filipe <span>✦</span></> : labels[section]}</h1><p className="subheading">{section === "dashboard" ? "Tady je přehled vašich VR zařízení." : "Spravujte nastavení své organizace na jednom místě."}</p></div><div className="header-actions"><button className="icon-button" onClick={load} title="Obnovit data"><Bell size={18} /><i /></button><div className="date-pill">7. října 2026 <ChevronDown size={15} /></div></div></header>;

  const dashboard = <><section className="stats"><Stat label="Celkem headsetů" value={data.headsets.length || "—"} note="ve vaší organizaci" icon={Gamepad2} color="teal" /><Stat label="Online nyní" value={`${data.headsets.filter((h) => h.status === "online").length} / ${data.headsets.length || "—"}`} note="zařízení připojeno" icon={Signal} color="blue" /><Stat label="Vyžaduje pozornost" value={data.headsets.filter((h) => h.status === "warning").length} note="nízká baterie nebo update" icon={Zap} color="orange" /><Stat label="Průměrná baterie" value={data.headsets.length ? `${Math.round(data.headsets.reduce((sum, h) => sum + h.battery, 0) / data.headsets.length)} %` : "—"} note="napříč zařízeními" icon={Activity} color="purple" /></section><div className="content-grid"><DeviceTable items={visibleHeadsets} onSelect={setSelected} onAdd={() => setModal("headset")} /><ActivityPanel /></div></>;

  function DeviceTable({ items, onSelect, onAdd }) {
    return <section className="panel devices-panel"><div className="panel-heading"><div><h2>Vaše headsety</h2><p>Spravujte a monitorujte všechna připojená zařízení.</p></div><button className="primary" onClick={onAdd}><span>+</span> Přidat headset</button></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Hledat podle názvu nebo sériového čísla..." /><select className="filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">Všechny stavy</option><option value="online">Online</option><option value="warning">Pozornost</option><option value="offline">Offline</option></select></div><div className="table-wrap"><table><thead><tr><th>ZAŘÍZENÍ</th><th>STAV</th><th>AKTUÁLNÍ APLIKACE</th><th>ENERGIE</th><th>FIRMWARE</th><th /></tr></thead><tbody>{loading ? <tr><td colSpan="6" className="empty-state">Načítám…</td></tr> : items.length === 0 ? <tr><td colSpan="6" className="empty-state">Žádný headset neodpovídá filtru.</td></tr> : items.map((h) => <tr key={h.id} onClick={() => onSelect(h)}><td><div className="device-name"><div className="device-icon"><Gamepad2 size={18} /></div><div><b>{h.name}</b><small>{h.serial} · {h.ip}</small></div></div></td><td><span className={`status ${h.status}`}>{h.status === "online" ? "Online" : h.status === "warning" ? "Pozornost" : "Offline"}</span><small>{h.lastSeen}</small></td><td><div className="app-cell"><Play size={12} fill="currentColor" />{h.app}</div></td><td><div className="battery"><div><span style={{ width: `${h.battery}%` }} /></div><b>{h.battery}%</b></div></td><td><span className="firmware">{h.firmware}</span></td><td><button className="row-menu" onClick={(e) => { e.stopPropagation(); onSelect(h); }}><MoreHorizontal size={18} /></button></td></tr>)}</tbody></table></div><div className="table-footer"><span>Zobrazeno {items.length} z {data.headsets.length} zařízení</span><button className="more-link" onClick={() => { setQuery(""); setStatusFilter("all"); }}>Zobrazit všechna zařízení →</button></div></section>;
  }
  function ActivityPanel() { return <aside className="panel activity-panel"><div className="panel-heading"><div><h2>Aktivita</h2><p>Poslední události v systému.</p></div></div><div className="activity-list">{data.activity.slice(0, 6).map((event) => { const Icon = icons[event.type] || Activity; return <div className="activity-item" key={event.id}><div className={`activity-icon ${event.type}`}><Icon size={15} /></div><div><b>{event.title}</b><small>{event.detail}</small></div><time>{event.time}</time></div>; })}</div><div className="system-status"><Wifi size={16} /><div><b>Systém funguje správně</b><small>Všechna API připojení jsou aktivní</small></div><span /></div></aside>; }

  function ResourcePage({ resource, title, fields, columns, addLabel }) {
    const rows = visibleRows(data[resource]);
    const add = async () => {
      if (resource !== "updates") { setForm(resource === "users" ? emptyForm : { name: "", email: "", role: "" }); setModal(resource); return; }
      const update = data.updates.find((item) => item.status === "Dostupná");
      if (!update) return notify("Všechna zařízení jsou aktuální.");
      try { const result = await request(`/api/updates/${update.id}/install`, { method: "POST" }); await load(); notify(result.message); } catch (error) { notify(error.message); }
    };
    return <section className="panel resource-page"><div className="panel-heading"><div><h2>{title}</h2><p>Spravujte záznamy a jejich oprávnění.</p></div><button className="primary" onClick={add}><span>+</span> {addLabel}</button></div><div className="toolbar"><SearchBox value={query} onChange={setQuery} /></div><div className="table-wrap"><table><thead><tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}<th /></tr></thead><tbody>{rows.map((item) => <tr key={item.id}>{columns.map(([key]) => <td key={key}>{key === "status" ? <span className={`status ${item[key] === "active" ? "online" : "offline"}`}>{item[key] === "active" ? "Aktivní" : item[key]}</span> : key === "enabled" ? <button className={`toggle ${item.enabled ? "enabled" : ""}`} onClick={async () => { await request(`/api/policies/${item.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) }); load(); }}><Check size={13} /></button> : <span>{item[key]}</span>}</td>)}<td>{resource !== "updates" && <button className="row-menu" onClick={() => remove(resource, item.id)}><Trash2 size={16} /></button>}</td></tr>)}</tbody></table>{rows.length === 0 && <div className="empty-state">Žádné záznamy.</div>}</div></section>;
  }
  const current = section === "dashboard" ? dashboard : section === "headsets" ? <DeviceTable items={visibleHeadsets} onSelect={setSelected} onAdd={() => setModal("headset")} /> : section === "users" ? <ResourcePage resource="users" title="Uživatelé" addLabel="Přidat uživatele" fields={["name", "email", "group"]} columns={[["name", "JMÉNO"], ["email", "E-MAIL"], ["group", "SKUPINA"], ["status", "STAV"], ["lastLogin", "POSLEDNÍ PŘIHLÁŠENÍ"]]} /> : section === "admins" ? <ResourcePage resource="admins" title="Administrátoři" addLabel="Přidat administrátora" fields={["name", "email", "role"]} columns={[["name", "JMÉNO"], ["email", "E-MAIL"], ["role", "ROLE"], ["status", "STAV"], ["lastLogin", "POSLEDNÍ PŘIHLÁŠENÍ"]]} /> : section === "policies" ? <ResourcePage resource="policies" title="Omezení aplikací" addLabel="Přidat pravidlo" fields={["app", "action", "scope"]} columns={[["app", "APLIKACE"], ["action", "AKCE"], ["scope", "ROZSAH"], ["enabled", "AKTIVNÍ"]]} /> : section === "updates" ? <ResourcePage resource="updates" title="Aktualizace" addLabel="Aktualizovat zařízení" fields={[]} columns={[["version", "VERZE"], ["status", "STAV"], ["devices", "ZAŘÍZENÍ"], ["released", "VYDÁNO"]]} /> : <div className="panel resource-page"><div className="panel-heading"><div><h2>Nastavení</h2><p>Základní nastavení organizace.</p></div></div><div className="settings-list"><label>Název organizace<input defaultValue="Fpluske Academy" /></label><label>Výchozí firmware<input defaultValue="v65.0.0" /></label><button className="primary" onClick={() => notify("Nastavení bylo uloženo.")}>Uložit nastavení</button></div></div>;

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Command size={19} /></div><span>ORBIT<span className="brand-dot">.</span></span></div><div className="workspace"><div className="workspace-avatar">F</div><div><b>Fpluske Academy</b><small>Administrátor</small></div><ChevronDown size={15} /></div><nav><p className="nav-label">PŘEHLED</p>{nav("dashboard", LayoutDashboard)}{nav("headsets", Smartphone, data.headsets.length)}{nav("users", Users, data.users.length)}<p className="nav-label">SPRÁVA</p>{nav("admins", UserPlus, data.admins.length)}{nav("policies", ShieldCheck)}{nav("updates", RefreshCw)}{nav("settings", Settings)}</nav><div className="sidebar-bottom"><div className="help"><CircleHelp size={18} /><div><b>Potřebujete pomoc?</b><small>Dokumentace a podpora</small></div></div><div className="user-row"><div className="user-avatar">FP</div><div><b>Filip Pluskal</b><small>admin@localhost</small></div><button className="logout-button" onClick={signOut} title="Odhlásit"><MoreHorizontal size={17} /></button></div></div></aside><main>{header}{current}<footer><span>© 2026 Orbit Management</span><span className="api-status"><i /> API připojeno</span><span>v0.1.0</span></footer></main>
    {selected && <Modal title={selected.name} subtitle={selected.serial} onClose={() => setSelected(null)}><div className="modal-grid"><div><span>Stav</span><b className={`status ${selected.status}`}>{selected.status}</b></div><div><span>Baterie</span><b>{selected.battery}%</b></div><div><span>Firmware</span><b>{selected.firmware}</b></div><div><span>IP adresa</span><b>{selected.ip}</b></div></div><p className="modal-label">Akce zařízení</p><div className="modal-actions"><button disabled={selected.status === "offline"} onClick={() => command(selected.id, "sync")}><RefreshCw size={16} /> Synchronizovat</button><button disabled={selected.status === "offline"} onClick={() => command(selected.id, "update")}><CloudDownload size={16} /> Aktualizovat</button><button disabled={selected.status === "offline"} onClick={() => command(selected.id, "restart")}><RefreshCw size={16} /> Restartovat</button><button className="danger" disabled={selected.status === "offline"} onClick={() => command(selected.id, "shutdown")}><Power size={16} /> Vypnout</button></div></Modal>}
    {modal && <Modal title={modal === "headset" ? "Přidat headset" : modal === "users" ? "Přidat uživatele" : modal === "admins" ? "Přidat administrátora" : "Přidat pravidlo"} subtitle="Vyplňte údaje a záznam se uloží do systému." onClose={() => setModal(null)}><form className="add-form" onSubmit={(event) => modal === "headset" ? submitResource(event, "headsets", ["name", "serial", "ip"]) : submitResource(event, modal, modal === "policies" ? ["app", "action", "scope"] : modal === "users" ? ["name", "email", "group"] : ["name", "email", "role"])}>{(modal === "headset" ? [["name", "Název zařízení"], ["serial", "Sériové číslo"], ["ip", "IP adresa"]] : modal === "policies" ? [["app", "Aplikace"], ["action", "Akce"], ["scope", "Rozsah"]] : [["name", "Jméno"], ["email", "E-mail"], [modal === "users" ? "group" : "role", modal === "users" ? "Skupina" : "Role"]]).map(([key, label]) => <label key={key}>{label}<input required value={form[key] || ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}<div className="form-actions"><button type="button" className="secondary" onClick={() => setModal(null)}>Zrušit</button><button className="primary" type="submit">Uložit</button></div></form></Modal>}{toast && <div className="toast">{toast}</div>}</div>;
}

createRoot(document.getElementById("root")).render(<App />);
