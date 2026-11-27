# Local AI (`emailai`)

A self-hosted AI chat assistant powered by [Ollama](https://ollama.com) (`qwen2.5:3b`) and [Bun](https://bun.com), with auth, email verification, conversation history, and file attachments.

## Features

- **Auth** — register, login, logout, password reset by email, bcrypt password hashing, 30-day sessions
- **Profile & settings** — edit display name, deactivate (sign in again to reactivate) or permanently delete the account
- **Email verification** — SMTP verification tokens (Ethereal for testing, real SMTP for production)
- **Chat** — streaming responses via Ollama with timeouts, Stop button and context-window budgeting; history persisted in SQLite
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

Copy `.env.example` to `.env` and fill it in. Every setting is described in that file. The main ones:

| Variable | Default | What it does |
|---|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | Email for verification links. If unset, links are printed to the console. |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama runs. |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Model to use. |
| `OLLAMA_NUM_CTX` | `8192` | Context window (prompt + reply), in tokens. |
| `OLLAMA_NUM_PREDICT` | `1024` | Longest reply, in tokens. Longer replies are cut off and marked as such. |
| `OLLAMA_FIRST_BYTE_TIMEOUT_MS` / `OLLAMA_IDLE_TIMEOUT_MS` / `OLLAMA_TOTAL_TIMEOUT_MS` | 120 s / 60 s / 300 s | When to give up on a slow or stuck model. |
| `RETENTION_DAYS` | `0` (keep) | Delete conversations this many days after their last message. |
| `APP_URL` | — | Public address used in emailed links, e.g. `https://arisa.example.com`. **Set it in production.** |
| `TRUST_PROXY` | `false` | Set `true` only behind your own reverse proxy (uses `X-Forwarded-For` for rate limits). |

> **Security:** never commit `.env` or the database. `.env`, `*.sqlite` and `uploads/` are gitignored. The session cookie uses the `Secure` attribute, so HTTPS is required in production.

### Choose the Ollama model

Pull the model, set `OLLAMA_MODEL` in `.env`, and restart. Before switching, run the evaluation (below) on both models and keep the current one unless the candidate does better.

Hardware matters as much as the model. On a laptop without a usable GPU (tested: Intel i7-1165G7, 8 GB RAM, CPU-only), `qwen2.5:3b` replies in roughly 10–30 s, while `qwen3:4b` spends its whole reply budget "thinking" and can take minutes to say anything. See [docs/LLM_BASELINE.md](docs/LLM_BASELINE.md).

For thinking models (qwen3), leave `OLLAMA_THINK` unset unless you have tested it: with `qwen3:4b`, `OLLAMA_THINK=false` makes the model write its reasoning into the visible reply.

## How ARISA uses the model

- **Prompt:** the system prompt lives in [llm.ts](llm.ts) (honesty, attachment handling, safety). The server and the evals use the same prompt.
- **History:** the server reads earlier turns from the database. It never trusts history sent by the browser. If a conversation is too long for the context window, the oldest turns are dropped first.
- **Limits:** 8,000 characters per message; up to 5 attachments, each capped at 8,000 characters and 20,000 in total. Requests that still won't fit the context window are rejected with a clear message.
- **Reliability:** each reply has timeouts, stops when the user presses Stop or closes the tab, and is marked in the chat if it was cut off, stopped or interrupted.
- **Rate limits:** 20 chat messages and 20 uploads per user per minute; 10 login/register attempts per IP per minute.

## Privacy and data

- Chats, uploaded files and their extracted text are stored on the server (SQLite plus `uploads/`) and sent only to the configured Ollama server.
- Deleting a chat removes its messages, file records and the uploaded files. **Delete account** (sidebar) removes everything belonging to the user.
- Uploads that are never sent in a message are deleted after 24 hours. Set `RETENTION_DAYS` to expire old chats automatically.
- Logs record timings, token counts and outcomes, never message or file content.

## Evaluation

```bash
bun run eval                       # model from .env
bun run eval --model qwen3:4b      # compare a candidate on the same cases
bun run eval --only kiswahili      # one category or case id
```

Cases live in [evals/cases.json](evals/cases.json): instruction following, grounding, honesty, safety, prompt injection, Kiswahili and Kenyan English. Each run prints pass/fail and latency per case. It also writes the full record (prompt, options, output, timings) to `evals/results/`. Cases marked `review` also need a person to read the output. Add real ARISA tasks to the file as you find them.

## Run

```bash
bun run dev
```

Server starts at `http://localhost:3000`.

## Docker

```bash
docker compose up --build
docker compose exec ollama ollama pull qwen2.5:3b   # first time only
```

The app reaches Ollama at `http://ollama:11434` inside Compose. The database and uploads are kept in the `app-data` volume.

## Monitoring

`GET /health` is public. It checks the database, Ollama, and that the configured model is installed. It returns `200` when everything is ready and `503` otherwise, plus counters for completed, truncated, failed, timed-out and cancelled replies and the average latency. Every reply also writes one JSON log line (`"event":"chat"`) with latency, time to first token, tokens per second and the outcome.

## Verify

```bash
bun run typecheck
bun run lint
bun run test
```

CI runs lint, typecheck, and tests on every push/PR via GitHub Actions (`.github/workflows/ci.yml`).

## Database

The SQLite database (`emailai.sqlite`, or `DB_PATH`) and its tables are created automatically on startup. Tables: `users`, `email_verifications`, `sessions`, `conversations`, `messages`, `files`.

## Known limitations / next steps

- Richer production deployment docs (reverse proxy, TLS, backups)
- Rate limits are in memory and reset when the server restarts
