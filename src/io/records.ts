import { MAX_ROWS, MAX_TEXT_LENGTH } from '../core/constants.js';

export interface InputRecord {
  id: string;
  value: unknown;
}

export function normalizeRecords(input: unknown): InputRecord[] {
  const records = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray((input as { rows?: unknown }).rows)
      ? ((input as { rows: unknown[] }).rows)
      : null;

  if (!records) throw new ValidationError('INVALID_RECORDS_SHAPE', '请求必须是行数组或包含 rows 数组的对象。');
  if (records.length === 0) throw new ValidationError('EMPTY_IMPORT', '至少需要导入一行。');
  if (records.length > MAX_ROWS) throw new ValidationError('TOO_MANY_ROWS', `单次导入不得超过 ${MAX_ROWS} 行。`);

  const seen = new Set<string>();
  return records.map((record, index) => {
    if (!isObject(record)) throw new ValidationError('INVALID_ROW', `第 ${index + 1} 行不是对象。`);
    const row = record as { id?: unknown; value?: unknown };
    if (typeof row.id !== 'string' && typeof row.id !== 'number') {
      throw new ValidationError('MISSING_ROW_ID', `第 ${index + 1} 行缺少行 ID。`);
    }
    const id = String(row.id).trim();
    if (!id) throw new ValidationError('MISSING_ROW_ID', `第 ${index + 1} 行行 ID 为空白。`);
    if (id.length > 200) throw new ValidationError('ROW_ID_TOO_LONG', `第 ${index + 1} 行行 ID 超过 200 字符。`);
    if (seen.has(id)) throw new ValidationError('DUPLICATE_ROW_ID', `行 ID 重复：${id}`);
    seen.add(id);
    if (typeof row.value === 'string' && row.value.length > MAX_TEXT_LENGTH) {
      throw new ValidationError('TEXT_TOO_LONG', `行 ${id} 的数字文本超过 ${MAX_TEXT_LENGTH} 字符。`);
    }
    return { id, value: row.value };
  });
}

export function parseCsv(text: string): InputRecord[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new ValidationError('EMPTY_IMPORT', 'CSV 至少需要表头和一行数据。');
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const idIndex = header.indexOf('id');
  const valueIndex = header.indexOf('value');
  if (idIndex === -1 || valueIndex === -1) {
    throw new ValidationError('INVALID_CSV_HEADER', 'CSV 必须包含 id 和 value 两列。');
  }
  return normalizeRecords(rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== '')).map((row) => ({
    id: row[idIndex ?? 0] ?? '',
    value: row[valueIndex ?? 1] ?? ''
  })));
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (quoted) throw new ValidationError('INVALID_CSV', 'CSV 引号未闭合。');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export class ValidationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
