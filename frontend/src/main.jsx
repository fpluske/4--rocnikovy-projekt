import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const emptyPairing = { name: "", serial_number: "", model: "Meta Quest 2", pin: "" };

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Požadavek se nepodařilo dokončit.");
  }
  return response.status === 204 ? null : response.json();
}

function App() {
  const [devices, setDevices] = useState([]);
  const [pairings, setPairings] = useState([]);
  const [pairingForm, setPairingForm] = useState(emptyPairing);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const loadDevices = async () => {
    setLoading(true);
    try {
      const [loadedDevices, loadedPairings] = await Promise.all([request("/api/devices"), request("/api/pairing")]);
      setDevices(loadedDevices);
      setPairings(loadedPairings);
    }
    catch (error) { setMessage(error.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadDevices(); }, []);

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

  const confirmPairing = async (pairing) => {
    const pin = window.prompt(`Zadejte 4místný PIN z aplikace headsetu „${pairing.name}“:`);
    if (pin === null) return;
    try {
      await request(`/api/pairing/${pairing.id}/confirm`, { method: "POST", body: JSON.stringify({ pin }) });
      setMessage("Headset byl úspěšně spárován.");
      await loadDevices();
    } catch (error) { setMessage(error.message); }
  };

  return <main>
    <header><div><p className="eyebrow">ORBIT / PROTOTYP</p><h1>Správa Quest headsetů</h1><p className="muted">Přehled zařízení a čekajících párování.</p></div><div className="header-actions"><button className="secondary" onClick={loadDevices}>Obnovit</button><button className="primary pairing-button" onClick={() => setPairingOpen(true)}>Párovat zařízení</button></div></header>
    {message && <div className="notice">{message}</div>}
    {pairingOpen && <section className="card pairing-form-card"><div className="section-heading"><div><p className="eyebrow">NOVÉ ZAŘÍZENÍ</p><h2>Spustit párování</h2></div><button className="close-button" onClick={() => setPairingOpen(false)} aria-label="Zavřít">×</button></div><p className="muted">V prototypu zde simulujete discovery packet z aplikace headsetu.</p><form className="pairing-form" onSubmit={discoverDevice}><label>Název headsetu<input required autoFocus value={pairingForm.name} onChange={(e) => setPairingForm({ ...pairingForm, name: e.target.value })} placeholder="Např. Quest učebna 1" /></label><label>Sériové číslo<input required value={pairingForm.serial_number} onChange={(e) => setPairingForm({ ...pairingForm, serial_number: e.target.value })} /></label><label>PIN z headsetu<input required inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={pairingForm.pin} onChange={(e) => setPairingForm({ ...pairingForm, pin: e.target.value.replace(/\D/g, "") })} placeholder="4 číslice" /></label><div className="form-actions"><button type="button" onClick={() => setPairingOpen(false)}>Zrušit</button><button className="primary">Odeslat discovery</button></div></form></section>}
    {pairings.length > 0 && <section className="card pairing-card"><div className="section-heading"><h2>Čekající párování</h2><span>{pairings.length} nové</span></div>{pairings.map((pairing) => <article className="device" key={pairing.id}><div><h3>{pairing.name}</h3><p className="muted">{pairing.model} · {pairing.serial_number}</p><span className="status unknown">čeká na potvrzení</span></div><button className="primary" onClick={() => confirmPairing(pairing)}>Potvrdit PINem</button></article>)}</section>}
    <section className="layout">
      <section className="card devices-card"><div className="section-heading"><h2>Zařízení</h2><span>{devices.length} celkem</span></div>{loading ? <p className="muted">Načítám...</p> : devices.length === 0 ? <div className="empty"><p>Zatím není spárován žádný headset.</p><button className="primary" onClick={() => setPairingOpen(true)}>Párovat první zařízení</button></div> : <div className="device-list">{devices.map((device) => <article className="device" key={device.id}><div><h3>{device.name}</h3><p className="muted">{device.model} · {device.serial_number}</p><span className={`status ${device.status}`}>{device.status}</span></div><div className="actions"><button onClick={() => sendCommand(device, "restart")}>Restart</button><button onClick={() => sendCommand(device, "lock")}>Uzamknout</button><button onClick={() => sendCommand(device, "shutdown")}>Vypnout</button></div></article>)}</div>}</section>
    </section>
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
