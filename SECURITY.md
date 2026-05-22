# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: `security@yourdomain.com` (replace with your actual security contact)

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive a response within 48 hours. If the issue is confirmed, we will:
1. Work on a fix
2. Release a patch as soon as possible
3. Credit you in the release notes (unless you prefer to remain anonymous)

## Security Best Practices

When deploying Skiff:

1. **Use HTTPS** in production (configure a reverse proxy like nginx or Caddy)
2. **Set a strong cookie secret** (`openssl rand -hex 32`)
3. **Regular backups** of the `./data/` directory
4. **Keep updated** — watch for security releases
5. **Firewall** — restrict access to port 8080 (run behind reverse proxy)
6. **Change master password** regularly
7. **Enable auto-lock** with a reasonable timeout (15-30 min)
8. **Monitor unlock attempts** — check SQLite `unlock_attempts` table for suspicious activity

## Encryption Details

### Credentials
- Algorithm: AES-256-GCM (authenticated encryption)
- Key derivation: argon2id
  - Iterations: 3
  - Memory: 64 MiB
  - Parallelism: 4
  - Salt: 16 random bytes per vault
- Each credential has a unique 12-byte random nonce
- Ciphertext includes authentication tag

### Master Password
- Never stored in any form
- Hashed with argon2id to derive vault key
- HMAC verifier stored in DB (used to validate password without decrypting)

### Session Management
- Vault key stored in process memory only
- Zeroed on lock/timeout
- HTTP-only cookies (SameSite=Lax, Secure in production)
- No persistent storage of vault key

## Known Limitations

1. **Single-user vault** — no multi-tenancy in v0.1
2. **No HSM support** — vault key is in process memory, not hardware
3. **SQLite only** — no PostgreSQL/MySQL option yet
4. **No audit log** — actions aren't logged (planned for future)

## Dependency Security

All dependencies are regularly scanned for vulnerabilities. To check:

```bash
pnpm audit
```

Critical vulnerabilities are patched immediately.
