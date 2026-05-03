const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const authenticate = require("./middleware/jwt_manager");
const { JWT_SECRET, PORT } = require("./configs/config");
const passSecurityChecker = require("./security/passManager");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===================================================================
//  IN-MEMORY STORE  (replace with PostgreSQL / MongoDB in production)
// ===================================================================
let users = [];      // { id, userName, email, phoneNumber, dob, passwordHash }
let messages = [];   // { id, from, to, message, time, msgType, status }
let userSockets = {}; // phoneNumber → WebSocket

// ── Helpers ─────────────────────────────────────────────────────────

const scrub = (num) => num ? String(num).replace(/\D/g, "") : "";
const getLast10 = (num) => String(num).replace(/\D/g, "").slice(-10);

/** Hash a password with SHA-256 + app salt */
function hashPassword(plain) {
  return crypto
    .createHmac("sha256", JWT_SECRET)
    .update(plain)
    .digest("hex");
}

// ===================================================================
//  AUTH ROUTES
// ===================================================================

// ── SIGNUP ──────────────────────────────────────────────────────────
app.post("/signup", (req, res) => {
  const { userName, phoneNumber, email, dob, password } = req.body;

  if (!phoneNumber || !email || !password || !userName || !dob) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!passSecurityChecker(password)) {
    return res.status(400).json({
      error:
        "Password must contain uppercase, lowercase, number and special character",
    });
  }

  const cleanPhone = scrub(phoneNumber);

  if (users.find((u) => u.email === email || u.phoneNumber === cleanPhone)) {
    return res.status(400).json({ error: "User already exists" });
  }

  const newUser = {
    id: users.length + 1,
    userName,
    email,
    phoneNumber: cleanPhone,
    dob,
    passwordHash: hashPassword(password), // ✅ never store plain text
  };

  users.push(newUser);
  console.log(`✅ Registered: ${userName} (${cleanPhone})`);
  res.status(201).json({ message: "User created" });
});

// ── LOGIN ────────────────────────────────────────────────────────────
app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const hash = hashPassword(password);
  const user = users.find((u) => u.email === email && u.passwordHash === hash);

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials or User not Found" });
  }

  const payload = { id: user.id };
  const access_token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
  const refresh_token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

  // Never expose passwordHash in response
  const { passwordHash, ...safeUser } = user;
  res.json({ access_token, refresh_token, user: safeUser });
});

// ── REFRESH TOKEN ────────────────────────────────────────────────────
app.post("/onechat/refresh", authenticate, (req, res) => {
  const payload = { id: req.user.id };
  const access_token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
  res.json({ access_token });
});

// ===================================================================
//  CONTACT ROUTES
// ===================================================================

app.post("/sync-contacts", (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) {
    return res.status(400).json({ error: "Invalid format" });
  }

  const userMap = new Map();
  users.forEach((u) => {
    const last10 = getLast10(u.phoneNumber);
    if (last10.length === 10) userMap.set(last10, u);
  });

  const matched = [];
  contacts.forEach((c) => {
    const key = getLast10(c);
    if (userMap.has(key)) matched.push(userMap.get(key));
  });

  const unique = [
    ...new Map(matched.map((u) => [u.id, u])).values(),
  ].map(({ passwordHash, ...safe }) => safe); // strip hash

  res.json({ matched_users: unique });
});

app.post("/find-user", (req, res) => {
  const { contacts } = req.body;
  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ error: "No contact provided" });
  }

  const search = scrub(contacts[0]);
  const found = users.find((u) => u.phoneNumber === search);

  if (!found) return res.status(404).json({ error: "User not found" });

  const { passwordHash, ...safe } = found;
  res.json({ matched_users: [safe] });
});

// ===================================================================
//  PROFILE UPDATES
// ===================================================================

app.put("/update-email", authenticate, (req, res) => {
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.email = req.body.newEmail;
  res.json({ message: "Email updated" });
});

app.put("/update-password", authenticate, (req, res) => {
  const { newPassword } = req.body;
  if (!passSecurityChecker(newPassword)) {
    return res.status(400).json({
      error:
        "Password must contain uppercase, lowercase, number and special character",
    });
  }
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.passwordHash = hashPassword(newPassword);
  res.json({ message: "Password updated" });
});

// ===================================================================
//  CHAT & MESSAGE HISTORY
// ===================================================================

app.get("/messages", (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) return res.status(400).json({ error: "Missing users" });

  const chat = messages
    .filter(
      (m) =>
        (m.from === user1 && m.to === user2) ||
        (m.from === user2 && m.to === user1)
    )
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  res.json(chat);
});

app.get("/chat-list/:phone", (req, res) => {
  const myPhone = req.params.phone;
  const chatMap = new Map();

  messages.forEach((m) => {
    if (m.from === myPhone || m.to === myPhone) {
      const other = m.from === myPhone ? m.to : m.from;
      const existing = chatMap.get(other);
      if (!existing || new Date(m.time) > new Date(existing.time)) {
        chatMap.set(other, m);
      }
    }
  });

  const list = [];
  chatMap.forEach((msg, phone) => {
    list.push({
      id: phone,
      receiverName: phone,
      receiverNum: phone,
      lastMessage: msg.message,
      time: msg.time,
    });
  });

  list.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(list);
});

// ===================================================================
//  GROUP MANAGEMENT
// ===================================================================

app.post("/onechat/create-group", authenticate, (req, res) => {
  const { groupName, members } = req.body;
  res.status(201).json({ message: "Group created", id: uuidv4() });
});

// ===================================================================
//  HTTP SERVER + WEBSOCKET
// ===================================================================

const server = app.listen(PORT, () => {
  console.log(`🚀 OneChat server running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 WS Client connected");

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // ── PING / PONG ────────────────────────────────────────────
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // ── REGISTER ───────────────────────────────────────────────
      if (msg.type === "register") {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          const user = users.find((u) => u.id === decoded.id);
          if (!user) { ws.close(); return; }

          userSockets[user.phoneNumber] = ws;
          console.log(`✅ WS Registered: ${user.phoneNumber}`);
        } catch (_) {
          ws.close();
        }
        return;
      }

      // ── OUTGOING MESSAGE ───────────────────────────────────────
      if (msg.type === "message") {
        const decoded = jwt.verify(msg.token, JWT_SECRET);
        const sender = users.find(
          (u) => u.id === decoded.id && u.phoneNumber === msg.from
        );
        if (!sender) return; // reject spoofed from-phone

        const newMsg = {
          id: msg.id || uuidv4(),
          from: msg.from,
          to: msg.to,
          message: msg.message,
          msgType: msg.msgType || "text",
          time: new Date().toISOString(),
          status: "sent",
        };

        if (messages.find((m) => m.id === newMsg.id)) return; // dedup
        messages.push(newMsg);

        const receiverSocket = userSockets[msg.to];
        if (receiverSocket && receiverSocket.readyState === 1) {
          receiverSocket.send(JSON.stringify({ type: "message", ...newMsg }));
        }
        return;
      }

      // ── STATUS UPDATE (delivered / read) ───────────────────────
      if (msg.type === "status") {
        // Update our in-memory record
        const record = messages.find((m) => m.id === msg.id);
        if (record) record.status = msg.status;

        // Forward to the original sender
        // "msg.to" here is the original sender of the message
        const senderSocket = userSockets[msg.to];
        if (senderSocket && senderSocket.readyState === 1) {
          senderSocket.send(
            JSON.stringify({
              type: "status",
              id: msg.id,
              status: msg.status,
            })
          );
        }
        return;
      }
    } catch (err) {
      console.error("WS Error:", err.message);
    }
  });

  ws.on("close", () => {
    // Remove from registry
    for (const [phone, sock] of Object.entries(userSockets)) {
      if (sock === ws) {
        delete userSockets[phone];
        console.log(`📴 WS Disconnected: ${phone}`);
        break;
      }
    }
  });
});
