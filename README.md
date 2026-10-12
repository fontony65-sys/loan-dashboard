# Loan Dashboard

A simple loan-tracking dashboard (borrowers, loans, repayments). Below: how to put it online for free using only an iPhone, then developer notes.

## Put it online — using only an iPhone

This guide is for someone who has never done this before. You only need your iPhone, Safari and an email address. It takes about 30–45 minutes. Everything here is **free**.

You will use three free websites:

| Website | What it does for you |
|---|---|
| **GitHub** (github.com) | Stores the app's files |
| **Turso** (turso.tech) | Stores your data (borrowers, loans, payments) safely |
| **Render** (render.com) | Runs the app and gives you a web address |

> 💡 Tip: keep the **Notes** app open. You will copy 3 secret values into it along the way (a database address, a token and your password). Don't share that note with anyone.

---

## Part 0 — Get the files ready on your iPhone (2 min)

1. Save **loan-dashboard.zip** to the **Files** app (for example, from email: tap the attachment → Share icon → **Save to Files** → **On My iPhone**).
2. Open the **Files** app, find `loan-dashboard.zip` and **tap it once**. iPhone unzips it into a folder called **loan-dashboard**.

> ⚠️ GitHub does **not** unzip files for you. If you upload the .zip itself, it won't work. Upload the unzipped files.

Inside the folder you'll see some files and 3 folders: **db**, **public** and **scripts**.

---

## Part 1 — GitHub: create an account and upload the files (15 min)

### 1a. Create the account
1. In Safari go to **github.com** → tap **Sign up**.
2. Enter your email, a password and a username. Do the puzzle check and enter the code GitHub emails you.
3. If asked about plans, choose **Free**.

### 1b. Create an empty project ("repository")
1. Tap the **+** at the top right (or your profile picture) → **New repository**.
2. **Repository name:** `loan-dashboard`
3. Choose **Private** (recommended — only you can see it).
4. Tick **Add a README file** (this makes the "Add file" button appear).
5. Tap **Create repository**.

> 🔎 If the page looks cramped or a button is missing, tap **aA** in the Safari address bar → **Request Desktop Website**. GitHub's upload page works best in desktop mode.

### 1c. Upload the main files
1. In your new repository tap **Add file** → **Upload files** → **choose your files**.
2. Tap **Browse** → open the **loan-dashboard** folder → tap **Select** (top right) → tap **every file** (not the folders) → **Open**.
   - Must include: `package.json`, `package-lock.json`, `server.js`, `lib.js`, `render.yaml`, `README.md` (replace the old one).
   - Don't worry if you don't see `.gitignore` or `.env.example`: they are optional.
3. Scroll down and tap **Commit changes**.

### 1d. Upload the 3 folders
On iPhone you **can't upload a whole folder** — only files. So for each folder you first make the folder on GitHub, then upload its files into it.

Do this for **public**:
1. Go back to the repository's main page → **Add file** → **Create new file**.
2. In the name box type exactly: `public/placeholder.txt` (when you type the `/`, GitHub turns `public` into a folder). Type anything (e.g. `x`) in the big box.
3. Tap **Commit changes…** → **Commit changes**.
4. You're now inside the **public** folder. Tap **Add file** → **Upload files** → choose all files from your iPhone's **loan-dashboard › public** folder (`index.html`, `manifest.webmanifest`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`) → **Commit changes**.

Repeat the same steps for:
- **scripts** → name: `scripts/placeholder.txt` → upload the files from **scripts**.
- **db** → name: `db/placeholder.txt` → upload `index.js`, `migrate.js`, `seed.js` from **db**.
- **db/migrations** → name: `db/migrations/placeholder.txt` → upload `001_init.sql` and `002_sessions.sql` from **db › migrations**.

✅ Check: the main page should show `db`, `public`, `scripts`, `package.json`, `server.js`, `render.yaml` … and `db/migrations` should contain two `.sql` files. (Placeholder files are harmless.)

---

## Part 2 — Turso: create the free database (5 min)

1. In Safari go to **turso.tech** → **Sign up** (or **Login**). The easiest way is **Continue with GitHub** (you're already logged in). No credit card is needed for the Free plan.
2. If asked, pick the **Free** plan and any name for your organization.
3. Tap **Create Database** (sometimes under **Databases → Create**).
   - Name: `loans`
   - Location: choose the one closest to you (e.g. Europe for Cameroon).
   - Tap **Create**.
4. Open the database. Copy its **URL** — it starts with `libsql://` and looks like `libsql://loans-yourname.aws-eu-west-1.turso.io`. Paste it into Notes as **TURSO_DATABASE_URL**.
5. On the same page, find **Create Token** / **Generate Token** (sometimes behind a **Connect** button).
   - Expiration: **Never** (otherwise the app stops working when it expires).
   - Access: **Read & Write** (full access).
   - Tap create, then **copy the long token** right away (it's shown only once). Paste it into Notes as **TURSO_AUTH_TOKEN**.

You don't need to create any tables — the app does that by itself the first time it starts.

---

## Part 3 — Render: put the app online (10 min)

1. In Safari go to **render.com** → **Get Started** → **GitHub** (sign in with GitHub). No credit card is needed for a free web service.
2. Tap **New** (top) → **Web Service**.
3. Connect GitHub: tap **GitHub** / **Configure account**, allow Render to access **only** the `loan-dashboard` repository, then come back and select it.
4. Fill in:
   - **Name:** `loan-dashboard` (this becomes part of your web address)
   - **Language/Runtime:** `Node`
   - **Branch:** `main`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
5. Under **Environment Variables** tap **Add Environment Variable** for each line:

   | Name (key) | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `ADMIN_PASSWORD` | a strong password you invent (save it in Notes!) |
   | `TURSO_DATABASE_URL` | the `libsql://…` address from Part 2 |
   | `TURSO_AUTH_TOKEN` | the long token from Part 2 |
   | `CURRENCY` | `XAF` (optional) |

   Optional: `SEED_EXAMPLE_DATA` = `true` fills the app with fake example data so you can try it. Remove it (or set `false`) before using real data.

6. Tap **Deploy Web Service** (or **Create Web Service**). Wait 2–5 minutes. When the log shows **Your service is live** / **Loan dashboard on port …**, it's ready.

> If it fails with "ADMIN_PASSWORD must be set", go to **Environment** and add it, then **Manual Deploy → Deploy latest commit**.

---

## Part 4 — Open it and add it to your Home Screen (2 min)

1. At the top of the Render page, tap your web address (like `https://loan-dashboard-xxxx.onrender.com`).
2. Sign in: username **admin**, password = your `ADMIN_PASSWORD`.
3. Tap the **Share** button (square with an arrow) → **Add to Home Screen** → **Add**.

You now have a **Loans** icon on your Home Screen that opens the app full-screen. 🎉

---

## Good to know

- **First open can be slow (about 1 minute).** The free Render plan "sleeps" after 15 minutes without visitors and wakes up on the next visit. Your data is safe — it's in Turso, not on Render.
- **Forgot your password?** Change `ADMIN_PASSWORD` in Render → your service → **Environment**, then save (Render restarts the app).
- **Too many wrong passwords** locks sign-in for 15 minutes (protection against guessing).
- **Never** put your token or password in a GitHub file. They belong only in Render's Environment settings.
- To update the app later: upload the changed files to GitHub the same way; Render redeploys automatically.

## Free plan facts (checked October 2026)

- **Render Free web service:** no payment required; spins down after 15 min idle and takes ~1 min to wake; 750 free instance hours per month; the local disk is wiped on restart/redeploy (that's why the data lives in Turso). Sources: <https://render.com/docs/free>, <https://render.com/docs/your-first-deploy>, <https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026>
- **Turso Free plan:** $0/month, "no credit card required"; 100 databases, 5 GB storage, 500 million rows read and 10 million rows written per month. Source: <https://turso.tech/pricing>
- **GitHub web upload:** max 100 files per upload and 25 MiB per file; upload doesn't unzip archives. Source: <https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository>

Button names on these websites change from time to time; if one doesn't match exactly, look for the closest wording.


---

# For developers

Node 20 · Express · `@libsql/client` (Turso / libSQL) · Chart.js. Single admin login.

## Run locally
```bash
npm install
npm start            # http://localhost:3000  (admin / admin123 when NODE_ENV is not production)
```
With no `TURSO_DATABASE_URL`, data is stored in `db/loans.db` (`file:` mode). Migrations in `db/migrations/*.sql` run automatically at startup.
Example data is seeded on an empty DB in development; in production only when `SEED_EXAMPLE_DATA=true`.
`.env` is loaded automatically if present (see `.env.example`).

## Environment variables
| Var | Purpose |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Turso database; unset → `file:db/loans.db` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Login. `ADMIN_PASSWORD` is **required** when `NODE_ENV=production` (server exits otherwise) |
| `NODE_ENV=production` | Secure cookies, no default password, no example seeding |
| `SEED_EXAMPLE_DATA` | `true`/`false` overrides the seeding default |
| `PORT` | Listen port (Render sets it) · `CURRENCY` default `XAF` · `LOGIN_MAX_ATTEMPTS` default 10 per 15 min per IP |

## Scripts
- `npm run migrate` / `npm run seed [-- --force]`
- `scripts/verify.sh [base_url]` – API checks against a running server + production-mode checks (temporary servers on ports 3911–3913)
- `npm run screenshot` / `npm run screenshot:mobile` (needs Chrome)

## Notes
- Sessions are stored (SHA-256 hashed) in the `sessions` table, so logins survive restarts; cookie is `HttpOnly; SameSite=Lax` (+`Secure` in production). `trust proxy` is set for Render.
- `render.yaml` is a Render Blueprint alternative to the manual setup above (secrets are `sync: false`, you'll be prompted for them).
