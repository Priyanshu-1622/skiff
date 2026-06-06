# Security

Skiff stores SSH credentials, so I take this seriously even though it's an early project.

If you find a vulnerability, please email me at skiffsshmanager@gmail.com rather than opening a public issue. I'll get back to you as soon as I can.

A few notes if you're deploying it:
- Put it behind HTTPS (nginx or Caddy as a reverse proxy).
- By default it binds to localhost only — keep it that way unless you know what you're exposing.
- Back up your `data/` directory. The vault is encrypted, but if you lose it and forget your master password, there's no recovery.
