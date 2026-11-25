import { Database } from "bun:sqlite";

/** Create tables and run small migrations. Safe to call on every startup. */
export function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      email_verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      conversation_id INTEGER,
      message_id INTEGER,
      filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER NOT NULL,
      extracted_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  // Migration: add message_id to files table if it predates this column
  const filesColumns = db.query(`PRAGMA table_info(files)`).all() as { name: string }[];
  if (!filesColumns.some((c) => c.name === "message_id")) {
    db.run(`ALTER TABLE files ADD COLUMN message_id INTEGER REFERENCES messages(id)`);
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_files_conversation ON files(conversation_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id)`);
}
