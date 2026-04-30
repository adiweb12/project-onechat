const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const authenticate = require("./middleware/jwt_manager");
const { JWT_SECRET , PORT } = require("./configs/config");
const passSecurityChecker = require("./security/passManager");

const app = express();
app.use(cors());
app.use(bodyParser.json());


// ====== FAKE DATABASE (Resets on every Render deploy/restart) ======
let users = [];
let groups = [];
let userSockets = {}; // phoneNumber -> WebSocket

// ======= HELPER FUNCTIONS =======

/**
 * Removes all non-digit characters from a string.
 * Ensures "+91 98765-43210" becomes "919876543210"
 */
const scrub = (num) => {
  if (!num) return "";
  return String(num).replace(/\D/g, '');
};

// ================= AUTH APIs =================

//======= SIGNUP ===========
app.post("/signup", (req, res) => {
  const { userName, phoneNumber, email, dob, password } = req.body;
  
  if (!phoneNumber || !email || !password || !userName || !dob) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  if(!passSecurityChecker(password)){
      return res.status(400).json({ error: "Password must contain uppercase, lowercase, number and special character"});
  }

  const cleanPhone = scrub(phoneNumber);

  // Check if user already exists
  if (users.find(u => u.email === email || u.phoneNumber === cleanPhone)) {
    return res.status(400).json({ error: "User already exists" });
  }

  const newUser = {
    id: users.length + 1,
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

//============= LOGIN ===========
app.post("/login", (req, res) => {
  const { email, password } = req.body;

  const user = users.find(u => u.email === email && u.password === password);

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials or User not Found" });
  }

  const access_token = jwt.sign({ id: user.id }, JWT_SECRET);
  const refresh_token = jwt.sign({ id: user.id }, JWT_SECRET);

  res.json({
    access_token,
    refresh_token,
    user
  });
});

//======= SYNC MULTIPLE CONTACTS ======
app.post("/sync-contacts", (req, res) => {
  const { contacts } = req.body;

  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ error: "Invalid format" });
  }

  // Helper to get only the last 10 digits of a number
  const getLast10 = (num) => {
    const cleaned = String(num).replace(/\D/g, '');
    return cleaned.slice(-10);
  };

  // Create a Map of the last 10 digits to the actual user object for instant lookup
  const userMap = new Map();
  users.forEach(u => {
    const last10 = getLast10(u.phoneNumber);
    if (last10.length === 10) {
      userMap.set(last10, u);
    }
  });

  const matched = [];
  contacts.forEach(contactNum => {
    const contactLast10 = getLast10(contactNum);
    if (userMap.has(contactLast10)) {
      matched.push(userMap.get(contactLast10));
    }
  });

  // Remove duplicates from matches
  const uniqueMatched = [...new Map(matched.map(item => [item.id, item])).values()];

  console.log(`Fast Sync: Scanned ${contacts.length}, Matched ${uniqueMatched.length}`);
  res.json({ matched_users: uniqueMatched });
});


//=========== FIND SINGLE USER =========
app.post("/find-user", (req, res) => {
  const { contacts } = req.body; 

  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ error: "No contact provided" });
  }

  const searchNumber = scrub(contacts[0]);
  const foundUser = users.find(u => u.phoneNumber === searchNumber);

  if (!foundUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Returning in matched_users array to keep Flutter parsing consistent
  res.json({ matched_users: [foundUser] }); 
});

// ======== EMAIL UPDATES ============

app.put("/update-email", authenticate, (req, res) => {
  const { newEmail } = req.body;

  const user = users.find(u => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  user.email = newEmail;

  res.json({ message: "Email updated successfully" });
});
//=========== PASSWORD UPDATE =========
app.put("/update-password", authenticate, (req, res) => {
  const { newPassword } = req.body;

  const user = users.find(u => u.id === req.user.id);
  
  if(!passSecurityChecker){
      return res.status(400).json({ error: "Password must contain uppercase, lowercase, number and special character"});
  }

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  user.password = newPassword;

  res.json({ message: "Password updated successfully" });
});

// ================= GROUP MANAGEMENT =================

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

// ================= WEBSOCKET LOGIC =================

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("WS Client connected");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // REGISTER USER SOCKET
      if (msg.type === "register") {
        userSockets[msg.from] = ws;
        console.log("Socket Registered for:", msg.from);
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
      console.log("WS Error:", err);
    }
  });

  ws.on("close", () => {
    for (let key in userSockets) {
      if (userSockets[key] === ws) {
        delete userSockets[key];
        break;
      }
    }
    console.log("WS Client disconnected");
  });
});

