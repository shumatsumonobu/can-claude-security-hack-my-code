const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { exec } = require("child_process");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "application/xml" }));

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    email TEXT,
    role TEXT DEFAULT 'user'
  );
  INSERT INTO users (username, password, email, role) VALUES
    ('admin', 'admin123', 'admin@example.com', 'admin'),
    ('alice', 'password', 'alice@example.com', 'user'),
    ('bob', 'letmein', 'bob@example.com', 'user');
`);

const JWT_SECRET = "super-secret-key-12345";
const API_KEY = "my-api-key-do-not-use-in-production";
const DB_PASSWORD = "production_db_p@ssw0rd!";

// ================================================
// Category 1: Injection — SQL Injection
// ================================================
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
  try {
    const user = db.prepare(query).get();
    if (user) {
      res.json({ message: "Login successful", user });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// Category 2: Injection — Command Injection
// ================================================
app.get("/api/ping", (req, res) => {
  const { host } = req.query;
  exec(`ping -c 3 ${host}`, (err, stdout, stderr) => {
    if (err) {
      res.status(500).json({ error: stderr });
    } else {
      res.json({ result: stdout });
    }
  });
});

// ================================================
// Category 3: Injection — XSS (Reflected)
// ================================================
app.get("/search", (req, res) => {
  const { q } = req.query;
  res.send(`
    <html>
      <body>
        <h1>Search Results</h1>
        <p>You searched for: ${q}</p>
        <form action="/search" method="GET">
          <input type="text" name="q" />
          <button type="submit">Search</button>
        </form>
      </body>
    </html>
  `);
});

// ================================================
// Category 4: ReDoS (Regular Expression DoS)
// ================================================
app.post("/api/validate-email", (req, res) => {
  const { email } = req.body;
  const emailRegex = /^([a-zA-Z0-9_\.\-])+\@(([a-zA-Z0-9\-])+\.)+([a-zA-Z]{2,4})+$/;
  if (emailRegex.test(email)) {
    res.json({ valid: true });
  } else {
    res.json({ valid: false });
  }
});

// ================================================
// Category 5: Path / Network — Path Traversal
// ================================================
app.get("/api/files", (req, res) => {
  const { filename } = req.query;
  const filePath = path.join(__dirname, "uploads", filename);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    res.send(content);
  } catch (err) {
    res.status(404).json({ error: "File not found" });
  }
});

// ================================================
// Category 5: Path / Network — SSRF
// ================================================
app.get("/api/fetch", (req, res) => {
  const { url } = req.query;
  http.get(url, (proxyRes) => {
    let data = "";
    proxyRes.on("data", (chunk) => (data += chunk));
    proxyRes.on("end", () => res.send(data));
  }).on("error", (err) => {
    res.status(500).json({ error: err.message });
  });
});

// ================================================
// Category 6: Auth / Access Control — Auth Bypass
// ================================================
app.get("/api/admin/users", (req, res) => {
  const { role } = req.query;
  if (role === "admin") {
    const users = db.prepare("SELECT * FROM users").all();
    res.json(users);
  } else {
    res.status(403).json({ error: "Forbidden" });
  }
});

// ================================================
// Category 6: Auth / Access Control — IDOR
// ================================================
app.get("/api/users/:id", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (user) {
    res.json(user);
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// ================================================
// Category 6: Auth / Access Control — No CSRF Protection
// ================================================
app.post("/api/users/:id/delete", (req, res) => {
  const { id } = req.params;
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ message: "User deleted" });
});

// ================================================
// Category 7: Cryptography — Weak Hash + Hardcoded Secrets
// ================================================
app.post("/api/register", (req, res) => {
  const { username, password, email } = req.body;
  const hashedPassword = crypto.createHash("md5").update(password).digest("hex");
  try {
    db.prepare("INSERT INTO users (username, password, email) VALUES (?, ?, ?)").run(
      username,
      hashedPassword,
      email
    );
    res.json({ message: "User registered" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ================================================
// Category 8: Deserialization — Unsafe eval
// ================================================
app.post("/api/compute", (req, res) => {
  const { expression } = req.body;
  try {
    const result = eval(expression);
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ================================================
// Category 9: Protocol / Encoding — Missing Security Headers
// ================================================
app.get("/api/debug", (req, res) => {
  res.json({
    dbPassword: DB_PASSWORD,
    apiKey: API_KEY,
    jwtSecret: JWT_SECRET,
    nodeVersion: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    uptime: process.uptime(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
