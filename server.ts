import { Database } from "bun:sqlite";
import nodemailer from "nodemailer";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { initSchema } from "./database";
import {
  INPUT_LIMITS,
  buildMessages,
  loadLlmConfig,
  ollamaChatBody,
  type Attachment,
  type HistoryTurn,
} from "./llm";

const db = new Database(process.env.DB_PATH?.trim() || "emailai.sqlite");
initSchema(db);

const SESSION_COOKIE = "session_id";
const SESSION_DAYS = 30;
const VERIFICATION_TOKEN_HOURS = 24;
const LLM = loadLlmConfig();
const OLLAMA_MODEL = LLM.model;

const UPLOAD_DIR = process.env.UPLOAD_DIR?.trim() || "./uploads";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILE_CONTEXT_CHARS = INPUT_LIMITS.maxFileChars; // per file, injected into chat context
const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".js", ".ts", ".py", ".html", ".css"];

// Data retention. 0 = keep conversations until the user deletes them.
const RETENTION_DAYS = (() => {
  const n = Number.parseInt(process.env.RETENTION_DAYS ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
// Uploads that were never sent with a message are removed after this many hours.
const ORPHAN_UPLOAD_HOURS = 24;
// Only trust X-Forwarded-For when running behind a reverse proxy you control.
const TRUST_PROXY = process.env.TRUST_PROXY?.trim().toLowerCase() === "true";

mkdirSync(UPLOAD_DIR, { recursive: true });

// =========================
// LOGGING & METRICS (no message content is ever logged)
// =========================

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

const chatStats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  completed: 0,
  truncated: 0,
  failed: 0,
  timedOut: 0,
  cancelled: 0,
  rejectedTooLarge: 0,
  totalLatencyMs: 0,
  totalOutputTokens: 0,
};

// =========================
// FILE & DATA CLEANUP
// =========================

async function removeStoredFile(storedPath: string): Promise<void> {
  // Never delete anything outside the upload directory.
  const root = resolve(UPLOAD_DIR) + sep;
  const target = resolve(storedPath);
  if (!target.startsWith(root)) return;
  try {
    await unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logEvent("file_delete_error", { error: (err as Error).message });
    }
  }
}

/** Delete conversations (messages, file records and uploaded files) in one go. */
async function deleteConversations(conversationIds: number[]): Promise<void> {
  if (conversationIds.length === 0) return;
  const placeholders = conversationIds.map(() => "?").join(",");
  const files = db
    .query(`SELECT stored_path FROM files WHERE conversation_id IN (${placeholders})`)
    .all(...conversationIds) as { stored_path: string }[];

  db.transaction(() => {
    db.run(`DELETE FROM files WHERE conversation_id IN (${placeholders})`, conversationIds);
    db.run(`DELETE FROM messages WHERE conversation_id IN (${placeholders})`, conversationIds);
    db.run(`DELETE FROM conversations WHERE id IN (${placeholders})`, conversationIds);
  })();

  await Promise.all(files.map((f) => removeStoredFile(f.stored_path)));
}

async function runDataCleanup(): Promise<void> {
  try {
    const orphans = db
      .query(`SELECT id, stored_path FROM files WHERE message_id IS NULL AND created_at <= datetime('now', ?)`)
      .all(`-${ORPHAN_UPLOAD_HOURS} hours`) as { id: number; stored_path: string }[];
    if (orphans.length > 0) {
      db.run(`DELETE FROM files WHERE id IN (${orphans.map(() => "?").join(",")})`, orphans.map((o) => o.id));
      await Promise.all(orphans.map((o) => removeStoredFile(o.stored_path)));
    }

    let expired: { id: number }[] = [];
    if (RETENTION_DAYS > 0) {
      // A conversation expires when its most recent message is older than the retention period.
      expired = db
        .query(
          `SELECT c.id FROM conversations c
           WHERE COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at)
                 <= datetime('now', ?)`
        )
        .all(`-${RETENTION_DAYS} days`) as { id: number }[];
      await deleteConversations(expired.map((c) => c.id));
    }

    if (orphans.length || expired.length) {
      logEvent("data_cleanup", { orphanUploadsRemoved: orphans.length, conversationsExpired: expired.length });
    }
  } catch (err) {
    logEvent("data_cleanup_error", { error: (err as Error).message });
  }
}

// Email configuration - using Ethereal for testing (replace with real SMTP for production)
const EMAIL_CONFIG = {
  host: process.env.SMTP_HOST || "smtp.ethereal.email",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
};

let transporter: nodemailer.Transporter | null = null;

async function getTransporter(): Promise<nodemailer.Transporter | null> {
  if (transporter) return transporter;
  
  if (!EMAIL_CONFIG.auth.user || !EMAIL_CONFIG.auth.pass) {
    console.warn("SMTP not configured - emails will be logged to console instead");
    return null;
  }
  
  transporter = nodemailer.createTransport(EMAIL_CONFIG);
  return transporter;
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function generateVerificationToken(): string {
  return crypto.randomUUID();
}

function getSessionExpiry(): Date {
  const date = new Date();
  date.setDate(date.getDate() + SESSION_DAYS);
  return date;
}

function getVerificationExpiry(): Date {
  const date = new Date();
  date.setHours(date.getHours() + VERIFICATION_TOKEN_HOURS);
  return date;
}

async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await Bun.password.verify(password, hash);
}

function createSession(userId: number): string {
  const sessionId = generateSessionId();
  const expiresAt = getSessionExpiry();

  db.run(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`,
    [sessionId, userId, expiresAt.toISOString()]
  );

  return sessionId;
}

function createVerificationToken(userId: number): string {
  const token = generateVerificationToken();
  const expiresAt = getVerificationExpiry();

  db.run(
    `INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, ?)`,
    [userId, token, expiresAt.toISOString()]
  );

  return token;
}

function verifyToken(token: string): { user_id: number } | null {
  const verification = db
    .query(`SELECT user_id FROM email_verifications WHERE token = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .get(token) as { user_id: number } | undefined;

  if (!verification) return null;

  db.run(`DELETE FROM email_verifications WHERE token = ?`, [token]);
  return verification;
}

function markEmailVerified(userId: number): void {
  db.run(`UPDATE users SET email_verified = 1 WHERE id = ?`, [userId]);
}

function getUserFromSession(sessionId: string): { id: number; email: string; name: string | null; email_verified: number } | null {
  const session = db
    .query(`SELECT s.user_id, u.email, u.name, u.email_verified FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND u.deactivated_at IS NULL`)
    .get(sessionId) as { user_id: number; email: string; name: string | null; email_verified: number } | undefined;

  if (!session) return null;

  return { id: session.user_id, email: session.email, name: session.name, email_verified: session.email_verified };
}

function deleteSession(sessionId: string): void {
  db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

function cleanupExpiredSessions(): void {
  db.run(`DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
  db.run(`DELETE FROM email_verifications WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
  db.run(`DELETE FROM password_resets WHERE used_at IS NOT NULL OR expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
}

cleanupExpiredSessions();
void runDataCleanup();
setInterval(() => {
  cleanupExpiredSessions();
  void runDataCleanup();
  const now = Date.now();
  for (const [key, entry] of rateLimitHits) {
    if (now > entry.resetAt) rateLimitHits.delete(key);
  }
}, 60 * 60 * 1000);

function setSessionCookie(sessionId: string): string {
  const expires = getSessionExpiry().toUTCString();
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expires}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// Simple in-memory rate limiter: `max` requests per minute per key per route
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const CHAT_RATE_LIMIT_MAX = 20;
const UPLOAD_RATE_LIMIT_MAX = 20;
const rateLimitHits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(
  key: string,
  route: string,
  max = RATE_LIMIT_MAX,
  windowMs = RATE_LIMIT_WINDOW_MS
): { ok: boolean; remaining: number } {
  const bucket = `${key}:${route}`;
  const now = Date.now();
  let entry = rateLimitHits.get(bucket);

  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + windowMs };
    rateLimitHits.set(bucket, entry);
    return { ok: true, remaining: max - 1 };
  }

  entry.count++;
  if (entry.count > max) {
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: max - entry.count };
}

function clientIp(req: Request, server: { requestIP(req: Request): { address: string } | null }): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  return server.requestIP(req)?.address ?? "unknown";
}

function getSessionIdFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;

  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] ?? null : null;
}

function requireAuth(req: Request): { id: number; email: string; name: string | null; email_verified: number } | Response {
  const sessionId = getSessionIdFromCookie(req);
  if (!sessionId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = getUserFromSession(sessionId);
  if (!user) {
    return Response.json({ error: "Invalid or expired session" }, { status: 401 });
  }

  return user;
}

async function extractFileText(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const ext = extname(filename).toLowerCase();

  if (mimeType === "application/pdf" || ext === ".pdf") {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text;
  }

  if (ext === ".docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === ".doc") {
    throw new Error("Legacy .doc files aren't supported — please save as .docx or PDF");
  }

  if (mimeType.startsWith("text/") || TEXT_EXTENSIONS.includes(ext)) {
    return buffer.toString("utf-8");
  }

  throw new Error("Unsupported file type");
}

/**
 * Base URL used in emailed links. Set APP_URL in production: without it the
 * link uses the request's Host header, which an attacker can forge to make a
 * password-reset email point at their own site.
 */
function appBaseUrl(requestOrigin: string): string {
  return (process.env.APP_URL?.trim() || requestOrigin).replace(/\/+$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function sendActionEmail(opts: {
  to: string;
  subject: string;
  heading: string;
  intro: string;
  buttonText: string;
  actionUrl: string;
  footer: string;
}): Promise<void> {
  const url = escapeHtml(opts.actionUrl);
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #15803d 0%, #166534 100%); padding: 30px; border-radius: 16px 16px 0 0; text-align: center;">
        <div style="width: 56px; height: 56px; border-radius: 16px; background: white; color: #15803d; display: inline-flex; align-items: center; justify-content: center; font-size: 28px; font-weight: bold;">✦</div>
        <h1 style="color: white; margin: 16px 0 0; font-size: 24px;">Arisa Assistant</h1>
      </div>
      <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 16px 16px; border: 1px solid #e5e7eb; border-top: none;">
        <h2 style="margin: 0 0 16px; font-size: 20px;">${escapeHtml(opts.heading)}</h2>
        <p style="margin: 0 0 24px; color: #4b5563;">${escapeHtml(opts.intro)}</p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${url}" style="display: inline-block; background: #15803d; color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 16px;">${escapeHtml(opts.buttonText)}</a>
        </div>
        <p style="margin: 24px 0 0; font-size: 13px; color: #6b7280;">Or copy this link:<br><a href="${url}" style="color: #15803d; word-break: break-all;">${url}</a></p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="margin: 0; font-size: 12px; color: #9ca3af;">${escapeHtml(opts.footer)}</p>
      </div>
    </body>
    </html>
  `;

  const transporter = await getTransporter();

  if (!transporter) {
    console.log(`=== EMAIL (SMTP not configured): ${opts.subject} ===`);
    console.log(`To: ${opts.to}`);
    console.log(`Link: ${opts.actionUrl}`);
    console.log("=============================================");
    return;
  }

  await transporter.sendMail({
    from: `"Arisa Assistant" <${EMAIL_CONFIG.auth.user}>`,
    to: opts.to,
    subject: opts.subject,
    html,
  });
}

async function sendVerificationEmail(email: string, token: string, origin: string): Promise<void> {
  await sendActionEmail({
    to: email,
    subject: "Verify your Arisa Assistant account",
    heading: "Verify your email",
    intro: "Thanks for signing up! Please verify your email address to activate your account.",
    buttonText: "Verify Email Address",
    actionUrl: `${appBaseUrl(origin)}/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    footer: `This link expires in ${VERIFICATION_TOKEN_HOURS} hours. If you didn't create an account, you can ignore this email.`,
  });
}

// =========================
// PASSWORD RESET
// =========================

const PASSWORD_RESET_MINUTES = 60;

/** Only a hash of the reset token is stored, so a leaked database can't be used to reset passwords. */
function hashResetToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function createPasswordResetToken(userId: number): string {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_MINUTES * 60 * 1000);
  db.transaction(() => {
    // Only the newest link works.
    db.run(`DELETE FROM password_resets WHERE user_id = ?`, [userId]);
    db.run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`, [
      userId,
      hashResetToken(token),
      expiresAt.toISOString(),
    ]);
  })();
  return token;
}

function findValidPasswordReset(token: string): { id: number; user_id: number } | null {
  const row = db
    .query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
    )
    .get(hashResetToken(token), new Date().toISOString()) as { id: number; user_id: number } | undefined;
  return row ?? null;
}

async function sendPasswordResetEmail(email: string, token: string, origin: string): Promise<void> {
  await sendActionEmail({
    to: email,
    subject: "Reset your Arisa Assistant password",
    heading: "Reset your password",
    intro: "We received a request to reset your password. Click the button below to choose a new one.",
    buttonText: "Reset Password",
    actionUrl: `${appBaseUrl(origin)}/?reset=${encodeURIComponent(token)}`,
    footer: `This link expires in ${PASSWORD_RESET_MINUTES} minutes and can be used once. If you didn't ask to reset your password, you can ignore this email; your password won't change.`,
  });
}

const server = Bun.serve({
  port: Number.parseInt(process.env.PORT ?? "3000", 10) || 3000,
  // Bun's default (10s) would cut off streamed replies while the model loads or thinks.
  idleTimeout: 255,

  async fetch(req, server) {
    const url = new URL(req.url);

    // =========================
    // AUTH ENDPOINTS
    // =========================

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const limit = rateLimit(clientIp(req, server), "register");
      if (!limit.ok) {
        return Response.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }
      try {
        const body = (await req.json()) as { email?: string; password?: string; name?: string };
        const email = body.email?.trim().toLowerCase();
        const password = body.password;
        const name = body.name?.trim();

        if (!email || !password) {
          return Response.json({ error: "Email and password are required" }, { status: 400 });
        }

        if (password.length < 8) {
          return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
        }

        const existing = db.query(`SELECT id FROM users WHERE email = ?`).get(email);
        if (existing) {
          return Response.json({ error: "Email already registered" }, { status: 400 });
        }

        const passwordHash = await hashPassword(password);

        const user = db
          .query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES (?, ?, ?, 0) RETURNING id, email, name, created_at`)
          .get(email, passwordHash, name || null) as { id: number; email: string; name: string | null; created_at: string };

        const token = createVerificationToken(user.id);
        await sendVerificationEmail(email, token, url.origin);

        return Response.json({
          user: { id: user.id, email: user.email, name: user.name, email_verified: 0 },
          message: "Registration successful. Please check your email to verify your account."
        });
      } catch (error) {
        console.error("Register error:", error);
        return Response.json({ error: "Registration failed" }, { status: 500 });
      }
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const limit = rateLimit(clientIp(req, server), "login");
      if (!limit.ok) {
        return Response.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }
      try {
        const body = (await req.json()) as { email?: string; password?: string };
        const email = body.email?.trim().toLowerCase();
        const password = body.password;

        if (!email || !password) {
          return Response.json({ error: "Email and password are required" }, { status: 400 });
        }

        const user = db
          .query(`SELECT id, email, password_hash, name, email_verified, deactivated_at FROM users WHERE email = ?`)
          .get(email) as { id: number; email: string; password_hash: string; name: string | null; email_verified: number; deactivated_at: string | null } | undefined;

        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return Response.json({ error: "Invalid email or password" }, { status: 401 });
        }

        if (!user.email_verified) {
          return Response.json({ error: "Please verify your email before logging in. Check your inbox for the verification link." }, { status: 401 });
        }

        // Signing in to a deactivated account reactivates it.
        const reactivated = Boolean(user.deactivated_at);
        if (reactivated) {
          db.run(`UPDATE users SET deactivated_at = NULL WHERE id = ?`, [user.id]);
          logEvent("account_reactivated", {});
        }

        const sessionId = createSession(user.id);

        return Response.json({
          user: { id: user.id, email: user.email, name: user.name, email_verified: 1 },
          reactivated,
        }, {
          headers: { "Set-Cookie": setSessionCookie(sessionId) }
        });
      } catch (error) {
        console.error("Login error:", error);
        return Response.json({ error: "Login failed" }, { status: 500 });
      }
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const sessionId = getSessionIdFromCookie(req);
      if (sessionId) {
        deleteSession(sessionId);
      }

      return Response.json({ success: true }, {
        headers: { "Set-Cookie": clearSessionCookie() }
      });
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const sessionId = getSessionIdFromCookie(req);
      if (!sessionId) {
        return Response.json({ user: null });
      }

      const user = getUserFromSession(sessionId);
      if (!user) {
        return Response.json({ user: null });
      }

      return Response.json({ user });
    }

    if (url.pathname === "/api/auth/verify-email" && req.method === "GET") {
      const token = url.searchParams.get("token");
      if (!token) {
        return Response.json({ error: "Invalid verification link" }, { status: 400 });
      }

      const verification = verifyToken(token);
      if (!verification) {
        return Response.json({ error: "Invalid or expired verification link" }, { status: 400 });
      }

      markEmailVerified(verification.user_id);

      return Response.json({ success: true, message: "Email verified successfully. You can now log in." });
    }

    if (url.pathname === "/api/auth/resend-verification" && req.method === "POST") {
      const limit = rateLimit(clientIp(req, server), "resend-verification");
      if (!limit.ok) {
        return Response.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }
      try {
        const body = (await req.json()) as { email?: string };
        const email = body.email?.trim().toLowerCase();

        if (!email) {
          return Response.json({ error: "Email is required" }, { status: 400 });
        }

        const user = db
          .query(`SELECT id, email, email_verified FROM users WHERE email = ?`)
          .get(email) as { id: number; email: string; email_verified: number } | undefined;

        if (!user) {
          return Response.json({ error: "If this email is registered, a verification link has been sent." }, { status: 200 });
        }

        if (user.email_verified) {
          return Response.json({ error: "Email is already verified. You can log in." }, { status: 400 });
        }

        const token = createVerificationToken(user.id);
        await sendVerificationEmail(email, token, url.origin);

        return Response.json({ success: true, message: "Verification email sent. Please check your inbox." });
      } catch (error) {
        console.error("Resend verification error:", error);
        return Response.json({ error: "Failed to send verification email" }, { status: 500 });
      }
    }

    // =========================
    // PASSWORD RESET
    // =========================

    if (url.pathname === "/api/auth/forgot-password" && req.method === "POST") {
      if (!rateLimit(clientIp(req, server), "forgot-password", 5).ok) {
        return Response.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }

      // Same reply whether or not the email has an account, so the form can't
      // be used to find out who is registered.
      const genericReply = Response.json({
        success: true,
        message: "If an account exists for that email, we've sent a link to reset the password. It expires in 60 minutes.",
      });

      try {
        const body = (await req.json().catch(() => ({}))) as { email?: unknown };
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || !email.includes("@")) {
          return Response.json({ error: "Please enter your email address." }, { status: 400 });
        }

        // At most 3 reset emails per address per hour, to stop inbox flooding.
        if (!rateLimit(email, "forgot-password-email", 3, 60 * 60 * 1000).ok) {
          return genericReply;
        }

        const user = db.query(`SELECT id, email FROM users WHERE email = ?`).get(email) as { id: number; email: string } | undefined;
        if (user) {
          const token = createPasswordResetToken(user.id);
          await sendPasswordResetEmail(user.email, token, url.origin);
          logEvent("password_reset_requested", {});
        }
        return genericReply;
      } catch (error) {
        logEvent("password_reset_error", { stage: "request", error: (error as Error).message });
        return Response.json({ error: "Couldn't send the reset email. Please try again later." }, { status: 500 });
      }
    }

    if (url.pathname === "/api/auth/reset-password" && req.method === "POST") {
      if (!rateLimit(clientIp(req, server), "reset-password").ok) {
        return Response.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }
      try {
        const body = (await req.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
        const token = typeof body.token === "string" ? body.token : "";
        const password = typeof body.password === "string" ? body.password : "";

        if (password.length < 8) {
          return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
        }

        const reset = token ? findValidPasswordReset(token) : null;
        if (!reset) {
          return Response.json(
            { error: "This reset link is invalid or has expired. Please request a new one." },
            { status: 400 }
          );
        }

        const passwordHash = await hashPassword(password);
        db.transaction(() => {
          db.run(`UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?`, [passwordHash, reset.user_id]);
          db.run(`UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [reset.id]);
          db.run(`DELETE FROM password_resets WHERE user_id = ? AND id != ?`, [reset.user_id, reset.id]);
          // Sign out everywhere: anyone using the old password loses access.
          db.run(`DELETE FROM sessions WHERE user_id = ?`, [reset.user_id]);
        })();

        logEvent("password_reset_completed", {});
        return Response.json({ success: true, message: "Your password has been reset. You can now sign in with your new password." });
      } catch (error) {
        logEvent("password_reset_error", { stage: "reset", error: (error as Error).message });
        return Response.json({ error: "Couldn't reset your password. Please try again." }, { status: 500 });
      }
    }

    // =========================
    // SERVE FRONTEND
    // =========================

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(
        await Bun.file("./public/index.html").text(),
        {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
        }
      );
    }

    if (url.pathname === "/style.css" && req.method === "GET") {
      return new Response(
        await Bun.file("./public/style.css").text(),
        { headers: { "Content-Type": "text/css", "Cache-Control": "no-cache" } }
      );
    }

    if (url.pathname === "/script.js" && req.method === "GET") {
      return new Response(
        await Bun.file("./public/script.js").text(),
        { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-cache" } }
      );
    }

    if (url.pathname === "/arisa-icon.png" && req.method === "GET") {
      return new Response(
        Bun.file("./public/arisa-icon.png"),
        { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } }
      );
    }

    if (url.pathname === "/api/model-info" && req.method === "GET") {
      return Response.json({ model: OLLAMA_MODEL, retentionDays: RETENTION_DAYS });
    }

    // Public health check: really checks the database and Ollama.
    if (url.pathname === "/health" && req.method === "GET") {
      let databaseOk = false;
      try {
        db.query("SELECT 1").get();
        databaseOk = true;
      } catch {}

      let ollamaReachable = false;
      let modelAvailable = false;
      try {
        const res = await fetch(`${LLM.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          ollamaReachable = true;
          const tags = (await res.json()) as { models?: { name: string }[] };
          const wanted = OLLAMA_MODEL.includes(":") ? OLLAMA_MODEL : `${OLLAMA_MODEL}:latest`;
          modelAvailable = (tags.models ?? []).some((m) => m.name === wanted);
        }
      } catch {}

      const ok = databaseOk && ollamaReachable && modelAvailable;
      const avgLatencyMs = chatStats.completed ? Math.round(chatStats.totalLatencyMs / chatStats.completed) : null;
      return Response.json(
        {
          status: ok ? "ok" : "degraded",
          service: "ARISA",
          model: OLLAMA_MODEL,
          checks: { database: databaseOk, ollama: ollamaReachable, model: modelAvailable },
          stats: {
            since: chatStats.startedAt,
            requests: chatStats.requests,
            completed: chatStats.completed,
            truncated: chatStats.truncated,
            failed: chatStats.failed,
            timedOut: chatStats.timedOut,
            cancelled: chatStats.cancelled,
            rejectedTooLarge: chatStats.rejectedTooLarge,
            avgLatencyMs,
          },
        },
        { status: ok ? 200 : 503 }
      );
    }

    // =========================
    // PROTECTED ROUTES - require authentication
    // =========================

    const auth = requireAuth(req);
    if (auth instanceof Response) return auth;
    const user = auth;

    // =========================
    // PROFILE
    // =========================

    if (url.pathname === "/api/profile" && req.method === "GET") {
      const profile = db
        .query(`SELECT id, email, name, email_verified, created_at FROM users WHERE id = ?`)
        .get(user.id) as { id: number; email: string; name: string | null; email_verified: number; created_at: string } | undefined;
      if (!profile) return Response.json({ error: "Account not found" }, { status: 404 });

      const stats = db
        .query(
          `SELECT
             (SELECT COUNT(*) FROM conversations WHERE user_id = ?) AS conversations,
             (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.user_id = ? AND m.role = 'user') AS messages,
             (SELECT COUNT(*) FROM files WHERE user_id = ? AND message_id IS NOT NULL) AS files`
        )
        .get(user.id, user.id, user.id) as { conversations: number; messages: number; files: number };

      return Response.json({ profile: { ...profile, stats } });
    }

    if (url.pathname === "/api/profile" && req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (typeof body.name !== "string") {
        return Response.json({ error: "Name is required" }, { status: 400 });
      }
      const name = body.name.trim();
      if (name.length > 80) {
        return Response.json({ error: "Name must be 80 characters or fewer" }, { status: 400 });
      }
      db.run(`UPDATE users SET name = ? WHERE id = ?`, [name || null, user.id]);
      return Response.json({ user: { ...user, name: name || null } });
    }

    // =========================
    // DEACTIVATE ACCOUNT (data kept; signing in again reactivates)
    // =========================

    if (url.pathname === "/api/account/deactivate" && req.method === "POST") {
      const limit = rateLimit(clientIp(req, server), "deactivate-account");
      if (!limit.ok) {
        return Response.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }
      const body = (await req.json().catch(() => ({}))) as { password?: string };
      const row = db.query(`SELECT password_hash FROM users WHERE id = ?`).get(user.id) as { password_hash: string } | undefined;
      if (!row || !body.password || !(await verifyPassword(body.password, row.password_hash))) {
        return Response.json({ error: "Incorrect password" }, { status: 401 });
      }
      db.transaction(() => {
        db.run(`UPDATE users SET deactivated_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);
        db.run(`DELETE FROM sessions WHERE user_id = ?`, [user.id]); // sign out everywhere
      })();
      logEvent("account_deactivated", {});
      return Response.json({ success: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
    }

    // =========================
    // DELETE ACCOUNT (and all of the user's data)
    // =========================

    if (url.pathname === "/api/account" && req.method === "DELETE") {
      const limit = rateLimit(clientIp(req, server), "delete-account");
      if (!limit.ok) {
        return Response.json({ error: "Too many requests. Try again later." }, { status: 429 });
      }
      try {
        const body = (await req.json().catch(() => ({}))) as { password?: string };
        const row = db.query(`SELECT password_hash FROM users WHERE id = ?`).get(user.id) as { password_hash: string } | undefined;
        if (!row || !body.password || !(await verifyPassword(body.password, row.password_hash))) {
          return Response.json({ error: "Incorrect password" }, { status: 401 });
        }

        const conversations = db.query(`SELECT id FROM conversations WHERE user_id = ?`).all(user.id) as { id: number }[];
        await deleteConversations(conversations.map((c) => c.id));

        const remainingFiles = db.query(`SELECT stored_path FROM files WHERE user_id = ?`).all(user.id) as { stored_path: string }[];
        db.transaction(() => {
          db.run(`DELETE FROM files WHERE user_id = ?`, [user.id]);
          db.run(`DELETE FROM sessions WHERE user_id = ?`, [user.id]);
          db.run(`DELETE FROM email_verifications WHERE user_id = ?`, [user.id]);
          db.run(`DELETE FROM password_resets WHERE user_id = ?`, [user.id]);
          db.run(`DELETE FROM users WHERE id = ?`, [user.id]);
        })();
        await Promise.all(remainingFiles.map((f) => removeStoredFile(f.stored_path)));

        logEvent("account_deleted", { conversations: conversations.length });
        return Response.json({ success: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
      } catch (error) {
        logEvent("account_delete_error", { error: (error as Error).message });
        return Response.json({ error: "Could not delete account" }, { status: 500 });
      }
    }

    // =========================
    // FILE UPLOAD API
    // =========================

    if (url.pathname === "/api/upload" && req.method === "POST") {
      if (!rateLimit(`user:${user.id}`, "upload", UPLOAD_RATE_LIMIT_MAX).ok) {
        return Response.json({ error: "Too many uploads. Please wait a minute." }, { status: 429 });
      }
      try {
        const formData = await req.formData();
        const file = formData.get("file");

        if (!(file instanceof File)) {
          return Response.json({ error: "No file provided" }, { status: 400 });
        }

        if (file.size > MAX_FILE_SIZE) {
          return Response.json({ error: "File is too large (max 5MB)" }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());

        let extractedText: string;
        try {
          extractedText = await extractFileText(buffer, file.name, file.type);
        } catch (err) {
          const message = err instanceof Error && err.message.includes(".doc")
            ? err.message
            : "Unsupported file type. Please upload a text file, PDF, or Word (.docx) document.";
          return Response.json({ error: message }, { status: 400 });
        }

        const truncated = extractedText.length > MAX_FILE_CONTEXT_CHARS;
        if (truncated) {
          extractedText = extractedText.slice(0, MAX_FILE_CONTEXT_CHARS) + "\n\n[...truncated]";
        }

        const storedName = `${crypto.randomUUID()}${extname(file.name)}`;
        const storedPath = join(UPLOAD_DIR, storedName);
        await Bun.write(storedPath, buffer);

        const record = db
          .query(
            `INSERT INTO files (user_id, filename, stored_path, mime_type, size, extracted_text) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, filename, size`
          )
          .get(user.id, file.name, storedPath, file.type, file.size, extractedText) as { id: number; filename: string; size: number };

        return Response.json({ file: { ...record, truncated } });
      } catch (error) {
        console.error("Upload error:", error);
        return Response.json({ error: "File upload failed" }, { status: 500 });
      }
    }

    // =========================
    // CHAT API
    // =========================

    if (url.pathname === "/chat" && req.method === "POST") {
      chatStats.requests++;
      if (!rateLimit(`user:${user.id}`, "chat", CHAT_RATE_LIMIT_MAX).ok) {
        return Response.json({ error: "You're sending messages too quickly. Please wait a minute." }, { status: 429 });
      }

      try {
        const body = (await req.json().catch(() => null)) as
          | { message?: unknown; conversationId?: unknown; fileIds?: unknown }
          | null;

        // =========================
        // VALIDATE INPUT
        // =========================

        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) {
          return Response.json({ error: "Message is required" }, { status: 400 });
        }
        if (message.length > INPUT_LIMITS.maxMessageChars) {
          return Response.json(
            { error: `Your message is too long (max ${INPUT_LIMITS.maxMessageChars.toLocaleString()} characters). Attach long text as a file instead.` },
            { status: 413 }
          );
        }

        const rawFileIds: unknown[] = Array.isArray(body?.fileIds) ? body.fileIds : [];
        if (!rawFileIds.every((id) => Number.isSafeInteger(id) && (id as number) > 0)) {
          return Response.json({ error: "Invalid attachment" }, { status: 400 });
        }
        const fileIds = [...new Set(rawFileIds as number[])];
        if (fileIds.length > INPUT_LIMITS.maxFilesPerMessage) {
          return Response.json(
            { error: `You can attach up to ${INPUT_LIMITS.maxFilesPerMessage} files per message.` },
            { status: 400 }
          );
        }

        let conversation: { id: number } | undefined;
        if (Number.isSafeInteger(body?.conversationId)) {
          conversation = db
            .query("SELECT id FROM conversations WHERE id = ? AND user_id = ?")
            .get(body!.conversationId as number, user.id) as { id: number } | undefined;
        }

        // =========================
        // ATTACHED FILES
        // =========================

        const attachments: Attachment[] = [];
        if (fileIds.length > 0) {
          const placeholders = fileIds.map(() => "?").join(",");
          const rows = db
            .query(`SELECT filename, extracted_text FROM files WHERE id IN (${placeholders}) AND user_id = ?`)
            .all(...fileIds, user.id) as { filename: string; extracted_text: string | null }[];
          if (rows.length !== fileIds.length) {
            return Response.json({ error: "One or more attachments were not found. Please upload them again." }, { status: 400 });
          }
          for (const r of rows) attachments.push({ filename: r.filename, text: r.extracted_text ?? "" });

          const totalChars = attachments.reduce((n, a) => n + a.text.length, 0);
          if (totalChars > INPUT_LIMITS.maxTotalAttachmentChars) {
            return Response.json(
              { error: "These attachments contain too much text to send together. Please attach fewer files." },
              { status: 413 }
            );
          }
        }

        // =========================
        // BUILD PROMPT (history comes from the database, never the client)
        // =========================

        const history: HistoryTurn[] = conversation
          ? (db
              .query("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC")
              .all(conversation.id) as { role: string; content: string }[]
            ).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }))
          : [];

        const built = buildMessages({
          history,
          attachments,
          message,
          numCtx: LLM.numCtx,
          numPredict: LLM.numPredict,
        });

        if (!built.ok) {
          chatStats.rejectedTooLarge++;
          logEvent("chat_rejected", { reason: built.reason, estimatedPromptTokens: built.estimatedPromptTokens, budgetTokens: built.budgetTokens });
          return Response.json(
            { error: "Your message and attachments are too long for the AI model to read at once. Remove an attachment or shorten the message." },
            { status: 413 }
          );
        }

        // =========================
        // SEND TO OLLAMA (STREAM) WITH TIMEOUTS AND CANCELLATION
        // =========================

        type AbortReason = "timeout_first_byte" | "timeout_idle" | "timeout_total" | "client_cancelled";
        const state = { abortReason: null as AbortReason | null, finished: false };
        const abort = new AbortController();
        const abortWith = (reason: AbortReason) => {
          if (state.abortReason || state.finished) return;
          state.abortReason = reason;
          abort.abort();
        };
        const onClientAbort = () => abortWith("client_cancelled");
        req.signal.addEventListener("abort", onClientAbort);

        const startedAt = performance.now();
        const totalTimer = setTimeout(() => abortWith("timeout_total"), LLM.totalTimeoutMs);
        let idleTimer = setTimeout(() => abortWith("timeout_first_byte"), LLM.firstByteTimeoutMs);
        const resetIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => abortWith("timeout_idle"), LLM.idleTimeoutMs);
        };
        const clearTimers = () => {
          clearTimeout(totalTimer);
          clearTimeout(idleTimer);
          req.signal.removeEventListener("abort", onClientAbort);
        };

        let ollamaResponse: Response;
        try {
          ollamaResponse = await fetch(`${LLM.url}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ollamaChatBody(LLM, built.messages, true)),
            signal: abort.signal,
          });
        } catch (err) {
          clearTimers();
          if (state.abortReason === "client_cancelled") {
            chatStats.cancelled++;
            return new Response(null, { status: 499 });
          }
          const timedOut = state.abortReason !== null;
          if (timedOut) chatStats.timedOut++;
          else chatStats.failed++;
          logEvent("chat_error", { stage: "connect", reason: state.abortReason ?? "unreachable", error: (err as Error).message });
          return Response.json(
            {
              error: timedOut
                ? "The AI model took too long to respond. Please try again."
                : "Could not reach the AI model. Make sure Ollama is running.",
            },
            { status: timedOut ? 504 : 502 }
          );
        }

        if (!ollamaResponse.ok || !ollamaResponse.body) {
          clearTimers();
          const detail = (await ollamaResponse.text().catch(() => "")).slice(0, 300);
          chatStats.failed++;
          logEvent("chat_error", { stage: "ollama_status", status: ollamaResponse.status, detail });
          return Response.json(
            {
              error: ollamaResponse.status === 404
                ? `The AI model "${OLLAMA_MODEL}" is not installed on the server.`
                : "The AI model returned an error. Please try again.",
            },
            { status: 502 }
          );
        }

        // =========================
        // SAVE CONVERSATION + USER MESSAGE (only once the model is responding)
        // =========================

        const conversationId = db.transaction(() => {
          const convId = conversation
            ? conversation.id
            : (db
                .query(`INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id`)
                .get(user.id, message.length > 40 ? message.substring(0, 40) + "..." : message) as { id: number }).id;

          const userMessage = db
            .query(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id`)
            .get(convId, "user", message) as { id: number };

          if (fileIds.length > 0) {
            const placeholders = fileIds.map(() => "?").join(",");
            db.run(
              `UPDATE files SET conversation_id = ?, message_id = ? WHERE id IN (${placeholders}) AND user_id = ?`,
              [convId, userMessage.id, ...fileIds, user.id]
            );
          }
          return convId;
        })();

        // =========================
        // STREAM TOKENS TO CLIENT
        // =========================

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const reader = ollamaResponse.body.getReader();

        interface OllamaChunk {
          message?: { content?: string; thinking?: string };
          done?: boolean;
          done_reason?: string;
          error?: string;
          total_duration?: number;
          load_duration?: number;
          prompt_eval_count?: number;
          eval_count?: number;
          eval_duration?: number;
        }

        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: Record<string, unknown>) => {
              try {
                controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
              } catch {
                // client already gone
              }
            };

            let fullResponse = "";
            let buffer = "";
            let final: OllamaChunk | null = null;
            let streamError: string | null = null;
            let malformedChunks = 0;
            let firstTokenMs: number | null = null;
            let lastHeartbeat = 0;

            try {
              read: while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                resetIdleTimer();

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                  if (!line.trim()) continue;
                  let json: OllamaChunk;
                  try {
                    json = JSON.parse(line) as OllamaChunk;
                  } catch {
                    malformedChunks++;
                    continue;
                  }

                  if (json.error) {
                    streamError = String(json.error);
                    break read;
                  }

                  const chunk = json.message?.content ?? "";
                  if (chunk) {
                    if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
                    fullResponse += chunk;
                    send({ chunk, done: false, conversationId });
                  } else if (json.message?.thinking && performance.now() - lastHeartbeat > 2000) {
                    // Keep the connection alive and let the UI show progress while a thinking model reasons.
                    lastHeartbeat = performance.now();
                    send({ status: "thinking", done: false, conversationId });
                  }

                  if (json.done) {
                    final = json;
                    break read;
                  }
                }
              }
            } catch (err) {
              streamError = state.abortReason ?? (err as Error).message;
            } finally {
              state.finished = true;
              clearTimers();
              reader.cancel().catch(() => {});
            }

            // Decide the outcome and mark incomplete replies honestly.
            let outcome: "completed" | "truncated" | "empty" | "cancelled" | "timeout" | "failed";
            let notice: string | null = null;
            if (final && final.done_reason === "length") {
              outcome = "truncated";
              notice = "[Reply cut off: it reached the maximum length. Ask me to continue if you need more.]";
            } else if (final && fullResponse.trim()) {
              outcome = "completed";
            } else if (final) {
              outcome = "empty";
              notice = "[The AI model returned an empty reply. Please try again.]";
            } else if (state.abortReason === "client_cancelled") {
              outcome = "cancelled";
              notice = "[Reply stopped before it finished.]";
            } else if (state.abortReason) {
              outcome = "timeout";
              notice = "[Reply interrupted: the AI model took too long to respond.]";
            } else {
              outcome = "failed";
              notice = "[Reply interrupted: the AI model stopped unexpectedly. Please try again.]";
            }

            const saved = notice ? (fullResponse ? `${fullResponse}\n\n${notice}` : notice) : fullResponse;
            try {
              db.run(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`, [conversationId, "assistant", saved]);
            } catch (err) {
              logEvent("chat_error", { stage: "save_reply", error: (err as Error).message });
            }

            if (notice) send({ chunk: (fullResponse ? "\n\n" : "") + notice, done: false, conversationId });
            send({ chunk: "", done: true, conversationId, outcome });
            try {
              controller.close();
            } catch {}

            // Metrics: counts and timings only, never message content.
            const latencyMs = Math.round(performance.now() - startedAt);
            if (outcome === "completed" || outcome === "truncated") {
              chatStats.completed++;
              chatStats.totalLatencyMs += latencyMs;
              chatStats.totalOutputTokens += final?.eval_count ?? 0;
              if (outcome === "truncated") chatStats.truncated++;
            } else if (outcome === "cancelled") chatStats.cancelled++;
            else if (outcome === "timeout") chatStats.timedOut++;
            else chatStats.failed++;

            logEvent("chat", {
              model: OLLAMA_MODEL,
              outcome,
              abortReason: state.abortReason,
              error: outcome === "completed" ? undefined : streamError ?? undefined,
              latencyMs,
              timeToFirstTokenMs: firstTokenMs,
              loadMs: final?.load_duration ? Math.round(final.load_duration / 1e6) : undefined,
              promptTokens: final?.prompt_eval_count,
              outputTokens: final?.eval_count,
              tokensPerSecond:
                final?.eval_count && final.eval_duration
                  ? Math.round((final.eval_count / (final.eval_duration / 1e9)) * 10) / 10
                  : undefined,
              estimatedPromptTokens: built.estimatedPromptTokens,
              historyTurnsUsed: built.historyTurnsUsed,
              historyTurnsDropped: built.historyTurnsDropped,
              attachments: attachments.length,
              malformedChunks: malformedChunks || undefined,
            });
          },
          cancel() {
            // Browser closed the tab or navigated away: stop generating.
            abortWith("client_cancelled");
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
        });
      } catch (error) {
        chatStats.failed++;
        logEvent("chat_error", { stage: "handler", error: (error as Error).message });
        return Response.json({ error: "Something went wrong while generating the response." }, { status: 500 });
      }
    }

    // =========================
    // CONVERSATIONS API (protected)
    // =========================

    if (url.pathname === "/api/conversations" && req.method === "GET") {
      const conversations = db
        .query("SELECT id, title, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC")
        .all(user.id) as { id: number; title: string; created_at: string }[];

      return Response.json({ conversations });
    }

    if (url.pathname.startsWith("/api/conversations/") && req.method === "GET") {
      const id = parseInt(url.pathname.replace("/api/conversations/", "").split("/")[0] ?? "", 10);
      if (isNaN(id)) {
        return Response.json({ error: "Invalid conversation ID" }, { status: 400 });
      }

      const conversation = db
        .query("SELECT * FROM conversations WHERE id = ? AND user_id = ?")
        .get(id, user.id) as { id: number; title: string; created_at: string } | undefined;

      if (!conversation) {
        return Response.json({ error: "Conversation not found" }, { status: 404 });
      }

      const messages = db
        .query("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC")
        .all(id) as { id: number; role: string; content: string; created_at: string }[];

      const attachments = db
        .query("SELECT message_id, filename FROM files WHERE conversation_id = ? AND message_id IS NOT NULL")
        .all(id) as { message_id: number; filename: string }[];

      const attachmentsByMessage = new Map<number, string[]>();
      for (const a of attachments) {
        const list = attachmentsByMessage.get(a.message_id) || [];
        list.push(a.filename);
        attachmentsByMessage.set(a.message_id, list);
      }

      const messagesWithAttachments = messages.map((m) => ({
        ...m,
        attachments: attachmentsByMessage.get(m.id) || [],
      }));

      return Response.json({ conversation, messages: messagesWithAttachments });
    }

    if (url.pathname.startsWith("/api/conversations/") && req.method === "DELETE") {
      const id = parseInt(url.pathname.replace("/api/conversations/", ""));
      if (isNaN(id)) {
        return Response.json({ error: "Invalid conversation ID" }, { status: 400 });
      }

      const conversation = db
        .query("SELECT id FROM conversations WHERE id = ? AND user_id = ?")
        .get(id, user.id);

      if (!conversation) {
        return Response.json({ error: "Conversation not found" }, { status: 404 });
      }

      // Removes messages, file records, extracted text and the uploaded files on disk.
      await deleteConversations([id]);

      return Response.json({ success: true });
    }

    return new Response("Not Found", { status: 404 });
  },
});

logEvent("server_started", { url: `http://localhost:${server.port}`, model: OLLAMA_MODEL, ollamaUrl: LLM.url, numCtx: LLM.numCtx, numPredict: LLM.numPredict, retentionDays: RETENTION_DAYS });
