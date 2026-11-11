import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";

describe("database schema", () => {
  it("creates all expected tables", () => {
    const db = new Database("emailai.sqlite");
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("users");
    expect(names).toContain("email_verifications");
    expect(names).toContain("sessions");
    expect(names).toContain("conversations");
    expect(names).toContain("messages");
    expect(names).toContain("files");
    db.close();
  });

  it("users table has required columns", () => {
    const db = new Database("emailai.sqlite");
    const columns = db
      .query("PRAGMA table_info(users)")
      .all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("email");
    expect(names).toContain("password_hash");
    expect(names).toContain("email_verified");
    db.close();
  });
});
