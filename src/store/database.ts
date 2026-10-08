import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RULES, type DigitMode, type RowStatus } from '../core/constants.js';
import { parseDecimalText } from '../core/parse.js';
import { buildReport, type Report } from '../core/statistics.js';
import type { InputRecord } from '../io/records.js';

export interface StoredRow {
  versionId: string;
  datasetId: string;
  versionNumber: number;
  rowId: string;
  rawValue: string;
  status: RowStatus;
  reason: string;
  normalized: string | null;
  sign: '+' | '-';
  mantissaDigits: string;
  exponent: number | null;
  significantDigits: string;
  firstDigit: number | null;
  firstTwo: number | null;
  precision: number;
}

export interface ImportResult {
  datasetId: string;
  versionId: string;
  versionNumber: number;
  idempotentRetry: boolean;
  rules: typeof RULES;
  reports: Record<DigitMode, Report>;
}

export class BenfordStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.init();
  }

  close(): void {
    this.db.close();
  }

  importRecords(datasetIdInput: string | undefined, records: InputRecord[], idempotencyKey: string | undefined): ImportResult {
    const datasetId = (datasetIdInput || randomUUID()).trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(datasetId)) throw new ValidationStoreError('INVALID_DATASET_ID', 'datasetId 只允许 1-100 位字母、数字、下划线或连字符。');
    const key = idempotencyKey?.trim();
    if (key !== undefined && !/^[A-Za-z0-9_:.-]{1,200}$/.test(key)) throw new ValidationStoreError('INVALID_IDEMPOTENCY_KEY', '幂等键只允许 1-200 位安全字符。');
    if (key) {
      const existing = this.db.prepare('SELECT version_id FROM idempotency_keys WHERE idempotency_key=?').get(key) as { version_id: string } | undefined;
      if (existing) return this.getImportResult(existing.version_id, true);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO datasets(dataset_id, created_at) VALUES (?, unixepoch())').run(datasetId);
      const versionRow = this.db.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number FROM versions WHERE dataset_id=?').get(datasetId) as { next_number: number };
      const versionNumber = versionRow.next_number;
      const versionId = randomUUID();
      const parsedRows = records.map((record) => {
        const parsed = parseDecimalText(record.value);
        return { ...record, parsed, rawValue: String(record.value) };
      });

      this.db.prepare('INSERT INTO versions(version_id,dataset_id,version_number,created_at,rules_json) VALUES (?,?,?,unixepoch(),?)')
        .run(versionId, datasetId, versionNumber, JSON.stringify(RULES));
      const insertRow = this.db.prepare(`INSERT INTO rows_raw(version_id,dataset_id,version_number,row_id,raw_value,status,reason,normalized,sign,mantissa_digits,exponent,significant_digits,first_digit,first_two,precision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of parsedRows) {
        insertRow.run(versionId, datasetId, versionNumber, item.id, item.rawValue, item.parsed.status, item.parsed.reason, item.parsed.normalized, item.parsed.sign,
          item.parsed.mantissaDigits, item.parsed.exponent, item.parsed.significantDigits, item.parsed.firstDigit, item.parsed.firstTwo, item.parsed.precision);
      }
      const reports = {
        first: buildReport(parsedRows.map((item) => item.parsed), parsedRows.length, 'first'),
        first_two: buildReport(parsedRows.map((item) => item.parsed), parsedRows.length, 'first_two')
      } as Record<DigitMode, Report>;
      for (const mode of ['first', 'first_two'] as DigitMode[]) {
        this.db.prepare('INSERT INTO reports(version_id,mode,report_json) VALUES (?,?,?)').run(versionId, mode, JSON.stringify(reports[mode]));
      }
      if (key) this.db.prepare('INSERT INTO idempotency_keys(idempotency_key,version_id) VALUES (?,?)').run(key, versionId);
      this.db.exec('COMMIT');
      return { datasetId, versionId, versionNumber, idempotentRetry: false, rules: RULES, reports };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listRows(versionId: string, limit: number, offset: number): { total: number; rows: StoredRow[] } {
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM rows_raw WHERE version_id=?').get(versionId) as { count: number }).count;
    const rows = this.db.prepare('SELECT * FROM rows_raw WHERE version_id=? ORDER BY rowid LIMIT ? OFFSET ?').all(versionId, limit, offset) as unknown as DatabaseRow[];
    return { total, rows: rows.map(mapRow) };
  }

  sources(versionId: string, mode: DigitMode, bin: number, limit: number, offset: number): { total: number; rows: StoredRow[] } {
    const column = mode === 'first' ? 'first_digit' : 'first_two';
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM rows_raw WHERE version_id=? AND status='valid' AND ${column}=?`).get(versionId, bin) as { count: number }).count;
    const rows = this.db.prepare(`SELECT * FROM rows_raw WHERE version_id=? AND status='valid' AND ${column}=? ORDER BY rowid LIMIT ? OFFSET ?`).all(versionId, bin, limit, offset) as unknown as DatabaseRow[];
    return { total, rows: rows.map(mapRow) };
  }

  getReport(versionId: string, mode: DigitMode): { version: VersionInfo; rules: typeof RULES; report: Report } {
    const reportRow = this.db.prepare('SELECT report_json FROM reports WHERE version_id=? AND mode=?').get(versionId, mode) as { report_json: string } | undefined;
    if (!reportRow) throw new ValidationStoreError('REPORT_NOT_FOUND', '冻结报告不存在。');
    const versionRow = this.db.prepare('SELECT rules_json FROM versions WHERE version_id=?').get(versionId) as { rules_json: string } | undefined;
    return {
      version: this.getVersion(versionId),
      rules: JSON.parse(versionRow?.rules_json ?? '{}') as typeof RULES,
      report: JSON.parse(reportRow.report_json) as Report
    };
  }

  compare(versionIdA: string, versionIdB: string): { left: Report; right: Report } {
    return { left: this.getReport(versionIdA, 'first').report, right: this.getReport(versionIdB, 'first').report };
  }

  private getImportResult(versionId: string, idempotentRetry: boolean): ImportResult {
    const version = this.getVersion(versionId);
    return {
      datasetId: version.dataset_id,
      versionId,
      versionNumber: version.version_number,
      idempotentRetry,
      rules: RULES,
      reports: {
        first: this.getReport(versionId, 'first').report,
        first_two: this.getReport(versionId, 'first_two').report
      }
    };
  }

  private getVersion(versionId: string): VersionInfo {
    const row = this.db.prepare('SELECT version_id,dataset_id,version_number FROM versions WHERE version_id=?').get(versionId) as VersionInfo | undefined;
    if (!row) throw new ValidationStoreError('VERSION_NOT_FOUND', '样本版本不存在。');
    return row;
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets(dataset_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(version_id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,version_number INTEGER NOT NULL,created_at INTEGER NOT NULL,rules_json TEXT NOT NULL,UNIQUE(dataset_id,version_number),FOREIGN KEY(dataset_id) REFERENCES datasets(dataset_id));
      CREATE TABLE IF NOT EXISTS rows_raw(version_id TEXT NOT NULL,dataset_id TEXT NOT NULL,version_number INTEGER NOT NULL,row_id TEXT NOT NULL,raw_value TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,normalized TEXT,sign TEXT NOT NULL,mantissa_digits TEXT NOT NULL,exponent INTEGER,significant_digits TEXT NOT NULL,first_digit INTEGER,first_two INTEGER,precision INTEGER NOT NULL,PRIMARY KEY(version_id,row_id),FOREIGN KEY(version_id) REFERENCES versions(version_id));
      CREATE TABLE IF NOT EXISTS reports(version_id TEXT NOT NULL,mode TEXT NOT NULL,report_json TEXT NOT NULL,PRIMARY KEY(version_id,mode),FOREIGN KEY(version_id) REFERENCES versions(version_id));
      CREATE TABLE IF NOT EXISTS idempotency_keys(idempotency_key TEXT PRIMARY KEY,version_id TEXT NOT NULL,FOREIGN KEY(version_id) REFERENCES versions(version_id));
    `);
  }
}

interface DatabaseRow {
  version_id: string; dataset_id: string; version_number: number; row_id: string; raw_value: string;
  status: RowStatus; reason: string; normalized: string | null; sign: '+' | '-'; mantissa_digits: string;
  exponent: number | null; significant_digits: string; first_digit: number | null; first_two: number | null; precision: number;
}

interface VersionInfo { version_id: string; dataset_id: string; version_number: number; }

export class ValidationStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function mapRow(row: DatabaseRow): StoredRow {
  return {
    versionId: row.version_id, datasetId: row.dataset_id, versionNumber: row.version_number, rowId: row.row_id,
    rawValue: row.raw_value, status: row.status, reason: row.reason, normalized: row.normalized, sign: row.sign,
    mantissaDigits: row.mantissa_digits, exponent: row.exponent, significantDigits: row.significant_digits,
    firstDigit: row.first_digit, firstTwo: row.first_two, precision: row.precision
  };
}
