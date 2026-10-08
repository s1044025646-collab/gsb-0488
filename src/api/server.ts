import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { binsForMode, type DigitMode, type ErrorBody } from '../core/constants.js';
import { normalizeRecords, parseCsv, ValidationError } from '../io/records.js';
import { BenfordStore, ValidationStoreError } from '../store/database.js';

const MAX_BODY_BYTES = 25_000_000;

export function createBenfordServer(dataDir = resolve('data')): { server: Server; store: BenfordStore } {
  const store = new BenfordStore(resolve(dataDir, 'benford.sqlite'));
  const server = createServer((request, response) => {
    handleRequest(request, response, store).catch((error: unknown) => sendError(response, error));
  });
  return { server, store };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, store: BenfordStore): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (request.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'datasets' && pathParts[3] === 'import') {
    const body = await readBody(request);
    const contentType = request.headers['content-type'] ?? 'application/json';
    const records = contentType.includes('text/csv') ? parseCsv(body) : parseJson(body);
    const result = store.importRecords(pathParts[2], records, url.searchParams.get('idempotency-key') ?? undefined);
    sendJson(response, 201, result);
    return;
  }

  if (request.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'compare') {
    const left = url.searchParams.get('left');
    const right = url.searchParams.get('right');
    if (!left || !right) throw new ValidationError('MISSING_VERSION_ID', '比较需要 left 和 right 两个 versionId。');
    sendJson(response, 200, store.compare(left, right));
    return;
  }

  if (pathParts[0] === 'api' && pathParts[1] === 'versions') {
    const versionId = pathParts[2];
    if (!versionId) throw new ValidationError('MISSING_VERSION_ID', '缺少 versionId。');

    if (request.method === 'GET' && pathParts[3] === 'rows') {
      const { limit, offset } = pagination(url);
      sendJson(response, 200, store.listRows(versionId, limit, offset));
      return;
    }
    if (request.method === 'GET' && pathParts[3] === 'reports') {
      const mode = parseMode(pathParts.slice(4, pathParts[5] === 'export' ? 5 : undefined).join('/'));
      const payload = store.getReport(versionId, mode);
      if (pathParts[5] === 'export' || pathParts[6] === 'export') sendCsv(response, payload.report, mode === 'first' ? 'first-report.csv' : 'first-two-report.csv');
      else sendJson(response, 200, payload);
      return;
    }
    if (request.method === 'GET' && pathParts[3] === 'bins' && pathParts[5] === 'sources') {
      const mode = parseMode(url.searchParams.get('mode') ?? 'first');
      const bin = Number(pathParts[4]);
      validateBin(mode, bin);
      const { limit, offset } = pagination(url);
      sendJson(response, 200, store.sources(versionId, mode, bin, limit, offset));
      return;
    }
  }

  throw new ValidationError('ROUTE_NOT_FOUND', '未找到 API 路由。');
}

function parseJson(body: string) {
  try { return normalizeRecords(JSON.parse(body) as unknown); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ValidationError('INVALID_JSON', '请求体不是合法 JSON。');
    throw error;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError('BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节。`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function pagination(url: URL): { limit: number; offset: number } {
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ValidationError('INVALID_LIMIT', 'limit 必须是 1 到 1000 的整数。');
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError('INVALID_OFFSET', 'offset 必须是非负整数。');
  return { limit, offset };
}

function parseMode(value: string | undefined): DigitMode {
  if (value === 'first' || value === 'first-two' || value === 'first_two') return value === 'first' ? 'first' : 'first_two';
  if (value === 'first/two') return 'first_two';
  throw new ValidationError('INVALID_MODE', '模式必须是 first 或 first-two。');
}

function validateBin(mode: DigitMode, bin: number): void {
  if (!binsForMode(mode).includes(bin)) throw new ValidationError('INVALID_BIN', '箱编号不在当前模式范围内。');
}

function sendCsv(response: ServerResponse, report: { bins: Array<{ bin: number; observed: number; frequency: number | null; probability: number; expected: number | null; difference: number | null; expectedBelowFive: boolean; chiSquareContribution: number | null }> }, filename: string): void {
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const header = 'bin,observed,frequency,probability,expected,difference,expectedBelowFive,chiSquareContribution';
  const lines = report.bins.map((bin) => [bin.bin, bin.observed, bin.frequency, bin.probability, bin.expected, bin.difference, bin.expectedBelowFive, bin.chiSquareContribution].map(csvCell).join(','));
  response.end([header, ...lines].join('\n'));
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, error: unknown): void {
  const body: ErrorBody = { error: { code: 'INTERNAL_ERROR', message: '服务器内部错误。' } };
  let status = 500;
  if (error instanceof ValidationError || error instanceof ValidationStoreError) {
    status = 400;
    body.error.code = error.code;
    body.error.message = error.message;
  }
  sendJson(response, status, body);
}
