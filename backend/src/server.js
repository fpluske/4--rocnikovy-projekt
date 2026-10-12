import cors from "cors";
import crypto from "node:crypto";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const headsets = [];
const launcherTokens = new Map();
const commandQueues = new Map();
let nextActivityId = 1;
const activity = [];
const users = [];
const password = crypto.randomBytes(12).toString("base64url");
const admins = [{ id: "admin-owner", name: "Výchozí administrátor", email: "admin@localhost", role: "Owner", status: "active", lastLogin: "nikdy" }];
const adminPasswords = new Map([["admin@localhost", password]]);
const sessions = new Set();
const policies = [];
const updates = [];
const collections = { users, admins, policies, updates };

console.log("Orbit default admin: admin@localhost");
console.log(`Orbit default admin password: ${password}`);

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.post("/api/auth/login", (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  const suppliedPassword = req.body.password;
  if (!email || !suppliedPassword || adminPasswords.get(email) !== suppliedPassword) {
    return res.status(401).json({ error: "Neplatný e-mail nebo heslo." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.add(token);
  const admin = admins.find((item) => item.email === email);
  admin.lastLogin = "právě teď";
  res.json({ token, admin: { ...admin } });
});
app.post("/api/auth/logout", (req, res) => {
  sessions.delete(req.headers.authorization?.replace("Bearer ", ""));
  res.status(204).end();
});
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Přihlášení je vyžadováno." });
  next();
};
app.use("/api", (req, _res, next) => (req.path === "/auth/login" || req.path === "/health" || req.path.startsWith("/launcher/") ? next() : requireAuth(req, _res, next)));
app.get("/api/headsets", (_req, res) => res.json(headsets));
app.get("/api/activity", (_req, res) => res.json(activity));
for (const [resource, items] of Object.entries(collections)) {
  app.get(`/api/${resource}`, (_req, res) => res.json(items));
}

function createResource(resource, fields, body) {
  const values = Object.fromEntries(fields.map((field) => [field, typeof body[field] === "string" ? body[field].trim() : body[field]]));
  if (fields.some((field) => !values[field])) return { error: "Vyplňte všechna povinná pole." };
  const uniqueFields = resource === "users" || resource === "admins" ? ["email"] : resource === "policies" ? ["app", "scope"] : fields;
  if (collections[resource].some((item) => uniqueFields.every((field) => item[field]?.toLowerCase?.() === values[field]?.toLowerCase?.()))) {
    return { error: "Záznam se stejnou hodnotou už existuje." };
  }
  const prefix = resource === "policies" ? "policy" : resource.slice(0, -1);
  const item = { id: `${prefix}-${Date.now()}`, ...values, status: "active" };
  collections[resource].unshift(item);
  return { item };
}

app.post("/api/users", (req, res) => {
  const result = createResource("users", ["name", "email", "group"], req.body);
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result.item);
});
app.delete("/api/users/:id", (req, res) => {
  const index = users.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Uživatel nebyl nalezen." });
  users.splice(index, 1);
  res.status(204).end();
});
app.post("/api/admins", (req, res) => {
  const result = createResource("admins", ["name", "email", "role"], req.body);
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result.item);
});
app.delete("/api/admins/:id", (req, res) => {
  const index = admins.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Administrátor nebyl nalezen." });
  if (admins[index].role === "Owner") return res.status(409).json({ error: "Ownera nelze odstranit." });
  admins.splice(index, 1);
  res.status(204).end();
});
app.post("/api/policies", (req, res) => {
  const result = createResource("policies", ["app", "action", "scope"], req.body);
  if (result.error) return res.status(400).json(result);
  result.item.enabled = true;
  res.status(201).json(result.item);
});
app.patch("/api/policies/:id", (req, res) => {
  const policy = policies.find((item) => item.id === req.params.id);
  if (!policy) return res.status(404).json({ error: "Pravidlo nebylo nalezeno." });
  policy.enabled = Boolean(req.body.enabled);
  res.json(policy);
});
app.post("/api/updates/:id/install", (req, res) => {
  const update = updates.find((item) => item.id === req.params.id);
  if (!update) return res.status(404).json({ error: "Aktualizace nebyla nalezena." });
  update.status = "Naplánovaná";
  activity.unshift({ id: nextActivityId++, type: "update", title: "Aktualizace naplánována", detail: update.version, time: new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }) });
  res.json({ message: `Aktualizace ${update.version} byla naplánována.`, update });
});

app.post("/api/headsets", (req, res) => {
  const { name, serial, ip } = req.body;
  if (!name?.trim() || !serial?.trim()) {
    return res.status(400).json({ error: "Název a sériové číslo jsou povinné." });
  }
  if (headsets.some((headset) => headset.serial.toLowerCase() === serial.trim().toLowerCase())) {
    return res.status(409).json({ error: "Headset s tímto sériovým číslem už existuje." });
  }

  const headset = {
    id: `quest-${String(headsets.length + 1).padStart(3, "0")}`,
    name: name.trim(),
    serial: serial.trim(),
    status: "online",
    battery: 100,
    firmware: "v65.0.0",
    lastSeen: "právě teď",
    app: "Domovská obrazovka",
    ip: ip?.trim() || "neznámá",
    launcherConnected: false,
  };
  headsets.push(headset);
  activity.unshift({
    id: nextActivityId++,
    type: "play",
    title: "Headset zaregistrován",
    detail: `${headset.name} · ${headset.serial}`,
    time: new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }),
  });

  res.status(201).json(headset);
});

app.post("/api/launcher/register", (req, res) => {
  const registrationKey = process.env.LAUNCHER_REGISTRATION_KEY;
  const { name, serial, ip } = req.body;
  if (!registrationKey || req.headers["x-launcher-key"] !== registrationKey) {
    return res.status(401).json({ error: "Neplatný registrační klíč launcheru." });
  }
  if (!name?.trim() || !serial?.trim()) {
    return res.status(400).json({ error: "Název a sériové číslo jsou povinné." });
  }
  let headset = headsets.find((item) => item.serial.toLowerCase() === serial.trim().toLowerCase());
  if (!headset) {
    headset = {
      id: `quest-${String(headsets.length + 1).padStart(3, "0")}`,
      name: name.trim(), serial: serial.trim(), status: "online", battery: 100,
      firmware: "unknown", lastSeen: "právě teď", app: "Launcher", ip: ip?.trim() || "neznámá",
      launcherConnected: true,
    };
    headsets.push(headset);
  } else {
    headset.launcherConnected = true;
    headset.status = "online";
    headset.lastSeen = "právě teď";
  }
  const token = crypto.randomBytes(32).toString("hex");
  launcherTokens.set(token, headset.id);
  commandQueues.set(headset.id, commandQueues.get(headset.id) || []);
  res.status(201).json({ deviceId: headset.id, token, pollIntervalMs: 5000, headset });
});

function authenticateLauncher(req, res, next) {
  const deviceId = launcherTokens.get(req.headers.authorization?.replace("Bearer ", ""));
  if (!deviceId) return res.status(401).json({ error: "Launcher není autorizovaný." });
  req.deviceId = deviceId;
  next();
}

app.post("/api/launcher/heartbeat", authenticateLauncher, (req, res) => {
  const headset = headsets.find((item) => item.id === req.deviceId);
  if (!headset) return res.status(404).json({ error: "Zařízení nebylo nalezeno." });
  const { battery, firmware, app, ip } = req.body;
  if (Number.isFinite(battery)) headset.battery = Math.max(0, Math.min(100, battery));
  if (firmware) headset.firmware = firmware;
  if (app) headset.app = app;
  if (ip) headset.ip = ip;
  headset.status = headset.battery <= 25 ? "warning" : "online";
  headset.launcherConnected = true;
  headset.lastSeen = "právě teď";
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

app.get("/api/launcher/commands", authenticateLauncher, (req, res) => {
  const commands = commandQueues.get(req.deviceId) || [];
  commandQueues.set(req.deviceId, []);
  res.json({ commands });
});

app.post("/api/headsets/:id/command", (req, res) => {
  const headset = headsets.find(({ id }) => id === req.params.id);
  const allowedCommands = ["restart", "shutdown", "sync", "update"];
  const { command } = req.body;

  if (!headset) return res.status(404).json({ error: "Headset nebyl nalezen." });
  if (!allowedCommands.includes(command)) {
    return res.status(400).json({ error: "Neplatný příkaz." });
  }
  if (headset.status === "offline") {
    return res.status(409).json({ error: "Headset je offline." });
  }

  if (command === "update") headset.firmware = "v65.0.0";
  if (command === "shutdown") {
    headset.status = "offline";
    headset.app = "—";
  }
  if (command === "restart") {
    headset.status = "online";
    headset.app = "Domovská obrazovka";
  }
  headset.lastSeen = "právě teď";
  commandQueues.set(headset.id, [...(commandQueues.get(headset.id) || []), { id: crypto.randomUUID(), command }]);
  activity.unshift({
    id: nextActivityId++,
    type: command === "shutdown" ? "power" : "update",
    title: `Příkaz ${command} proveden`,
    detail: headset.name,
    time: new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }),
  });
  res.json({ message: `Příkaz ${command} byl odeslán.`, headset });
});

app.listen(port, () => console.log(`Quest API listening on port ${port}`));
