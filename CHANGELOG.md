# Changelog

All notable changes to Skiff will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release
- Vault encryption with AES-256-GCM + argon2id
- In-browser terminal via xterm.js over WebSocket
- SSH config import/export
- Folder organization with nested folders
- Star favorites
- Dark/light theme toggle
- Master password change (re-encrypts all credentials)
- Idle timeout auto-lock
- SSH fingerprint pinning
- Search hosts by label, hostname, or username
- Docker deployment with docker-compose
- Comprehensive documentation

### Security
- Credentials encrypted at rest with AES-256-GCM
- Master password hashed with argon2id (OWASP parameters)
- Vault key stored in memory only, never touches disk
- Rate-limited unlock attempts (5 failures → 5 min lockout)
- HTTP-only session cookies with SameSite=Lax
- Helmet security headers
- Global rate limiting

## [0.1.0] - 2024-05-22

### Added
- Initial release
