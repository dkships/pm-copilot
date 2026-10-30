import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureTicketSource, parseFixturePath } from "./fixture-tickets.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

const ticket = (id: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: 1000 + id,
  subject: `Ticket ${id}`,
  status: "active",
  state: "published",
  mailboxId: 99,
  createdAt,
  closedAt: null,
  tags: [{ id: 1, tag: "synthetic" }],
  primaryCustomer: { email: "dispatch@example.com" },
  preview: "Calendar froze again",
  threads: 2,
  ...extra,
});

function writeFixture(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-copilot-fixture-"));
  const path = join(dir, "tickets.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("parseFixturePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when PM_COPILOT_FIXTURE_TICKETS is unset or blank", () => {
    vi.stubEnv("PM_COPILOT_FIXTURE_TICKETS", "");
    expect(parseFixturePath("/repo")).toBeNull();
    vi.stubEnv("PM_COPILOT_FIXTURE_TICKETS", "   ");
    expect(parseFixturePath("/repo")).toBeNull();
  });

  it("keeps an absolute path and resolves a relative one against the project root", () => {
    vi.stubEnv("PM_COPILOT_FIXTURE_TICKETS", "/data/tickets.json");
    expect(parseFixturePath("/repo")).toBe("/data/tickets.json");
    vi.stubEnv("PM_COPILOT_FIXTURE_TICKETS", " demo/tickets.json ");
    expect(parseFixturePath("/repo")).toBe("/repo/demo/tickets.json");
  });
});

describe("FixtureTicketSource", () => {
  it("reports a single mailbox named fixture", async () => {
    const source = new FixtureTicketSource(writeFixture([]));
    expect(await source.fetchMailboxes()).toEqual([{ id: 1, name: "fixture" }]);
  });

  it("returns tickets inside the timeframe, newest first", async () => {
    const path = writeFixture([
      ticket(1, daysAgo(20)),
      ticket(2, daysAgo(2)),
      ticket(3, daysAgo(45)),
      ticket(4, new Date(Date.now() + DAY_MS).toISOString()),
    ]);
    const source = new FixtureTicketSource(path);

    const last30 = await source.fetchConversations({ timeframeDays: 30 });
    expect(last30.map((c) => c.id)).toEqual([2, 1]);

    const last90 = await source.fetchConversations({ timeframeDays: 90 });
    expect(last90.map((c) => c.id)).toEqual([2, 1, 3]);
  });

  it("accepts an object with a conversations array", async () => {
    const path = writeFixture({ note: "synthetic", conversations: [ticket(7, daysAgo(1))] });
    const result = await new FixtureTicketSource(path).fetchConversations({ timeframeDays: 30 });
    expect(result.map((c) => c.id)).toEqual([7]);
  });

  it("returns every ticket for the fixture mailbox and none for any other", async () => {
    const source = new FixtureTicketSource(writeFixture([ticket(1, daysAgo(1))]));
    expect(await source.fetchConversations({ timeframeDays: 30, mailboxId: "1" })).toHaveLength(1);
    expect(await source.fetchConversations({ timeframeDays: 30, mailboxId: "2" })).toHaveLength(0);
  });

  it("projects onto the Conversation shape and drops extra fields", async () => {
    const path = writeFixture([
      ticket(1, daysAgo(1), { writerRole: "dispatcher", customerType: "facility" }),
      { id: 2, subject: "Minimal", createdAt: daysAgo(1) },
    ]);
    const [full, minimal] = await new FixtureTicketSource(path).fetchConversations({
      timeframeDays: 30,
    });

    expect(full).not.toHaveProperty("writerRole");
    expect(full).not.toHaveProperty("customerType");
    expect(full?.mailboxId).toBe(1);
    expect(full?.tags).toEqual([{ id: 1, tag: "synthetic" }]);

    expect(minimal).toMatchObject({
      id: 2,
      number: 2,
      status: "active",
      tags: [],
      preview: "",
      closedAt: null,
    });
  });

  it("names the file when it is missing or not JSON", async () => {
    const missing = join(tmpdir(), "pm-copilot-no-such-fixture.json");
    await expect(
      new FixtureTicketSource(missing).fetchConversations({ timeframeDays: 30 })
    ).rejects.toThrow(missing);

    const notJson = writeFixture("{ not json");
    await expect(
      new FixtureTicketSource(notJson).fetchConversations({ timeframeDays: 30 })
    ).rejects.toThrow(/Failed to load fixture tickets/);
  });

  it("rejects a file with no conversation list", async () => {
    const path = writeFixture({ tickets: [] });
    await expect(
      new FixtureTicketSource(path).fetchConversations({ timeframeDays: 30 })
    ).rejects.toThrow(/expected an array of conversations/);
  });

  it("names the index of an invalid ticket", async () => {
    const path = writeFixture([ticket(1, daysAgo(1)), { id: "two", subject: "x", createdAt: daysAgo(1) }]);
    await expect(
      new FixtureTicketSource(path).fetchConversations({ timeframeDays: 30 })
    ).rejects.toThrow(/index 1.*"id" must be a number/);

    const badDate = writeFixture([ticket(1, "last tuesday")]);
    await expect(
      new FixtureTicketSource(badDate).fetchConversations({ timeframeDays: 30 })
    ).rejects.toThrow(/"createdAt" must be an ISO date string/);
  });
});
