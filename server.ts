import { Database } from "bun:sqlite";
import nodemailer from "nodemailer";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { mkdirSync } from "node:fs";
import { join, extname } from "node:path";

const db = new Database("emailai.sqlite");

const SESSION_COOKIE = "session_id";
const SESSION_DAYS = 30;
const VERIFICATION_TOKEN_HOURS = 24;

const UPLOAD_DIR = "./uploads";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILE_CONTEXT_CHARS = 8000; // per file, injected into chat context
const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".js", ".ts", ".py", ".html", ".css"];

mkdirSync(UPLOAD_DIR, { recursive: true });

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
    .query(`SELECT user_id FROM email_verifications WHERE token = ? AND expires_at > datetime('now')`)
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
    .query(`SELECT s.user_id, u.email, u.name, u.email_verified FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > datetime('now')`)
    .get(sessionId) as { user_id: number; email: string; name: string | null; email_verified: number } | undefined;

  if (!session) return null;

  return { id: session.user_id, email: session.email, name: session.name, email_verified: session.email_verified };
}

function deleteSession(sessionId: string): void {
  db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

function cleanupExpiredSessions(): void {
  db.run(`DELETE FROM sessions WHERE expires_at <= datetime('now')`);
  db.run(`DELETE FROM email_verifications WHERE expires_at <= datetime('now')`);
}

cleanupExpiredSessions();

function setSessionCookie(sessionId: string): string {
  const expires = getSessionExpiry().toUTCString();
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${expires}`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// Simple in-memory rate limiter: 10 requests per window per IP per route
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const rateLimitHits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string, route: string): { ok: boolean; remaining: number } {
  const key = `${ip}:${route}`;
  const now = Date.now();
  let entry = rateLimitHits.get(key);

  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitHits.set(key, entry);
    return { ok: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",");
    return (parts[0] ?? "").trim();
  }
  return "unknown";
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

async function sendVerificationEmail(email: string, token: string, origin: string): Promise<void> {
  const verificationUrl = `${origin}/api/auth/verify-email?token=${token}`;
  
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
        <h1 style="color: white; margin: 16px 0 0; font-size: 24px;">Local AI</h1>
      </div>
      <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 16px 16px; border: 1px solid #e5e7eb; border-top: none;">
        <h2 style="margin: 0 0 16px; font-size: 20px;">Verify your email</h2>
        <p style="margin: 0 0 24px; color: #4b5563;">Thanks for signing up! Please verify your email address to activate your account.</p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${verificationUrl}" style="display: inline-block; background: #15803d; color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 16px;">Verify Email Address</a>
        </div>
        <p style="margin: 24px 0 0; font-size: 13px; color: #6b7280;">Or copy this link:<br><a href="${verificationUrl}" style="color: #15803d; word-break: break-all;">${verificationUrl}</a></p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="margin: 0; font-size: 12px; color: #9ca3af;">This link expires in ${VERIFICATION_TOKEN_HOURS} hours. If you didn't create an account, you can ignore this email.</p>
      </div>
    </body>
    </html>
  `;

  const transporter = await getTransporter();
  
  if (!transporter) {
    console.log("=== VERIFICATION EMAIL (SMTP not configured) ===");
    console.log(`To: ${email}`);
    console.log(`Verification URL: ${verificationUrl}`);
    console.log("=============================================");
    return;
  }

  await transporter.sendMail({
    from: `"Local AI" <${EMAIL_CONFIG.auth.user}>`,
    to: email,
    subject: "Verify your Local AI account",
    html,
  });
}

const server = Bun.serve({
  port: 3000,

  async fetch(req) {
    const url = new URL(req.url);

    // =========================
    // AUTH ENDPOINTS
    // =========================

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const limit = rateLimit(clientIp(req), "register");
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
      const limit = rateLimit(clientIp(req), "login");
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
          .query(`SELECT id, email, password_hash, name, email_verified FROM users WHERE email = ?`)
          .get(email) as { id: number; email: string; password_hash: string; name: string | null; email_verified: number } | undefined;

        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return Response.json({ error: "Invalid email or password" }, { status: 401 });
        }

        if (!user.email_verified) {
          return Response.json({ error: "Please verify your email before logging in. Check your inbox for the verification link." }, { status: 401 });
        }

        const sessionId = createSession(user.id);

        return Response.json({
          user: { id: user.id, email: user.email, name: user.name, email_verified: 1 },
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
    // SERVE FRONTEND
    // =========================

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(
        await Bun.file("./public/index.html").text(),
        {
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    if (url.pathname === "/style.css" && req.method === "GET") {
      return new Response(
        await Bun.file("./public/style.css").text(),
        { headers: { "Content-Type": "text/css" } }
      );
    }

    if (url.pathname === "/script.js" && req.method === "GET") {
      return new Response(
        await Bun.file("./public/script.js").text(),
        { headers: { "Content-Type": "application/javascript" } }
      );
    }

    // =========================
    // PROTECTED ROUTES - require authentication
    // =========================

    const auth = requireAuth(req);
    if (auth instanceof Response) return auth;
    const user = auth;

    // =========================
    // FILE UPLOAD API
    // =========================

    if (url.pathname === "/api/upload" && req.method === "POST") {
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

        if (extractedText.length > MAX_FILE_CONTEXT_CHARS) {
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

        return Response.json({ file: record });
      } catch (error) {
        console.error("Upload error:", error);
        return Response.json({ error: "File upload failed" }, { status: 500 });
      }
    }

    // =========================
    // CHAT API
    // =========================

    if (url.pathname === "/chat" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const message = body.message?.trim();

        if (!message) {
          return Response.json({ error: "Message is required" }, { status: 400 });
        }

        const conversationId = body.conversationId;

        let conversation;

        if (conversationId) {
          const existing = db
            .query("SELECT * FROM conversations WHERE id = ? AND user_id = ?")
            .get(conversationId, user.id) as { id: number; title: string; created_at: string } | undefined;

          if (existing) {
            conversation = existing;
          } else {
            conversation = db
              .query(`INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING *`)
              .get(user.id, message.length > 40 ? message.substring(0, 40) + "..." : message) as {
                id: number; title: string; created_at: string;
              };
          }
        } else {
          conversation = db
            .query(`INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING *`)
            .get(user.id, message.length > 40 ? message.substring(0, 40) + "..." : message) as {
              id: number; title: string; created_at: string;
            };
        }

        // =========================
        // ATTACHED FILES
        // =========================

        const fileIds: number[] = Array.isArray(body.fileIds) ? body.fileIds : [];
        let userContent = message;

        if (fileIds.length > 0) {
          const placeholders = fileIds.map(() => "?").join(",");
          const attachedFiles = db
            .query(`SELECT filename, extracted_text FROM files WHERE id IN (${placeholders}) AND user_id = ?`)
            .all(...fileIds, user.id) as { filename: string; extracted_text: string }[];

          if (attachedFiles.length > 0) {
            const fileBlocks = attachedFiles
              .map((f) => `[Attached file: ${f.filename}]\n${f.extracted_text}`)
              .join("\n\n---\n\n");
            userContent = `${fileBlocks}\n\n---\n\n${message}`;
          }

          db.run(
            `UPDATE files SET conversation_id = ? WHERE id IN (${placeholders}) AND user_id = ?`,
            [conversation.id, ...fileIds, user.id]
          );
        }

        // =========================
        // AI PROMPT
        // =========================

        const history = body.conversation || [];

        const messages = [
          {
            role: "system",
            content:
              "You are a helpful, intelligent and friendly AI assistant. " +
              "You help with general questions, programming, coding, writing, " +
              "email, learning, problem solving, brainstorming, explanations, " +
              "summaries, planning, and everyday conversations. " +
              "Give direct, natural conversational responses. " +
              "Keep answers concise unless the user asks for detail."
          },
          ...history.map((entry: { role: string; text: string }) => ({
            role: entry.role === "user" ? "user" : "assistant",
            content: entry.text
          })),
          {
            role: "user",
            content: userContent
          }
        ];

        // =========================
        // SEND TO OLLAMA (STREAM)
        // =========================

        const ollamaResponse = await fetch(
          "http://localhost:11434/api/chat",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "qwen2.5:3b",
              messages: messages,
              stream: true,
            }),
          }
        );

        if (!ollamaResponse.ok || !ollamaResponse.body) {
          return Response.json(
            { error: "Could not connect to Ollama. Make sure Ollama is running." },
            { status: 500 }
          );
        }

        // =========================
        // SAVE USER MESSAGE
        // =========================

        const userMessage = db
          .query(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?) RETURNING id`)
          .get(conversation.id, "user", message) as { id: number };

        if (fileIds.length > 0) {
          const placeholders = fileIds.map(() => "?").join(",");
          db.run(
            `UPDATE files SET message_id = ? WHERE id IN (${placeholders}) AND user_id = ?`,
            [userMessage.id, ...fileIds, user.id]
          );
        }

        
        // =========================
        // STREAM TOKENS TO CLIENT
        // =========================
        


        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const stream = new ReadableStream({
          async start(controller) {
            const reader = ollamaResponse.body!.getReader();
            let fullResponse = "";
            let buffer = "";

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const json = JSON.parse(line);
                    const chunk = json.message?.content || "";

                    if (chunk) {
                      fullResponse += chunk;
                      const payload = JSON.stringify({ chunk, done: false, conversationId: conversation.id }) + "\n";
                      controller.enqueue(encoder.encode(payload));
                    }

                    if (json.done) {
                      db.run(
                        `INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`,
                        [conversation.id, "assistant", fullResponse]
                      );
                      const final = JSON.stringify({ chunk: "", done: true, conversationId: conversation.id }) + "\n";
                      controller.enqueue(encoder.encode(final));
                      controller.close();
                      return;
                    }
                  } catch {}
                }
              }

              if (fullResponse) {
                db.run(
                  `INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`,
                  [conversation.id, "assistant", fullResponse]
                );
              }
              const final = JSON.stringify({ chunk: "", done: true, conversationId: conversation.id }) + "\n";
              controller.enqueue(encoder.encode(final));
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
        });
      } catch (error) {
        console.error("Chat error:", error);
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
        .query("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
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

      db.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
      db.run("DELETE FROM conversations WHERE id = ?", [id]);

      return Response.json({ success: true });
    }

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "Local AI Assistant",
        model: "qwen2.5:3b",
        database: "connected",
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Local AI Assistant running at http://localhost:${server.port}`);