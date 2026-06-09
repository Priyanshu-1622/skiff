# Contributing to Skiff

Thanks for your interest in Skiff. It's a self-hosted SSH connection manager, maintained primarily by one person, and contributions are genuinely welcome — bug reports, fixes, features, docs, all of it. This guide explains how to get set up and what to keep in mind so your contribution lands smoothly.

## Before you start

**For anything bigger than a small fix, open an issue first.** It's much easier to agree on an approach before code exists than to rework a finished PR. This is especially true for features — Skiff has a deliberate scope (see the "What Skiff doesn't do" section in the README), and a feature that doesn't fit is a frustrating thing to find out about after you've built it.

Bug reports are always useful. A good one includes what you did, what you expected, what happened, and your environment (OS, Node version, Docker or dev). If it's a security issue, **don't** open a public issue — see [SECURITY.md](./SECURITY.md).

## Project layout

Skiff is a pnpm monorepo with two apps and one shared package:

```
apps/web        React + Vite frontend
apps/api        Fastify + better-sqlite3 backend
packages/shared TypeScript types shared by both
```

The frontend and backend are decoupled — the web app talks to the API over HTTP and WebSocket, with no direct imports between them. The only thing they share is the types in `packages/shared`.

## Getting set up

You'll need **Node 20+** and **pnpm 9+**.

```bash
git clone https://github.com/Priyanshu-1622/skiff.git
cd skiff
pnpm install
pnpm dev
```

`pnpm dev` runs the API and the Vite dev server together. Open http://localhost:5173. On first load you'll set up a vault.

**Windows note:** `better-sqlite3` and `argon2` are native modules and compile from source. You need Visual Studio Build Tools with "Desktop development with C++". See the Troubleshooting section in the README if `pnpm install` fails to build them.

### Building

```bash
pnpm build
```

This builds the shared package first, then the API, then the web app, in that order (the order matters — the others depend on `@skiff/shared` being compiled). If you change types in `packages/shared`, rebuild it before the consumers will see the changes.

## Code standards

- **TypeScript strict mode is on.** Please keep it on. If you're fighting the types, that's usually the design telling you something — reach for `unknown` and narrowing before `any`.
- **Format with Prettier** before committing.
- **Match the existing style.** The codebase favors clear, direct code over cleverness, prose comments only where the *why* isn't obvious (not the *what*), and minimal abstraction. New code should look like it belongs.
- **Frontend:** components live in `apps/web/src/routes` and `apps/web/src/components`. Styling is plain CSS with design tokens (`apps/web/src/styles/tokens.css`) — no Tailwind, no CSS-in-JS. Reuse the tokens; don't hardcode colors.
- **Backend:** routes are thin; crypto lives in `apps/api/src/crypto`; shared helpers in `apps/api/src/lib`. Every route that touches credentials goes through the session/vault-key plumbing — don't bypass it.

## Working with security-sensitive code

Skiff's whole job is protecting credentials, so changes to anything under `apps/api/src/crypto`, the auth routes, or the session store get extra scrutiny. If your change touches encryption, key handling, authentication, or the team-mode shared-key logic:

- Explain the security reasoning in the PR description.
- Don't introduce a way for a credential, password, or key to be written to disk unencrypted, logged, or sent to the client.
- The audit log must never contain secrets — only metadata.
- If you're unsure whether something is safe, ask in the issue before building it.

When in doubt, read [SECURITY.md](./SECURITY.md) — it describes the intended model, and contributions shouldn't quietly weaken it.

## Commits and pull requests

- **Commit messages:** be specific enough that `git log --oneline` reads like a changelog. A `type: summary` style (e.g. `fix: terminal resize race`, `feat: team audit log`) is appreciated but not enforced.
- **Keep PRs focused.** One logical change per PR is far easier to review than a grab-bag. If you find yourself writing "and also…" in the description, consider splitting it.
- **Make sure it builds and type-checks** (`pnpm build`) before opening the PR.
- **Reference the issue** your PR addresses.

## A note on scope

Skiff intentionally does a small set of things well rather than everything. Some requests — full RBAC, SFTP, SSO, bastion chains — are explicitly out of scope for the open-source project. That's not a judgment on the idea; it's about keeping the project maintainable by a small team. If you're not sure whether something fits, the issue thread is the place to find out.

## License

By contributing, you agree that your contributions are licensed under the project's **AGPL-3.0** license, the same terms as the rest of Skiff.
