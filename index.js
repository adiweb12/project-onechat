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
let messages = [];
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
  
  if(!passSecurityChecker(newPassword)){
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

app.get("/messages", (req, res) => {
  const { user1, user2 } = req.query;

  if (!user1 || !user2) {
    return res.status(400).json({ error: "Missing users" });
  }

  const chat = messages.filter(
    m =>
      (m.from === user1 && m.to === user2) ||
      (m.from === user2 && m.to === user1)
  );

  // Sort latest first
  chat.sort((a, b) => new Date(b.time) - new Date(a.time));

  res.json(chat);
});

app.get("/chat-list/:phone", (req, res) => {
  const myPhone = req.params.phone;

  const chatMap = new Map();

  messages.forEach(m => {
    if (m.from === myPhone || m.to === myPhone) {
      const otherUser = m.from === myPhone ? m.to : m.from;

      if (!chatMap.has(otherUser)) {
        chatMap.set(otherUser, m);
      } else {
        const existing = chatMap.get(otherUser);

        // Keep latest message
        if (new Date(m.time) > new Date(existing.time)) {
          chatMap.set(otherUser, m);
        }
      }
    }
  });

  const chatList = [];

  chatMap.forEach((msg, user) => {
    chatList.push({
      id: user,
      receiverName: user, // you can replace with real name later
      receiverNum: user,
      lastMessage: msg.message,
      time: msg.time,
    });
  });

  // Sort latest chats first
  chatList.sort((a, b) => new Date(b.time) - new Date(a.time));

  res.json(chatList);
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
  try {
    const decoded = jwt.verify(msg.token, JWT_SECRET);
    const user = users.find(u => u.id === decoded.id);

    if (!user) return;

    userSockets[user.phoneNumber] = ws;
    console.log("Secure WS Registered:", user.phoneNumber);
  } catch (err) {
    console.log("Invalid token");
    ws.close();
  }
}

      // SEND MESSAGE
      if (msg.type === "message") {
  const newMsg = {
    id: msg.id || uuidv4(),
    from: msg.from,
    to: msg.to,
    message: msg.message,
    time: new Date().toISOString()
  };

  // ❗ prevent duplicate by id
  const exists = messages.find(m => m.id === newMsg.id);
  if (exists) return;

  messages.push(newMsg);

  const receiverSocket = userSockets[msg.to];

  if (receiverSocket) {
    receiverSocket.send(JSON.stringify(newMsg));
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

