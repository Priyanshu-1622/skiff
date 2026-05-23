# Skiff

**Self-hosted SSH connection manager. Open-source alternative to Termius.**

Store SSH hosts, organize them in folders, manage credentials safely, and launch live in-browser terminal sessions. Everything runs on your server — your keys never leave your infrastructure.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)

---

## Features

-  **Vault encryption** — AES-256-GCM + argon2id, credentials encrypted at rest
-  **In-browser terminal** — xterm.js over WebSocket, no SSH client needed
-  **Folder organization** — nested folders, starred favorites, full-text search
-  **SSH config import** — paste `~/.ssh/config`, import all hosts in one click
-  **Password manager** — change master password, re-encrypts all credentials in transaction
-  **Dark/light theme** — design tokens from Claude Design, persists preference
-  **SSH fingerprint pinning** — MITM protection, saves on first connect
-  **Auto-lock** — configurable idle timeout (default 15 min)
-  **Single-command deploy** — Docker Compose, one container, SQLite
-  **No telemetry** — zero external network calls except your SSH targets

##  Use Cases

- Manage SSH access to your infrastructure from a web UI
- Share SSH host inventory across your team (export/import vault backups)
- Access servers from any device with a browser (no SSH client needed)
- Organize hundreds of hosts in folders (production, staging, clients, etc.)
- Self-host an alternative to Termius, Royal TSX, or SecureCRT

---

## Quick Start

### Prerequisites

| Tool | Version | Installation |
|------|---------|--------------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| **pnpm** | 9+ | `npm install -g pnpm@9` |

### Development

```bash
# 1. Clone the repository
git clone https://github.com/Priyanshu-1622/skiff.git
cd skiff

# 2. Install dependencies (~30 seconds)
pnpm install

# 3. Start dev servers (web + api)
pnpm dev
```

Open **http://localhost:5173** → create your master password → start adding hosts!

### Production (Docker)

```bash
# 1. Create environment file
cp .env.example .env

# 2. Generate a secure cookie secret
openssl rand -hex 32
# Add it to .env as SKIFF_COOKIE_SECRET=...

# 3. Start the container
docker compose up -d --build

# 4. Access at http://localhost:8080
```

**Important:** Back up the `./data/` directory regularly — it contains your encrypted vault.

---

## Documentation

### First Time Setup

1. Open Skiff in your browser
2. **Create master password** screen appears
3. Choose a strong password (it encrypts all your SSH credentials)
4. Click "Create vault"
5. You're in! Add hosts manually or import from `~/.ssh/config`

### Adding Hosts

**Manually:**
1. Click "+ Add host"
2. Fill in: label, hostname, port (22), username
3. Choose auth: Password or Private Key
4. Optionally paste your SSH password or private key
5. Click "Save host"

**From SSH config:**
1. Click Settings → Import
2. Paste your `~/.ssh/config` contents
3. Click "Parse config" → review hosts
4. Click "Import all" → done!

### Connecting to Hosts

1. Click "Connect" on any host row
2. Terminal opens in full-screen
3. On first connect: SSH fingerprint is saved
4. Type commands as normal
5. `Ctrl+Shift+W` or click "Disconnect" to close

### Organizing Hosts

- **Folders:** Click "+" next to "FOLDERS" → create nested folders
- **Star favorites:** Click ★ on any host → appears in "Favorites"
- **Search:** Type in the search bar (searches label, hostname, username)
- **Delete folder:** Hover over folder → × button appears

### Security Settings

**Change master password:**
1. Settings → Security
2. Enter current password + new password
3. Click "Change password" → all credentials re-encrypted

**Auto-lock timeout:**
1. Settings → Security → Idle timeout
2. Set minutes (1-1440)
3. Click "Save" → vault locks after inactivity

**Backup vault:**
1. Settings → Backup
2. Click "Download backup"
3. Stores encrypted vault as JSON (can be restored later)

---

## Architecture

### Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18 + TypeScript + Vite |
| **Routing** | TanStack Router v7 |
| **State** | Zustand + TanStack Query |
| **Styling** | Vanilla CSS with design tokens |
| **Terminal** | xterm.js + FitAddon + WebLinksAddon |
| **Backend** | Node.js 20 + Fastify |
| **Database** | better-sqlite3 (WAL mode) |
| **SSH** | ssh2 library |
| **Crypto** | Node.js crypto (AES-256-GCM) + argon2 |

### Project Structure

```
skiff/
├── apps/
│   ├── web/                    # React frontend
│   │   ├── src/
│   │   │   ├── components/     # Shell, icons, primitives
│   │   │   ├── routes/         # Pages: unlock, dashboard, terminal, settings
│   │   │   ├── lib/            # API client, vault store, theme, WebSocket
│   │   │   └── styles/         # Design tokens + screen-level CSS
│   │   └── vite.config.ts
│   └── api/                    # Fastify backend
│       ├── src/
│       │   ├── crypto/         # vault.ts (AES-256-GCM), session-store.ts
│       │   ├── routes/         # auth, hosts, folders, terminal, import, settings
│       │   ├── db/             # SQLite schema, client
│       │   └── lib/            # Auth middleware, helpers
│       └── server.ts
├── packages/
│   └── shared/                 # Types shared between frontend + backend
├── Dockerfile                  # Multi-stage production build
├── docker-compose.yml          # One-command production deploy
└── README.md                   # This file
```

### Security Model

**Encryption flow:**
1. Master password → argon2id KDF (OWASP params: 3 iterations, 64 MiB memory, parallelism 4) → 32-byte vault key
2. Vault key → compute HMAC verifier → store in DB (used to validate password without decrypting)
3. Each credential → AES-256-GCM(plaintext, vault_key) → store {nonce, ciphertext} in DB
4. On unlock → derive vault key from password → verify against HMAC → key stored in process memory only
5. On lock / idle timeout → zero vault key → session destroyed

**What's encrypted:**
- SSH passwords
- SSH private keys
- Private key passphrases

**What's NOT encrypted (no sensitive data):**
- Host labels, hostnames, ports, usernames
- Folder names
- SSH fingerprints

**Session management:**
- Vault key stored in-memory only (never touches disk)
- HTTP-only cookies (SameSite=Lax, Secure in production)
- Auto-lock after configurable idle timeout
- All sessions destroyed on master password change

**Rate limiting:**
- Global: 300 requests/minute
- Unlock attempts: 5 failures → 5 minute lockout
- Failed unlock attempts logged to DB

---

## Development

### Setup

```bash
# Install all dependencies
pnpm install

# Start dev servers (web + api in parallel)
pnpm dev

# Or start individually:
pnpm dev:web    # Frontend only (port 5173)
pnpm dev:api    # Backend only (port 8080)
```

### Commands

```bash
pnpm dev            # Start both servers
pnpm build          # Build all packages for production
pnpm typecheck      # TypeScript check (all packages)
pnpm test           # Run tests
pnpm clean          # Remove all node_modules and build artifacts
```

### Database Location

**Development:** `apps/api/data/skiff.sqlite`  
**Docker:** `/app/data/skiff.sqlite` (mounted to `./data/` on host)

To inspect the database:
```bash
sqlite3 apps/api/data/skiff.sqlite
.tables
SELECT * FROM hosts;
```

### Environment Variables

See `.env.example` for all options:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `production` or `development` |
| `SKIFF_PORT` | `8080` | API server port |
| `SKIFF_HOST` | `0.0.0.0` | API server bind address |
| `SKIFF_COOKIE_SECRET` | (random) | Session cookie signing secret (required in production) |
| `SKIFF_DB_PATH` | `./data/skiff.sqlite` | SQLite database file path |

---

## Docker

### Build

```bash
docker build -t skiff:latest .
```

### Run

```bash
docker run -d \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -e SKIFF_COOKIE_SECRET=$(openssl rand -hex 32) \
  --name skiff \
  skiff:latest
```

### Docker Compose (recommended)

```bash
# Start
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build
```

---

## Troubleshooting

### Port 8080 already in use

```bash
# Find what's using the port
lsof -i :8080

# Change the port in .env
SKIFF_PORT=3000
```

### better-sqlite3 won't compile

**Linux:**
```bash
sudo apt install python3 make g++
pnpm install
```

**macOS:**
```bash
xcode-select --install
pnpm install
```

**Windows:**
- Install [Node.js 20 LTS](https://nodejs.org/dist/v20.19.2/node-v20.19.2-x64.msi)
- Install [Visual Studio Build Tools](https://aka.ms/vs/17/release/vs_BuildTools.exe)
  - Select "Desktop development with C++"
- Restart terminal
- `pnpm install`

### "Cannot connect to API" on startup

Make sure both servers are running:
```bash
# Check if API is up
curl http://localhost:8080/api/health

# Should return: {"ok":true,"data":{"status":"ok",...}}
```

### Session expired / vault locked mid-session

The vault auto-locks after the configured idle timeout. This is a security feature. Just unlock again with your master password.

---

## Contributing

Contributions welcome! Please:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

### Code Style

- TypeScript strict mode enabled
- ESLint + Prettier (run `pnpm lint`)
- Conventional Commits preferred

### Testing

```bash
# Run all tests
pnpm test

# Run API tests only
pnpm --filter @skiff/api test
```

---

## License

**AGPL-3.0-only**

You can use, modify, and deploy Skiff freely. If you run a modified version as a network service (e.g., SaaS), you must share your source code under the same license.

See [LICENSE](./LICENSE) for full text.

---

## Acknowledgments

- Design system: [Claude Design](https://design.claude.ai)
- Terminal: [xterm.js](https://xtermjs.org/)
- SSH: [ssh2](https://github.com/mscdex/ssh2)
- Icons: Custom SVG set

---

## Support

- **Issues:** [GitHub Issues](https://github.com/Priyanshu-1622/skiff/issues)
- **Discussions:** [GitHub Discussions](https://github.com/Priyanshu-1622/skiff/discussions)

---

**Built by Priyanshu. Bug reports and PRs welcome.**
