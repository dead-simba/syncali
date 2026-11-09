import type { PluginDataStoreLike } from "../plugin-data";

/**
 * A short, persistent history of the problems Syncali has reported.
 *
 * Notices vanish after a few seconds. On a phone there is no console to catch
 * them, so an error seen while walking is gone before it can be read, let
 * alone reported - which is how the same failure gets diagnosed three times.
 *
 * Kept small and on disk: enough to answer "what did it say?" after the fact,
 * not an audit trail. Entries are plain text that has already been shown to
 * the user, so nothing new is being retained here.
 */

const STORE_KEY = "errorLog";
const MAX_ENTRIES = 50;

export interface SyncErrorLogEntry {
  /** When this message was last seen. */
  at: number;
  message: string;
  /**
   * When it was first seen in this run of repeats, and how many times. A
   * repeat used to overwrite `at` and nothing else, so one line dated today
   * hid a failure that had happened on every pull for two weeks.
   */
  firstAt: number;
  count: number;
}

export class SyncErrorLog {
  private entries: SyncErrorLogEntry[] = [];

  constructor(private readonly store: PluginDataStoreLike) {}

  load(): void {
    const stored = this.store.read<unknown>(STORE_KEY);
    if (!Array.isArray(stored)) {
      return;
    }

    this.entries = stored
      .filter(
        (entry): entry is Partial<SyncErrorLogEntry> & { at: number; message: string } =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as SyncErrorLogEntry).message === "string" &&
          typeof (entry as SyncErrorLogEntry).at === "number",
      )
      // Entries saved before repeats were counted have neither field.
      .map((entry) => ({
        at: entry.at,
        message: entry.message,
        firstAt: typeof entry.firstAt === "number" ? entry.firstAt : entry.at,
        count: typeof entry.count === "number" && entry.count >= 1 ? entry.count : 1,
      }))
      .slice(-MAX_ENTRIES);
  }

  /**
   * Record a problem, collapsing an immediate repeat into a count.
   *
   * A failing sync retries on a timer, so the same message can arrive dozens of
   * times a minute. Keeping every copy would push the earlier, more useful
   * errors out of a short log - but forgetting how many there were, and since
   * when, made a two-week failure look like a one-off.
   */
  record(message: string, now = Date.now()): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    const last = this.entries[this.entries.length - 1];
    if (last?.message === trimmed) {
      last.at = now;
      last.count += 1;
      return;
    }

    this.entries.push({ at: now, message: trimmed, firstAt: now, count: 1 });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
  }

  list(): readonly SyncErrorLogEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries = [];
  }

  /** Newest first, as plain text ready to paste into a bug report. */
  toText(): string {
    if (this.entries.length === 0) {
      return "No problems recorded.";
    }

    return this.list()
      .map((entry) => {
        const line = `${new Date(entry.at).toISOString()}  ${entry.message}`;
        return entry.count > 1
          ? `${line}  (${entry.count} times since ${new Date(entry.firstAt).toISOString()})`
          : line;
      })
      .join("\n");
  }

  async persist(): Promise<void> {
    this.store.write(STORE_KEY, this.entries);
    await this.store.save();
  }
}
