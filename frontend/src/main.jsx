import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const emptyPairing = { name: "", serial_number: "", model: "Meta Quest 2", pin: "" };

const statusLabels = {
  online: "online",
  offline: "offline",
  unknown: "neznámý",
};

const connectionLabels = {
  online: "Server připojen",
  offline: "Server odpojen",
  unknown: "Ověřuji server",
};

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
  const [serverStatus, setServerStatus] = useState("unknown");
  const [liveDevice, setLiveDevice] = useState(null);

  const loadDevices = async () => {
    setLoading(true);
    const [healthResult, devicesResult, pairingsResult] = await Promise.allSettled([
      request("/api/health"),
      request("/api/devices"),
      request("/api/pairing"),
    ]);
    if (healthResult.status === "fulfilled") setServerStatus("online");
    else setServerStatus("offline");
    if (devicesResult.status === "fulfilled") setDevices(devicesResult.value);
    if (pairingsResult.status === "fulfilled") setPairings(pairingsResult.value);
    const failedResult = [healthResult, devicesResult, pairingsResult].find((result) => result.status === "rejected");
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

  const openLiveView = (device) => setLiveDevice(device);

  return <main>
    <header><div><p className="eyebrow">ORBIT / PROTOTYP</p><h1>Správa Quest headsetů</h1><p className="muted">Přehled zařízení a čekajících párování.</p></div><div className="header-actions"><span className={`server-connection ${serverStatus}`}><span className="connection-dot" />{connectionLabels[serverStatus]}</span><button className="secondary" onClick={loadDevices}>Obnovit</button><button className="primary pairing-button" onClick={() => setPairingOpen(true)}>Párovat zařízení</button></div></header>
    {message && <div className="notice">{message}</div>}
    {pairingOpen && <section className="card pairing-form-card"><div className="section-heading"><div><p className="eyebrow">NOVÉ ZAŘÍZENÍ</p><h2>Spustit párování</h2></div><button className="close-button" onClick={() => setPairingOpen(false)} aria-label="Zavřít">×</button></div><p className="muted">V prototypu zde simulujete discovery packet z aplikace headsetu.</p><form className="pairing-form" onSubmit={discoverDevice}><label>Název headsetu<input required autoFocus value={pairingForm.name} onChange={(e) => setPairingForm({ ...pairingForm, name: e.target.value })} placeholder="Např. Quest učebna 1" /></label><label>Sériové číslo<input required value={pairingForm.serial_number} onChange={(e) => setPairingForm({ ...pairingForm, serial_number: e.target.value })} /></label><label>PIN z headsetu<input required inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={pairingForm.pin} onChange={(e) => setPairingForm({ ...pairingForm, pin: e.target.value.replace(/\D/g, "") })} placeholder="4 číslice" /></label><div className="form-actions"><button type="button" onClick={() => setPairingOpen(false)}>Zrušit</button><button className="primary">Odeslat discovery</button></div></form></section>}
    {pairings.length > 0 && <section className="card pairing-card"><div className="section-heading"><h2>Čekající párování</h2><span>{pairings.length} nové</span></div>{pairings.map((pairing) => <article className="device" key={pairing.id}><div><h3>{pairing.name}</h3><p className="muted">{pairing.model} · {pairing.serial_number}</p><span className="status unknown">čeká na potvrzení</span></div><div className="pairing-actions"><button className="primary" onClick={() => confirmPairing(pairing)}>Potvrdit PINem</button><button className="danger" onClick={() => rejectPairing(pairing)}>Odmítnout</button></div></article>)}</section>}
    <section className="layout">
      <section className="card devices-card"><div className="section-heading"><h2>Zařízení</h2><span>{devices.length} celkem</span></div>{loading ? <p className="muted">Načítám...</p> : devices.length === 0 ? <div className="empty"><p>Zatím není spárován žádný headset.</p><button className="primary" onClick={() => setPairingOpen(true)}>Párovat první zařízení</button></div> : <div className="device-list">{devices.map((device) => <article className="device" key={device.id}><div><h3>{device.name}</h3><p className="muted">{device.model} · {device.serial_number}</p><span className={`status ${device.status}`}>{statusLabels[device.status] || device.status}</span>{device.last_seen_at && <p className="last-seen">Poslední kontakt: {new Date(device.last_seen_at).toLocaleString("cs-CZ")}</p>}</div><div className="actions"><button className="live-button" disabled={device.status !== "online"} onClick={() => openLiveView(device)}>Živě</button><button onClick={() => sendCommand(device, "restart")}>Restart</button><button onClick={() => sendCommand(device, "lock")}>Uzamknout</button><button onClick={() => sendCommand(device, "shutdown")}>Vypnout</button><button className="danger" onClick={() => removeDevice(device)}>Odstranit</button></div></article>)}</div>}</section>
    </section>
    {liveDevice && <LiveView device={liveDevice} onClose={() => setLiveDevice(null)} />}
  </main>;
}

function LiveView({ device, onClose }) {
  const videoRef = useRef(null);
  const [connectionState, setConnectionState] = useState("Připojuji živý obraz…");

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

  return <div className="live-backdrop"><section className="live-modal"><div className="section-heading"><div><p className="eyebrow">ŽIVÝ OBRAZ</p><h2>{device.name}</h2></div><button className="close-button" onClick={onClose} aria-label="Zavřít">×</button></div><video ref={videoRef} autoPlay muted playsInline controls={false} onError={() => setConnectionState("Prohlížeč nedokázal přehrát obraz")} /><p className="muted">{connectionState}</p></section></div>;
}

createRoot(document.getElementById("root")).render(<App />);
