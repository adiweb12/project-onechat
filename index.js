const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const authenticate = require("./middleware/jwt_manager");
const { JWT_SECRET, PORT } = require("./configs/config");
const passSecurityChecker = require("./security/passManager");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ====== FAKE DATABASE ======
let users = [];
let groups = [];
let messages = [];
let userSockets = {}; // phoneNumber -> WebSocket

// ======= HELPER FUNCTIONS =======

/**
 * Standardizes numbers to the last 10 digits for accurate matching.
 * Handles +91, 0, or raw formats.
 */
const getLast10 = (num) => {
  if (!num) return "";
  const cleaned = String(num).replace(/\D/g, '');
  return cleaned.slice(-10);
};

const scrub = (num) => {
  if (!num) return "";
  return String(num).replace(/\D/g, '');
};

// ================= AUTH APIs =================

app.post("/signup", (req, res) => {
  const { userName, phoneNumber, email, dob, password } = req.body;
  
  if (!phoneNumber || !email || !password || !userName || !dob) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  if (!passSecurityChecker(password)) {
    return res.status(400).json({ error: "Weak password" });
  }

  const cleanPhone = scrub(phoneNumber);

  if (users.find(u => u.email === email || u.phoneNumber === cleanPhone)) {
    return res.status(400).json({ error: "User already exists" });
  }

  const newUser = {
    id: uuidv4(), // Use UUID for consistency
    userName,
    email,
    phoneNumber: cleanPhone, 
    dob,
    password
  };

  users.push(newUser);
  console.log(`User Registered: ${userName} (${cleanPhone})`);
  res.status(201).json({ message: "User created" });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const access_token = jwt.sign({ id: user.id }, JWT_SECRET);
  const refresh_token = jwt.sign({ id: user.id }, JWT_SECRET);

  res.json({ access_token, refresh_token, user });
});

// ======= SYNC CONTACTS (FIXED FOR PERFORMANCE & LOOPS) =======
app.post("/sync-contacts", (req, res) => {
  const { contacts } = req.body;

  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ error: "Invalid format" });
  }

  // 1. Map registered users by their last 10 digits (Fast O(1) lookup)
  const registeredMap = new Map();
  users.forEach(u => {
    const key = getLast10(u.phoneNumber);
    if (key.length === 10) registeredMap.set(key, u);
  });

  // 2. Match incoming contacts
  const matched = [];
  const seenIds = new Set();

  contacts.forEach(contactNum => {
    const key = getLast10(contactNum);
    if (registeredMap.has(key)) {
      const user = registeredMap.get(key);
      if (!seenIds.has(user.id)) {
        matched.push(user);
        seenIds.add(user.id);
      }
    }
  });

  console.log(`Sync: Scanned ${contacts.length}, Found ${matched.length}`);
  res.json({ matched_users: matched });
});

app.post("/find-user", (req, res) => {
  const { contacts } = req.body; 
  if (!contacts || contacts.length === 0) return res.status(400).json({ error: "No contact" });

  const searchKey = getLast10(contacts[0]);
  const foundUser = users.find(u => getLast10(u.phoneNumber) === searchKey);

  if (!foundUser) return res.status(404).json({ error: "Not found" });
  res.json({ matched_users: [foundUser] }); 
});

// ======== UPDATES ============

app.put("/update-email", authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.email = req.body.newEmail;
  res.json({ message: "Email updated" });
});

app.put("/update-password", authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user || !passSecurityChecker(req.body.newPassword)) {
    return res.status(400).json({ error: "Invalid request" });
  }
  user.password = req.body.newPassword;
  res.json({ message: "Password updated" });
});

// ================= GROUPS & MESSAGES =================

app.post("/onechat/create-group", (req, res) => {
  const newGroup = { id: uuidv4(), groupName: req.body.groupName, members: req.body.members };
  groups.push(newGroup);
  res.status(201).json({ message: "Group created" });
});

app.get("/messages/:phone", (req, res) => {
  const phone = scrub(req.params.phone);
  const userMessages = messages.filter(m => m.from === phone || m.to === phone);
  res.json(userMessages);
});

// ================= WEBSOCKET LOGIC =================

const server = app.listen(PORT, () => {
  console.log(`Server live on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("WS Connected");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "register") {
        const cleanFrom = scrub(msg.from);
        userSockets[cleanFrom] = ws;
        console.log("Registered:", cleanFrom);
        return;
      }

      if (msg.type === "message") {
        const newMsg = {
          id: msg.id || uuidv4(),
          from: scrub(msg.from),
          to: scrub(msg.to),
          message: msg.message,
          time: msg.time || new Date().toISOString()
        };

        // Deduplicate
        if (!messages.some(m => m.id === newMsg.id)) {
          messages.push(newMsg);
        }

        // Relay to recipient
        const receiverSocket = userSockets[newMsg.to];
        if (receiverSocket && receiverSocket.readyState === 1) {
          receiverSocket.send(JSON.stringify(newMsg));
        }
      }
    } catch (err) {
      console.log("WS Error:", err);
    }
  });

  ws.on("close", () => {
    // Cleanup sockets
    Object.keys(userSockets).forEach(phone => {
      if (userSockets[phone] === ws) delete userSockets[phone];
    });
  });
});
