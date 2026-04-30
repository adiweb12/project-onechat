const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = "onechat_secret";

// ====== FAKE DATABASE (Replace with MongoDB later) ======
let users = [];
let groups = [];
let phoneHashMap = new Map();
let userSockets = {}; // phoneNumber -> WebSocket

//======= PHONE NUMBER INDIAN CODE======
function formatToE164(number) {
    if (!number || typeof number !== 'string') return null; // FIX: Prevents the TypeError crash
    const phone = parsePhoneNumberFromString(number, 'IN');
    return phone ? phone.number : null;
}

//======= PHONE NUMBER HASHING LOGIC=====
// Add this helper to make sure we always hash the same way
function hashNumber(num) {
  // Strip everything except digits to be 100% safe
  const cleanNum = num.replace(/\D/g, ''); 
  return crypto.createHash("sha256").update(cleanNum).digest("hex");
}

// ================= AUTH APIs =================

// SIGNUP
app.post("/signup", (req, res) => {
  const { userName, email, phoneNumber, dob, password } = req.body;

  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: "Email already exists" });
  }

  const formattedNumber = formatToE164(phoneNumber);
  if (!formattedNumber) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const phoneHash = hashNumber(formattedNumber);

  const newUser = {
    id: users.length + 1,
    userName,
    email,
    phoneNumber: formattedNumber,
    phoneHash,
    dob,
    password
  };

  users.push(newUser);

  // ✅ correct map insert
  phoneHashMap.set(phoneHash, newUser);

  res.status(201).json({ message: "User created" });
});

// LOGIN
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  const user = users.find(u => u.email === email && u.password === password);

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const access_token = jwt.sign({ id: user.id }, JWT_SECRET);
  const refresh_token = jwt.sign({ id: user.id }, JWT_SECRET);

  res.json({
    access_token,
    refresh_token,
    user
  });
});

// UPDATE EMAIL
app.put("/update-email", (req, res) => {
  const { phoneNumber, newEmail } = req.body;

  const user = users.find(u => u.phoneNumber === phoneNumber);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.email = newEmail;
  res.json({ message: "Email updated" });
});

// UPDATE PASSWORD
app.put("/update-password", (req, res) => {
  const { email, newPassword } = req.body;

  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.password = newPassword;
  res.json({ message: "Password updated" });
});

// ================= CONTACT SYNC =================

app.post("/sync-contacts", (req, res) => {
  const { contacts } = req.body;

  console.log("Incoming:", contacts);

  const matched = users.filter(u =>
    contacts.includes(u.phoneHash) ||
    contacts.includes(hashNumber(u.phoneNumber))
  );

  res.json({ matched_users: matched });
});
// ================= GROUP =================

app.post("/onechat/create-group", (req, res) => {
  const { groupName, members } = req.body;

  const newGroup = {
    id: uuidv4(),
    groupName,
    members
  };

  groups.push(newGroup);

  res.status(201).json({ message: "Group created" });
});


// 2. Update the find-user route to match your Flutter payload
app.post("/find-user", (req, res) => {
  // 1. Get the hash from the 'contacts' list sent by Flutter
  const { contacts } = req.body;

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: "No hash provided" });
  }

  const searchHash = contacts[0];

  // 2. Look for the user using the phoneHash
  const user = users.find(u => u.phoneHash === searchHash);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // 3. Wrap it in 'matched_users' so Flutter's List parsing works
  res.json({ matched_users: [user] }); 
});


// ================= WEBSOCKET =================

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      /**
       msg format expected:
       {
         type: "register" | "message",
         from: "phone",
         to: "phone",
         message: "hello"
       }
      */

      // REGISTER USER SOCKET
      if (msg.type === "register") {
        userSockets[msg.from] = ws;
        console.log("Registered:", msg.from);
        return;
      }

      // SEND MESSAGE
      if (msg.type === "message") {
        const receiverSocket = userSockets[msg.to];

        if (receiverSocket) {
          receiverSocket.send(JSON.stringify(msg));
        }
      }

    } catch (err) {
      console.log("Error:", err);
    }
  });

  ws.on("close", () => {
    // Remove disconnected user
    for (let key in userSockets) {
      if (userSockets[key] === ws) {
        delete userSockets[key];
        break;
      }
    }
    console.log("Client disconnected");
  });
});
