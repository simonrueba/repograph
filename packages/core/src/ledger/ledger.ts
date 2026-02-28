import type { AriadneDB } from "../store/db";

export interface LedgerEntry {
  id: number;
  timestamp: number;
  event: string;
  data: string;
}

export class Ledger {
  constructor(private db: AriadneDB) {}

  log(event: string, data: Record<string, unknown>): void {
    this.db
      .query("INSERT INTO ledger (timestamp, event, data) VALUES (?1, ?2, ?3)")
      .run(Date.now(), event, JSON.stringify(data));
  }

  getAll(): LedgerEntry[] {
    return this.db
      .query("SELECT * FROM ledger ORDER BY id ASC")
      .all() as LedgerEntry[];
  }

  getByEvent(event: string): LedgerEntry[] {
    return this.db
      .query("SELECT * FROM ledger WHERE event = ?1 ORDER BY id ASC")
      .all(event) as LedgerEntry[];
  }

  getLatest(event: string): LedgerEntry | null {
    return (
      (this.db
        .query("SELECT * FROM ledger WHERE event = ?1 ORDER BY id DESC LIMIT 1")
        .get(event) as LedgerEntry | null) ?? null
    );
  }

  getAfter(timestamp: number): LedgerEntry[] {
    return this.db
      .query("SELECT * FROM ledger WHERE timestamp > ?1 ORDER BY id ASC")
      .all(timestamp) as LedgerEntry[];
  }

  hasTestAfterLastEdit(): boolean {
    const lastEdit = this.getLatest("edit");
    if (!lastEdit) return true;
    const lastTest = this.getLatest("test_run");
    if (!lastTest) return false;
    return lastTest.id > lastEdit.id;
  }
}
