# Local AI (`emailai`)

A self-hosted AI chat assistant powered by [Ollama](https://ollama.com) (`qwen2.5:3b`) and [Bun](https://bun.com), with auth, email verification, conversation history, and file attachments.

## Features

- **Auth** — register, login, logout, bcrypt password hashing, 30-day sessions
- **Email verification** — SMTP verification tokens (Ethereal for testing, real SMTP for production)
- **Chat** — streaming responses via Ollama, conversation history persisted in SQLite
- **File attachments** — PDF, DOCX, and text files extracted and injected into chat context (5 MB cap)
- **Frontend** — auth screen, chat UI, conversation sidebar, dark/light theme
- **Database** — SQLite schema auto-migrated on startup

## Requirements

- [Bun](https://bun.com) (v1.3.14+)
- [Ollama](https://ollama.com) running locally with `qwen2.5:3b`:
  ```bash
  ollama pull qwen2.5:3b
  ```

## Install

```bash
bun install
```

## Configure

Copy `.env` and fill in SMTP values for production email:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@example.com
SMTP_PASS=your-app-password
```

If SMTP is not configured, verification emails are logged to the console instead (Ethereal-style testing).

> **Security:** never commit real SMTP credentials. `.env` is gitignored. Use environment variables or a secrets manager in production. The session cookie uses the `Secure` attribute, so HTTPS is required in production.

## Run

```bash
bun run dev
```

Server starts at `http://localhost:3000`.

## Docker

```bash
docker compose up --build
```

The app container expects Ollama to be reachable (the `ollama` service in `docker-compose.yml` runs on port 11434). The app connects to Ollama at `localhost:11434` from inside its container, so adjust `server.ts` if you run Ollama on a different host.

## Verify

```bash
# Typecheck
bun run typecheck

# Lint
bun run lint

# Tests
bun run test
```

CI runs lint, typecheck, and tests on every push/PR via GitHub Actions (`.github/workflows/ci.yml`).

## Database

SQLite file `emailai.sqlite` is created automatically on first run. Tables: `users`, `email_verifications`, `sessions`, `conversations`, `messages`, `files`. Uploaded files go to `./uploads`.

## Known limitations / next steps

- Password reset flow
- Per-IP rate limiting (especially on auth endpoints)
- Richer production deployment docs (reverse proxy, TLS, backups)
