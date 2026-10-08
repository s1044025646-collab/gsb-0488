/** HTTP API 服务（node:http，无外部依赖）。 */
import * as http from "node:http";
import * as path from "node:path";
import { BenfordStore, ApiError, ImportRowInput } from "./db";
import { parseCsv, toCsv } from "./csv";
import { Mode } from "./benford";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

function parseMode(v: string | null): Mode {
  if (v === "first" || v === "first_two") return v;
  throw new ApiError("INVALID_MODE", "mode 必须是 first 或 first_two");
}

function parsePaging(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    1000,
    Math.max(1, Number(url.searchParams.get("pageSize") ?? "50") || 50),
  );
  return { page, pageSize };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES)
      throw new ApiError("BODY_TOO_LARGE", "请求体超过大小限制", 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createServer(store: BenfordStore): http.Server {
  const send = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    contentType = "application/json; charset=utf-8",
  ) => {
    const payload =
      typeof body === "string" ? body : JSON.stringify(body, null, 2);
    res.writeHead(status, { "content-type": contentType });
    res.end(payload);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (route === "/api/health" && method === "GET") {
        return send(res, 200, { ok: true });
      }

      if (route === "/api/datasets" && method === "POST") {
        const body = (await readBody(req)).toString("utf8");
        const ct = req.headers["content-type"] ?? "";
        let name: string;
        let importKey: string;
        let rows: ImportRowInput[];
        if (ct.includes("text/csv") || url.searchParams.get("format") === "csv") {
          name = url.searchParams.get("name") ?? "csv-import";
          importKey = url.searchParams.get("importKey") ?? `csv-${Date.now()}`;
          rows = parseCsv(body);
        } else {
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(body);
          } catch {
            throw new ApiError("INVALID_JSON", "请求体不是合法 JSON");
          }
          name = typeof json.name === "string" ? json.name : "json-import";
          importKey =
            typeof json.importKey === "string"
              ? json.importKey
              : `json-${Date.now()}`;
          rows = json.rows as ImportRowInput[];
        }
        const result = store.importDataset(name, importKey, rows);
        const dataset = store.getDataset(result.datasetId);
        return send(res, result.reused ? 200 : 201, { ...result, dataset });
      }

      if (route === "/api/datasets" && method === "GET") {
        const { page, pageSize } = parsePaging(url);
        return send(res, 200, store.listDatasets(page, pageSize));
      }

      let m = /^\/api\/datasets\/(\d+)$/.exec(route);
      if (m && method === "GET") {
        return send(res, 200, store.getDataset(Number(m[1])));
      }

      m = /^\/api\/datasets\/(\d+)\/rows$/.exec(route);
      if (m && method === "GET") {
        const { page, pageSize } = parsePaging(url);
        const status = url.searchParams.get("status");
        if (status && !["valid", "rejected", "excluded_zero"].includes(status))
          throw new ApiError("INVALID_STATUS", "非法的 status 过滤值");
        return send(
          res,
          200,
          store.listRows(Number(m[1]), status, page, pageSize),
        );
      }

      m = /^\/api\/datasets\/(\d+)\/reports$/.exec(route);
      if (m && method === "POST") {
        const body = (await readBody(req)).toString("utf8");
        const json = body ? JSON.parse(body) : {};
        const mode = parseMode(json.mode ?? url.searchParams.get("mode"));
        return send(res, 201, store.createReport(Number(m[1]), mode));
      }

      m = /^\/api\/datasets\/(\d+)\/compare$/.exec(route);
      if (m && method === "GET") {
        const other = Number(url.searchParams.get("other"));
        if (!Number.isInteger(other) || other <= 0)
          throw new ApiError("INVALID_PARAM", "缺少合法的 other 数据集 ID");
        const mode = parseMode(url.searchParams.get("mode") ?? "first");
        return send(res, 200, store.compare(Number(m[1]), other, mode));
      }

      m = /^\/api\/reports\/(\d+)$/.exec(route);
      if (m && method === "GET") {
        return send(res, 200, store.getReport(Number(m[1])));
      }

      m = /^\/api\/reports\/(\d+)\/bins\/(\d+)\/rows$/.exec(route);
      if (m && method === "GET") {
        const { page, pageSize } = parsePaging(url);
        return send(
          res,
          200,
          store.rowsForBin(Number(m[1]), Number(m[2]), page, pageSize),
        );
      }

      m = /^\/api\/reports\/(\d+)\/export$/.exec(route);
      if (m && method === "GET") {
        const report = store.getReport(Number(m[1]));
        const format = url.searchParams.get("format") ?? "json";
        if (format === "csv") {
          const csv = toCsv(
            report.report.bins as unknown as Record<string, unknown>[],
            [
              "bin",
              "observed",
              "frequency",
              "theoretical",
              "expected",
              "difference",
              "expectedBelowFive",
              "chiContribution",
            ],
          );
          return send(res, 200, csv, "text/csv; charset=utf-8");
        }
        return send(res, 200, report);
      }

      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${route}`, 404);
    } catch (err) {
      if (err instanceof ApiError) {
        return send(res, err.httpStatus, { error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      return send(res, 500, { error: "INTERNAL", message });
    }
  });
}

/** 监听指定端口；端口为 0 或未指定时由系统分配空闲端口。 */
export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

export function defaultDbPath(): string {
  return process.env.BENFORD_DB ?? path.join(process.cwd(), "data", "benford.db");
}

if (require.main === module) {
  const store = new BenfordStore(defaultDbPath());
  const server = createServer(store);
  const requested = Number(process.env.PORT ?? "0");
  listen(server, requested).then((port) => {
    console.log(`Benford API 已启动: http://127.0.0.1:${port}`);
    console.log(`数据库: ${defaultDbPath()}`);
  });
}
