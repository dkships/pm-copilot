import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Conversation, FetchOptions, Mailbox, TicketSource } from "./helpscout.js";

const FIXTURE_TICKETS_ENV = "PM_COPILOT_FIXTURE_TICKETS";
const FIXTURE_MAILBOX: Mailbox = { id: 1, name: "fixture" };
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The fixture file path from PM_COPILOT_FIXTURE_TICKETS, or null when unset.
 * A relative path resolves against the project root, not the working
 * directory, for the same reason .env does: MCP clients launch the server
 * from elsewhere.
 */
export function parseFixturePath(projectRoot: string): string | null {
  const raw = process.env[FIXTURE_TICKETS_ENV]?.trim();
  if (!raw) {
    return null;
  }
  return resolve(projectRoot, raw);
}

/**
 * Serves support tickets from a local JSON file instead of the HelpScout API,
 * for demos and offline testing. The file holds HelpScout-shaped
 * conversations, either as a bare array or as `{ "conversations": [...] }`.
 *
 * Every ticket belongs to one mailbox named "fixture". The file is re-read on
 * each fetch, like themes.config.json, so edits apply without a restart.
 */
export class FixtureTicketSource implements TicketSource {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  get fileName(): string {
    return basename(this.path);
  }

  async fetchMailboxes(): Promise<Mailbox[]> {
    return [FIXTURE_MAILBOX];
  }

  async fetchConversations(options: FetchOptions): Promise<Conversation[]> {
    // Any mailbox other than the fixture's has no tickets, as the API would.
    if (options.mailboxId && options.mailboxId !== String(FIXTURE_MAILBOX.id)) {
      return [];
    }

    // Same window as the API query: createdAt between now - timeframe and now.
    const now = Date.now();
    const since = now - options.timeframeDays * MS_PER_DAY;

    return this.load()
      .filter((c) => {
        const created = Date.parse(c.createdAt);
        return created >= since && created <= now;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  private load(): Conversation[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf-8"));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load fixture tickets (${this.path}): ${msg}`);
    }

    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { conversations?: unknown })?.conversations;
    if (!Array.isArray(list)) {
      throw new Error(
        `Invalid fixture tickets (${this.path}): expected an array of conversations ` +
          'or an object with a "conversations" array.'
      );
    }

    return list.map((entry, index) => toConversation(entry, index, this.path));
  }
}

/**
 * Validate one fixture entry and project it onto the Conversation shape.
 * Projection drops any extra fields (writer role, notes) so they can never
 * reach the format layer.
 */
function toConversation(entry: unknown, index: number, path: string): Conversation {
  const raw = (entry ?? {}) as Partial<Conversation>;
  const invalid = (field: string) =>
    new Error(`Invalid fixture ticket at index ${index} (${path}): ${field}`);

  if (typeof raw.id !== "number") {
    throw invalid('"id" must be a number');
  }
  if (typeof raw.subject !== "string") {
    throw invalid('"subject" must be a string');
  }
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    throw invalid('"createdAt" must be an ISO date string');
  }

  return {
    id: raw.id,
    number: raw.number ?? raw.id,
    subject: raw.subject,
    status: raw.status ?? "active",
    state: raw.state ?? "published",
    mailboxId: FIXTURE_MAILBOX.id,
    createdAt: raw.createdAt,
    closedAt: raw.closedAt ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    primaryCustomer: { email: raw.primaryCustomer?.email ?? "" },
    preview: raw.preview ?? "",
    threads: raw.threads,
  };
}
