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

const scrub = (num) => String(num).replace(/\D/g, '');



// ================= AUTH APIs =================

// SIGNUP
// Helper to keep only digits
const scrub = (num) => String(num).replace(/\D/g, '');

// 1. Updated Signup (Store the cleaned number)
app.post("/signup", (req, res) => {
  const { userName, phoneNumber, email, password } = req.body;
  const cleanPhone = scrub(phoneNumber);

  const newUser = {
    id: users.length + 1,
    userName,
    phoneNumber: cleanPhone, // Save as "9876543210"
    email,
    password
  };

  users.push(newUser);
  res.status(201).json({ message: "User created" });
});

// 2. Updated Sync/Find Route
app.post("/sync-contacts", (req, res) => {
  const { contacts } = req.body; // Expecting ["9876543210", "1234567890"]
  
  const matched = users.filter(u => 
    contacts.map(c => scrub(c)).includes(u.phoneNumber)
  );

  res.json({ matched_users: matched });
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
  const { contacts } = req.body; // Flutter sends {"contacts": ["hash123"]}

  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ error: "No contact provided" });
  }

  const incomingHash = contacts[0];

  // Search the users array for a matching phoneHash
  const foundUser = users.find(u => u.phoneHash === incomingHash);

  if (!foundUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Wrap in matched_users so Flutter's List parsing works
  res.json({ matched_users: [foundUser] }); 
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
