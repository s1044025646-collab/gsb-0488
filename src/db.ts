/** SQLite 持久化层：原子导入、行状态、冻结报告。 */
import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseNumericText, MAX_TEXT_LENGTH } from "./parse";
import { buildReport, BenfordReport, Mode } from "./benford";

export const MAX_ROWS_PER_IMPORT = 100_000;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
  }
}

export interface ImportRowInput {
  id: string;
  value: string;
}

export class BenfordStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        import_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        total_rows INTEGER NOT NULL,
        valid_n INTEGER NOT NULL,
        rejected_count INTEGER NOT NULL,
        excluded_zero_count INTEGER NOT NULL,
        has_rejected INTEGER NOT NULL,
        UNIQUE (import_key, payload_hash)
      );
      CREATE TABLE IF NOT EXISTS rows (
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        row_id TEXT NOT NULL,
        raw TEXT NOT NULL,
        normalized TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        sig_digits TEXT,
        raw_precision INTEGER,
        first_digit INTEGER,
        first_two INTEGER,
        PRIMARY KEY (dataset_id, row_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        n INTEGER NOT NULL,
        chi_square REAL,
        mad REAL,
        payload TEXT NOT NULL,
        UNIQUE (dataset_id, mode)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 原子导入：任一行失败或事务失败则整体回滚，不发布半个数据集。
   * 相同 importKey + 相同内容重试返回已有数据集（幂等）；
   * 相同 importKey + 不同内容生成新版本。
   */
  importDataset(
    name: string,
    importKey: string,
    rows: ImportRowInput[],
  ): { datasetId: number; version: number; reused: boolean } {
    if (!importKey || typeof importKey !== "string")
      throw new ApiError("INVALID_IMPORT_KEY", "importKey 必须是非空字符串");
    if (!Array.isArray(rows) || rows.length === 0)
      throw new ApiError("EMPTY_IMPORT", "导入行不能为空");
    if (rows.length > MAX_ROWS_PER_IMPORT)
      throw new ApiError(
        "TOO_MANY_ROWS",
        `行数超过上限 ${MAX_ROWS_PER_IMPORT}`,
      );

    const seen = new Set<string>();
    for (const r of rows) {
      if (!r || typeof r.id !== "string" || r.id.length === 0)
        throw new ApiError("MISSING_ROW_ID", "存在缺失或非法的行 ID");
      if (seen.has(r.id))
        throw new ApiError("DUPLICATE_ROW_ID", `行 ID 重复: ${r.id}`);
      seen.add(r.id);
      if (typeof r.value !== "string")
        throw new ApiError("INVALID_VALUE", `行 ${r.id} 的值必须是字符串`);
      if (r.value.length > MAX_TEXT_LENGTH)
        throw new ApiError(
          "TEXT_TOO_LONG",
          `行 ${r.id} 文本长度超过上限 ${MAX_TEXT_LENGTH}`,
        );
    }

    const payloadHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(rows.map((r) => [r.id, r.value])))
      .digest("hex");

    const existing = this.db
      .prepare(
        "SELECT id, version FROM datasets WHERE import_key = ? AND payload_hash = ?",
      )
      .get(importKey, payloadHash) as
      | { id: number; version: number }
      | undefined;
    if (existing) {
      return {
        datasetId: existing.id,
        version: existing.version,
        reused: true,
      };
    }

    const prev = this.db
      .prepare("SELECT MAX(version) AS v FROM datasets WHERE import_key = ?")
      .get(importKey) as { v: number | null };
    const version = (prev.v ?? 0) + 1;

    let validN = 0;
    let rejected = 0;
    let excludedZero = 0;
    const parsed = rows.map((r) => {
      const p = parseNumericText(r.value);
      if (p.status === "valid") validN++;
      else if (p.status === "rejected") rejected++;
      else excludedZero++;
      return { row: r, p };
    });

    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO datasets
           (name, import_key, payload_hash, version, created_at,
            total_rows, valid_n, rejected_count, excluded_zero_count, has_rejected)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          importKey,
          payloadHash,
          version,
          new Date().toISOString(),
          rows.length,
          validN,
          rejected,
          excludedZero,
          rejected > 0 ? 1 : 0,
        );
      const datasetId = Number(result.lastInsertRowid);
      const insertRow = this.db.prepare(
        `INSERT INTO rows
         (dataset_id, row_id, raw, normalized, status, reason,
          sig_digits, raw_precision, first_digit, first_two)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const { row, p } of parsed) {
        insertRow.run(
          datasetId,
          row.id,
          row.value,
          p.normalized,
          p.status,
          p.reason,
          p.significantDigits,
          p.rawPrecision,
          p.firstDigit,
          p.firstTwo,
        );
      }
      this.db.exec("COMMIT");
      return { datasetId, version, reused: false };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getDataset(id: number) {
    const d = this.db
      .prepare("SELECT * FROM datasets WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!d)
      throw new ApiError("DATASET_NOT_FOUND", `数据集 ${id} 不存在`, 404);
    return d;
  }

  listDatasets(page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;
    const items = this.db
      .prepare("SELECT * FROM datasets ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(pageSize, offset);
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM datasets").get() as {
        c: number;
      }
    ).c;
    return { items, total, page, pageSize };
  }

  listRows(
    datasetId: number,
    status: string | null,
    page: number,
    pageSize: number,
  ) {
    this.getDataset(datasetId);
    const offset = (page - 1) * pageSize;
    const where = status ? "AND status = ?" : "";
    const args: (number | string)[] = status
      ? [datasetId, status, pageSize, offset]
      : [datasetId, pageSize, offset];
    const items = this.db
      .prepare(
        `SELECT row_id, raw, normalized, status, reason, sig_digits,
                raw_precision, first_digit, first_two
         FROM rows WHERE dataset_id = ? ${where}
         ORDER BY row_id LIMIT ? OFFSET ?`,
      )
      .all(...args);
    const countArgs: (number | string)[] = status
      ? [datasetId, status]
      : [datasetId];
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM rows WHERE dataset_id = ? ${where}`,
        )
        .get(...countArgs) as { c: number }
    ).c;
    return { items, total, page, pageSize };
  }

  /** 生成（或返回已冻结的）报告。 */
  createReport(datasetId: number, mode: Mode) {
    const dataset = this.getDataset(datasetId);
    const existing = this.db
      .prepare(
        "SELECT id, created_at, payload FROM reports WHERE dataset_id = ? AND mode = ?",
      )
      .get(datasetId, mode) as
      | { id: number; created_at: string; payload: string }
      | undefined;
    if (existing) {
      return {
        reportId: existing.id,
        datasetId,
        datasetVersion: dataset.version,
        createdAt: existing.created_at,
        frozen: true,
        partial: dataset.has_rejected === 1,
        report: JSON.parse(existing.payload) as BenfordReport,
      };
    }

    const column = mode === "first" ? "first_digit" : "first_two";
    const counts = new Map<number, number>();
    const rows = this.db
      .prepare(
        `SELECT ${column} AS bin, COUNT(*) AS c FROM rows
         WHERE dataset_id = ? AND status = 'valid' GROUP BY ${column}`,
      )
      .all(datasetId) as { bin: number; c: number }[];
    for (const r of rows) counts.set(r.bin, r.c);

    const report = buildReport(mode, counts);
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO reports (dataset_id, mode, created_at, n, chi_square, mad, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        datasetId,
        mode,
        createdAt,
        report.n,
        report.chiSquare,
        report.mad,
        JSON.stringify(report),
      );
    return {
      reportId: Number(result.lastInsertRowid),
      datasetId,
      datasetVersion: dataset.version,
      createdAt,
      frozen: true,
      partial: dataset.has_rejected === 1,
      report,
    };
  }

  getReport(reportId: number) {
    const r = this.db
      .prepare("SELECT * FROM reports WHERE id = ?")
      .get(reportId) as
      | {
          id: number;
          dataset_id: number;
          mode: string;
          created_at: string;
          payload: string;
        }
      | undefined;
    if (!r)
      throw new ApiError("REPORT_NOT_FOUND", `报告 ${reportId} 不存在`, 404);
    const dataset = this.getDataset(r.dataset_id);
    return {
      reportId: r.id,
      datasetId: r.dataset_id,
      datasetVersion: dataset.version,
      mode: r.mode,
      createdAt: r.created_at,
      partial: dataset.has_rejected === 1,
      report: JSON.parse(r.payload) as BenfordReport,
    };
  }

  /** 按箱查询来源行（分页不影响正式箱计数）。 */
  rowsForBin(reportId: number, bin: number, page: number, pageSize: number) {
    const r = this.getReport(reportId);
    const column = r.mode === "first" ? "first_digit" : "first_two";
    const offset = (page - 1) * pageSize;
    const items = this.db
      .prepare(
        `SELECT row_id, raw, normalized, sig_digits, raw_precision
         FROM rows
         WHERE dataset_id = ? AND status = 'valid' AND ${column} = ?
         ORDER BY row_id LIMIT ? OFFSET ?`,
      )
      .all(r.datasetId, bin, pageSize, offset);
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM rows
           WHERE dataset_id = ? AND status = 'valid' AND ${column} = ?`,
        )
        .get(r.datasetId, bin) as { c: number }
    ).c;
    return { ...r, bin, items, total, page, pageSize };
  }

  /** 比较两个数据集版本在同一口径下的分布。 */
  compare(datasetIdA: number, datasetIdB: number, mode: Mode) {
    const a = this.createReport(datasetIdA, mode);
    const b = this.createReport(datasetIdB, mode);
    const bins = a.report.bins.map((ba, i) => {
      const bb = b.report.bins[i];
      return {
        bin: ba.bin,
        a: { observed: ba.observed, frequency: ba.frequency },
        b: { observed: bb.observed, frequency: bb.frequency },
        theoretical: ba.theoretical,
        frequencyDelta:
          ba.frequency !== null && bb.frequency !== null
            ? bb.frequency - ba.frequency
            : null,
      };
    });
    return {
      mode,
      a: {
        datasetId: datasetIdA,
        version: a.datasetVersion,
        n: a.report.n,
        chiSquare: a.report.chiSquare,
        mad: a.report.mad,
      },
      b: {
        datasetId: datasetIdB,
        version: b.datasetVersion,
        n: b.report.n,
        chiSquare: b.report.chiSquare,
        mad: b.report.mad,
      },
      bins,
    };
  }
}
