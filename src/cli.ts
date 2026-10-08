#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { binsForMode } from './core/constants.js';
import { normalizeRecords, parseCsv } from './io/records.js';
import { BenfordStore } from './store/database.js';

const [command, ...rest] = process.argv.slice(2);
const options = parseOptions(rest);
const dataDir = options['data-dir'] ?? 'data';
const store = new BenfordStore(resolve(dataDir, 'benford.sqlite'));

try {
  if (command === 'import') runImport();
  else if (command === 'report') runReport();
  else if (command === 'rows') runRows();
  else if (command === 'sources') runSources();
  else if (command === 'compare') runCompare();
  else if (command === 'export') runExport();
  else usage();
} finally {
  store.close();
}

function runImport(): void {
  const filename = required(options.file, '--file');
  const text = readFileSync(filename, 'utf8');
  const format = options.format ?? (filename.toLowerCase().endsWith('.csv') ? 'csv' : 'json');
  const records = format === 'csv' ? parseCsv(text) : normalizeRecords(JSON.parse(text) as unknown);
  const result = store.importRecords(options.dataset, records, options['idempotency-key']);
  print(result);
}

function runReport(): void {
  const mode = modeOption(options.mode ?? 'first');
  print(store.getReport(required(options.version, '--version'), mode));
}

function runRows(): void {
  print(store.listRows(required(options.version, '--version'), limit(), offset()));
}

function runSources(): void {
  const mode = modeOption(options.mode ?? 'first');
  const bin = Number(required(options.bin, '--bin'));
  if (!binsForMode(mode).includes(bin)) throw new Error('箱编号不在当前模式范围内。');
  print(store.sources(required(options.version, '--version'), mode, bin, limit(), offset()));
}

function runCompare(): void {
  print(store.compare(required(options.left, '--left'), required(options.right, '--right')));
}

function runExport(): void {
  const mode = modeOption(options.mode ?? 'first');
  const { report } = store.getReport(required(options.version, '--version'), mode);
  const output = required(options.output, '--output');
  writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(`已导出：${output}`);
}

function modeOption(value: string): 'first' | 'first_two' {
  if (value === 'first' || value === 'first-two') return value === 'first' ? 'first' : 'first_two';
  throw new Error('--mode 必须是 first 或 first-two。');
}

function limit(): number {
  const value = Number(options.limit ?? '100');
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error('--limit 必须是 1 到 1000。');
  return value;
}

function offset(): number {
  const value = Number(options.offset ?? '0');
  if (!Number.isInteger(value) || value < 0) throw new Error('--offset 必须是非负整数。');
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}

function parseOptions(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = 'true';
    }
  }
  return result;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`用法：
  benford import --dataset demo --file data.json [--format json|csv] [--idempotency-key key]
  benford report --version VERSION_ID [--mode first|first-two]
  benford rows --version VERSION_ID [--limit 100] [--offset 0]
  benford sources --version VERSION_ID --bin 1 [--mode first]
  benford compare --left VERSION_ID --right VERSION_ID
  benford export --version VERSION_ID --output report.json`);
  process.exit(2);
}
