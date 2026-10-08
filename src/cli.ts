/** 命令行入口：导入、报告、逐行查看、按箱查询、版本比较、导出、演示。 */
import * as fs from "node:fs";
import { BenfordStore } from "./db";
import { parseCsv, toCsv } from "./csv";
import { createServer, listen, defaultDbPath } from "./server";
import { Mode } from "./benford";

function store(): BenfordStore {
  return new BenfordStore(defaultDbPath());
}

function argMap(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        m.set(key, next);
        i++;
      } else {
        m.set(key, "true");
      }
    }
  }
  return m;
}

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function parseMode(v: string | undefined): Mode {
  if (v === "first" || v === undefined) return "first";
  if (v === "first_two") return "first_two";
  throw new Error("--mode 必须是 first 或 first_two");
}

function demo(s: BenfordStore): void {
  const base = ["0", "-0.00450", "12e3", "9.99E-8", "5", "100.0"];
  const key = `demo-${Date.now()}`;
  const v1 = s.importDataset(
    "demo-v1",
    key,
    base.map((value, i) => ({ id: `r${i + 1}`, value })),
  );
  console.log("== 演示数据集 v1 ==");
  print(s.getDataset(v1.datasetId));
  console.log("== 首位模式报告 ==");
  const r1 = s.createReport(v1.datasetId, "first");
  print(r1.report);
  console.log("== 前两位模式报告 ==");
  const r2 = s.createReport(v1.datasetId, "first_two");
  print(r2.report);

  const v2rows = [
    ...base.map((value, i) => ({ id: `r${i + 1}`, value })),
    { id: "r7", value: "1,000" },
    { id: "r8", value: "-0" },
  ];
  const v2 = s.importDataset("demo-v2", key, v2rows);
  console.log("== 加入非法文本与负零后的 v2（rejected 与 excluded_zero 分开计数，N 不变） ==");
  print(s.getDataset(v2.datasetId));

  // 将所有合法非零值精确乘以 10 的整数次幂（只做字符串级指数调整）
  const scaleByPowerOfTen = (v: string, k: number): string => {
    const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:[eE]([+-]?\d+))?$/.exec(v.trim());
    if (!m) return v;
    const mantissa = m[1];
    if (/^[+-]?0*(?:\.0*)?$/.test(mantissa)) return v;
    const exp = (m[2] ? parseInt(m[2], 10) : 0) + k;
    return `${mantissa}e${exp}`;
  };
  const scaled = base.map((v, i) => ({
    id: `s${i + 1}`,
    value: scaleByPowerOfTen(v, (i % 3) + 1),
  }));
  const v3 = s.importDataset("demo-v3-scaled", `${key}-scaled`, scaled);
  console.log("== 全部合法非零值乘以 10 的整数次幂后的分布对比（应不变） ==");
  print(s.compare(v1.datasetId, v3.datasetId, "first"));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = argMap(rest);
  const s = store();
  try {
    switch (cmd) {
      case "serve": {
        const server = createServer(s);
        const port = await listen(server, Number(opts.get("port") ?? "0"));
        console.log(`Benford API 已启动: http://127.0.0.1:${port}`);
        return;
      }
      case "import": {
        const file = opts.get("file");
        const key = opts.get("key") ?? `cli-${Date.now()}`;
        const name = opts.get("name") ?? key;
        if (!file) throw new Error("缺少 --file");
        const text = fs.readFileSync(file, "utf8");
        const rows = (opts.get("format") ?? "").toLowerCase() === "csv" || file.endsWith(".csv")
          ? parseCsv(text)
          : (JSON.parse(text) as { rows: { id: string; value: string }[] }).rows;
        print(s.importDataset(name, key, rows));
        break;
      }
      case "datasets":
        print(s.listDatasets(Number(opts.get("page") ?? 1), Number(opts.get("pageSize") ?? 50)));
        break;
      case "rows": {
        const id = Number(opts.get("dataset"));
        print(s.listRows(id, opts.get("status") ?? null, Number(opts.get("page") ?? 1), Number(opts.get("pageSize") ?? 50)));
        break;
      }
      case "report": {
        const id = Number(opts.get("dataset"));
        print(s.createReport(id, parseMode(opts.get("mode"))));
        break;
      }
      case "bins": {
        const reportId = Number(opts.get("report"));
        const bin = Number(opts.get("bin"));
        print(s.rowsForBin(reportId, bin, Number(opts.get("page") ?? 1), Number(opts.get("pageSize") ?? 50)));
        break;
      }
      case "compare": {
        const a = Number(opts.get("a"));
        const b = Number(opts.get("b"));
        print(s.compare(a, b, parseMode(opts.get("mode"))));
        break;
      }
      case "export": {
        const reportId = Number(opts.get("report"));
        const r = s.getReport(reportId);
        if ((opts.get("format") ?? "json") === "csv") {
          console.log(toCsv(r.report.bins as unknown as Record<string, unknown>[], [
            "bin", "observed", "frequency", "theoretical", "expected",
            "difference", "expectedBelowFive", "chiContribution",
          ]));
        } else {
          print(r);
        }
        break;
      }
      case "demo":
        demo(s);
        break;
      default:
        console.log(`用法: node dist/cli.js <命令> [选项]
命令:
  serve [--port N]                 启动 API 服务（默认自动选空闲端口）
  import --file f [--format csv] [--key k] [--name n]
  datasets [--page N] [--pageSize N]
  rows --dataset ID [--status valid|rejected|excluded_zero]
  report --dataset ID [--mode first|first_two]
  bins --report ID --bin N
  compare --a ID --b ID [--mode first|first_two]
  export --report ID [--format json|csv]
  demo                             运行内置演示`);
    }
  } finally {
    if (cmd !== "serve") s.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
