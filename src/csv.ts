/** 极简 CSV 解析：两列 id,value，支持引号与转义。 */
import { ImportRowInput, ApiError } from "./db";

export function parseCsv(text: string): ImportRowInput[] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    if (record.length > 0) rows.push(record);
    record = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushField();
      pushRecord();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  pushField();
  pushRecord();

  const out: ImportRowInput[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    if (r.length === 1 && r[0].trim() === "") continue;
    // 跳过表头
    if (idx === 0 && r.length >= 2 && /^id$/i.test(r[0].trim())) continue;
    if (r.length !== 2)
      throw new ApiError(
        "CSV_FORMAT",
        `CSV 第 ${idx + 1} 行应有 2 列 (id,value)，实际 ${r.length} 列`,
      );
    out.push({ id: r[0].trim(), value: r[1] });
  }
  return out;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(","));
  return lines.join("\r\n");
}
