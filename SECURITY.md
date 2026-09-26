# Security

Skiff stores SSH credentials — passwords and private keys. That's about as sensitive as data gets, so this document explains exactly how Skiff protects it, what it does and doesn't guarantee, and how to report a problem.

## Reporting a vulnerability

If you find a security issue, please email **skiffsshmanager@gmail.com** rather than opening a public issue. Include enough detail to reproduce it. I'll acknowledge as quickly as I can and keep you posted on a fix. Please give me a reasonable window to patch before disclosing publicly.

This is a solo open-source project, not a company with a security team — but I take credential safety seriously and will treat any report with priority.

## The threat model

Skiff is designed to protect your credentials against:

- **Theft of the database file.** If someone copies `skiff.sqlite`, they get ciphertext, not credentials. Decrypting it requires a password that is never stored.
- **A passive look at the disk.** Credentials are encrypted at rest; the encryption key only ever exists in server memory while a vault is unlocked.
- **Casual network interception**, *when deployed correctly* (behind HTTPS — see Deployment).

It does **not** protect against:

- A compromised server while the vault is unlocked. If an attacker has root on the running host, they can read process memory, where the key lives while unlocked. No server-side tool fully solves this; Skiff doesn't claim to.
- A malicious admin in team mode. Admins can reset other members' passwords (that's the recovery mechanism), which means a rogue admin can take over accounts. Trust your admins.
- Forgotten passwords. There is no recovery backdoor. See below.
- Someone at an unlocked browser. Locking the vault ends the *browser's* access, but — by design — not your running SSH sessions (see "Live SSH sessions" below).

## Personal mode — how encryption works

The default mode: one master password, one user.

```
master password --argon2id--> 32-byte vault key  (memory only, never stored)
vault key --AES-256-GCM--> each credential, stored as (nonce, ciphertext)
```

- The **master password** is run through **argon2id** (OWASP-recommended parameters) with a per-vault random salt to derive a 32-byte **vault key**.
- That vault key encrypts each credential individually with **AES-256-GCM**, a standard authenticated cipher. Each credential gets a fresh random nonce; the GCM auth tag means tampering is detected on decrypt.
- The password itself is **never stored**. What's stored is an **HMAC verifier** — a keyed hash of the vault key. On unlock, Skiff derives the key from your input, computes the verifier, and compares it to the stored one. A match means the password was right, without the server ever holding the password or being able to reverse the verifier.
- While unlocked, the vault key sits in server memory only, keyed to your session. It is zeroed on lock and on idle timeout, and is never written to disk. Each request works on its own copy of the key, which is zeroed when the response is sent — so locking mid-request can't leave a half-finished operation using a wiped key.

**Encrypted:** SSH passwords, private keys, key passphrases.
**Not encrypted:** labels, hostnames, ports, usernames, folder names, tags. These are metadata, not secrets — keeping them in plaintext is what makes search and listing fast. If your *hostnames* are themselves sensitive, be aware of this.
**Not encrypted — session recordings.** When recording is on, everything a session prints is written to `data/recordings/*.cast` in plain text. That includes anything displayed on screen: file contents you `cat`, tokens a command prints, and so on (not passwords typed at a hidden prompt, since those aren't echoed). Treat the recordings directory as sensitive, include it in your backup thinking, and turn recording off if that trade-off is wrong for you.

## Team mode — how encryption works

Team mode lets several people share one vault, each with their own login, without anyone's password being shared.

```
one random 32-byte SHARED KEY --AES-256-GCM--> every credential
each user's password --argon2id--> their key-encrypting key (KEK)
SHARED KEY --AES-256-GCM(user's KEK)--> stored once per user
```

The design:

- There is exactly **one shared key** that encrypts all credentials — just like the personal vault key, so credentials are encrypted once, not per-user.
- Each user has their **own copy of the shared key**, sealed (encrypted) with a KEK derived from *their* password via argon2id. Two users with different passwords therefore have different sealed blobs, but both unseal to the same shared key.
- **Logging in** derives the user's KEK from their password, verifies it against that user's stored HMAC verifier, and unseals the shared key into memory for that session. A wrong password fails the GCM authentication — it's a cryptographic rejection, not just a UI check.
- **Adding a member**: an admin's session already holds the shared key unsealed, so it seals a fresh copy to the new member's temporary password. The admin never learns the member's eventual password.
- **Resetting a member** (the "forgot password" path): an admin re-seals the shared key to a new temporary password. The member's logins are ended **and their live SSH sessions are closed** — a reset usually means the account may be compromised. No data is lost, because credentials are encrypted with the shared key — not with any individual's password.
- **Temporary passwords.** Passwords an admin sets (new member, reset) are 16 random characters and flagged as temporary; the member is prompted to choose their own, which re-seals only their copy of the shared key. Changing it signs out the member's other browsers.
- **Disabling a member** ends their logins, **closes their live SSH sessions**, and blocks login. Skiff refuses to disable the last remaining admin, so a team can't lock itself out of administration.
- **Vault-wide settings are admin-only**: session recording, idle timeout, vault backups, deleting recordings, and resetting a server's pinned host key. A member can't switch recording off before doing something, or erase a recording afterwards.

What this design deliberately does **not** provide: per-user or per-host access control. Every member can decrypt every credential in the shared vault. Team mode is "a shared vault with individual accountability and an audit log," not fine-grained RBAC. If you need to restrict which member can see which host, Skiff's open-source team mode is not the right tool.

### Audit log

In team mode, privileged actions are recorded to an audit table: logins, failed logins (with the username tried), logouts, host connections (which user connected to which host, as which SSH user), host/folder/user changes, imports, password changes and resets, settings changes (recording on/off, idle timeout), vault backups, deleted recordings, and host-key resets. The log never contains secrets — only metadata like labels, usernames, and IP addresses. Admins review it from the Admin panel. It's stored in the same SQLite database, consistent with the zero-cloud model.

## Personal -> Team upgrade

Upgrading a personal vault to team mode is designed to be safe and lossless:

- Your existing **vault key becomes the shared key**. Because credentials were already encrypted with it, **nothing is re-encrypted** — there's no bulk migration that could corrupt data.
- Your account becomes the first admin; the existing vault key is sealed to your existing password as that admin's key copy.
- The upgrade is **one-way** and requires confirming your current master password. Export a backup first if you want a rollback point.

## Live SSH sessions

SSH sessions run on the server, not in the browser — that's what lets them survive a closed tab or a sleeping laptop. A session belongs to a *person* (the vault owner in personal mode, each member in team mode), not to a browser login.

- **Locking the vault or an idle timeout detaches** every browser attached through that login, but the SSH session keeps running. Signing back in — from any browser — reattaches to it. A session nobody is attached to is closed after 30 minutes.
- **Only an explicit "Disconnect"**, the remote shell exiting, an admin disabling/resetting the member, or a server restart ends a session.
- One window shows a session at a time; only that window can type into it.
- Each person can hold at most `SKIFF_MAX_SESSIONS_PER_USER` sessions (default 20).
- Terminal connections are only accepted from Skiff's own web origin.

## Host key verification

The first connection to a server shows its SHA-256 host key fingerprint — the same value `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the server — and asks you to confirm it. After that the key is pinned, and a different key is refused. If a server was legitimately rebuilt, the vault owner (or a team admin) can forget the pinned key from the warning screen; this is audited.

## Backups

A backup (Settings → Backup) contains the encrypted credentials, the KDF parameters and verifier, and — for team vaults — every member's sealed copy of the shared key. Nothing in it is readable without a password. It restores only onto a fresh instance: personal backups unlock with the original master password, team backups let every member sign in with their own. Recordings are not included.

## Forgotten passwords

There is no recovery backdoor, by design.

- **Personal mode:** if you forget your master password, your credentials are unrecoverable. This is the point — a recovery mechanism would be a backdoor.
- **Team mode:** an admin can reset *another* member's password (re-sealing the shared key to a new one). But if *every* admin loses their password, the vault is unrecoverable. Keep more than one admin, and keep an encrypted backup.

## Deployment hardening

Skiff is only as safe as how you run it:

- **Always put it behind HTTPS** in production (nginx or Caddy as a TLS-terminating reverse proxy). Session cookies are marked `Secure` in production, so browsers only keep them over HTTPS (localhost excepted); opened over plain HTTP from another machine, Skiff refuses to sign in and says why rather than looping. `SKIFF_INSECURE_HTTP=true` allows plain HTTP — only on a network you trust.
- **Tell Skiff which proxy to trust** with `SKIFF_TRUST_PROXY` (the proxy's IP or CIDR). Without it every client appears to come from the proxy: one shared sign-in backoff and rate limit for everyone, and the proxy's IP in the audit log. Don't set it to `true` unless nothing but the proxy can reach Skiff — anyone could then fake their IP.
- **Bound to localhost by default.** Outside Docker the server listens on `127.0.0.1` unless `SKIFF_HOST` says otherwise; the provided `docker-compose.yml` publishes the port on `127.0.0.1` unless you set `HOST_ADDR`.
- **Setup token.** Before a vault exists, setup and restore require a one-time token that the server prints to its own log (`docker compose logs skiff | grep "Setup token"`), or that you pin with `SKIFF_SETUP_TOKEN`. Reading the server's log proves you operate it, so nobody else who reaches a fresh instance can claim it.
- **Password guessing** is slowed per client: after 5 wrong attempts, each further attempt from the same address must wait, doubling up to 15 minutes. A correct password resets it. Someone guessing from elsewhere never locks you out.
- **Set `SKIFF_COOKIE_SECRET`** to a long random value (`openssl rand -hex 32`). The cookie layer requires it; session IDs themselves are 256-bit random values that exist only in server memory.
- **Content-Security-Policy.** The web UI loads nothing from third parties (fonts and the recordings player are bundled) and is served with a strict CSP: only Skiff's own scripts run, and the page can't be framed by another site.
- **Back up `./data/`.** That's where the encrypted vault lives. The backup is still encrypted — but if you lose both the data and the password, there's no recovery.
- **Protect the host.** Anyone with root on the server can read the unlocked key from memory. Standard server hygiene applies.

## Cryptographic primitives, summarized

| Purpose | Primitive |
|---|---|
| Password to key derivation | argon2id (per-vault / per-user salt) |
| Credential encryption | AES-256-GCM (random nonce per credential) |
| Shared-key sealing (team mode) | AES-256-GCM under a password-derived KEK |
| Password verification | HMAC-SHA-256 verifier (no password stored) |
| Session key storage | in-memory only, zeroed on lock/idle; per-request copies zeroed after each response |
| Verifier comparison | constant-time |
| Host key fingerprint | SHA-256 of the host key (OpenSSH format) |

No credential, password, or key is ever written to disk in plaintext.
