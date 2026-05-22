# Skiff — Project Rules for Claude

This file helps Claude Code maintain consistency across coding sessions.

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite + TanStack Router v7 + TanStack Query + Zustand
- **Backend:** Fastify + better-sqlite3 + ssh2 + argon2
- **Styling:** Vanilla CSS with design tokens (from Claude Design)
- **Terminal:** xterm.js with FitAddon and WebLinksAddon
- **Crypto:** Node.js crypto (AES-256-GCM) + argon2id KDF
- **License:** AGPL-3.0-only

## Project Structure

```
skiff/
├── apps/
│   ├── web/              # React frontend (Vite)
│   └── api/              # Fastify backend
├── packages/
│   └── shared/           # Shared TypeScript types
├── .github/              # Issue templates, PR template
└── docs/                 # Deployment guide
```

## Key Decisions

1. **No Tailwind** — Use the exact CSS class names from the Claude Design handoff in `apps/web/src/styles/`
2. **SQLite only** — better-sqlite3 in WAL mode, no PostgreSQL/MySQL
3. **Single-user vault** — no multi-tenancy in v0.1
4. **AES-256-GCM** — switched from libsodium to Node crypto (for Windows compatibility)
5. **HTTP-only cookies** — session management, SameSite=Lax
6. **argon2id KDF** — OWASP params: 3 iter, 64 MiB memory, parallelism 4

## Code Style Rules

- TypeScript strict mode enabled everywhere
- Prefer `const` over `let`
- Explicit return types on exported functions
- No `any` unless absolutely necessary
- Use Zod for runtime validation
- Error handling: try-catch in route handlers, error boundaries in React
- Comments for non-obvious logic only

## CSS Rules

- Use exact class names from Design CSS files (no BEM, no custom naming)
- All styles live in `apps/web/src/styles/`
- Import order: tokens.css → globals.css → shell.css → screen-level CSS
- No inline styles unless absolutely required for dynamic values
- Use CSS variables for all colors, spacing, radii

## API Routes

All routes in `apps/api/src/routes/`:
- Use `requireUnlocked` middleware for protected routes
- Return `ok(data)` or `err(code, message)` from `lib/response.ts`
- Zod schemas for request body validation
- Fastify catches async errors automatically

## Database

- Schema in `apps/api/src/db/schema.sql`
- better-sqlite3 in synchronous mode
- Transactions for multi-step operations
- Always use prepared statements (SQL injection safety)
- Foreign keys ON, cascading deletes where appropriate

## Security

- Credentials encrypted at rest (AES-256-GCM)
- Master password never stored, only HMAC verifier
- Vault key in memory only, zeroed on lock
- Rate limiting: global 300/min, unlock 5 failures/5min
- SSH fingerprint pinning (first-connect save)

## Common Tasks

### Add a new API route

1. Create in `apps/api/src/routes/`
2. Define Zod schemas for input
3. Register in `apps/api/src/app.ts`
4. Add `preHandler: auth` for protected routes

### Add a new page

1. Create in `apps/web/src/routes/`
2. Use `AppShell` or `BareShell` from `@/components/shell`
3. Add route to `router.tsx`
4. Create matching CSS file in `apps/web/src/styles/` if needed

### Debugging

- Frontend: `console.log` or React DevTools
- Backend: Fastify built-in logger (`req.log.info(...)`)
- Database: `sqlite3 apps/api/data/skiff.sqlite` in CLI

## Testing

- Run `pnpm typecheck` before committing
- Run `pnpm build` to verify production build
- Manual testing checklist:
  - Setup/unlock flow
  - Add/edit/delete hosts
  - Terminal connection
  - Import SSH config
  - Change password
  - Lock/unlock

## Never Do

- Don't use Tailwind CSS
- Don't store vault key in database
- Don't skip auth middleware on protected routes
- Don't use `any` types without a comment explaining why
- Don't modify design CSS files without re-importing from Claude Design
- Don't expose sensitive data in API responses (always decrypt server-side)

## Version

Current: **v0.1.0**
Last updated: 2024-05-22
