import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./database";

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

describe("database schema", () => {
  it("creates all expected tables", () => {
    const db = freshDb();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["users", "email_verifications", "sessions", "conversations", "messages", "files"]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("users table has required columns", () => {
    const db = freshDb();
    const names = (db.query("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["id", "email", "password_hash", "email_verified"]));
    db.close();
  });

  it("is safe to run twice", () => {
    const db = freshDb();
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });
});
