import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BenfordStore, ApiError } from "../src/db";
import { theoreticalProbability, binsForMode } from "../src/benford";

const DEMO = ["0", "-0.00450", "12e3", "9.99E-8", "5", "100.0"];

function memStore() {
  return new BenfordStore(":memory:");
}

function importRows(s: BenfordStore, values: string[], key = "k1") {
  return s.importDataset(
    "t",
    key,
    values.map((value, i) => ({ id: `r${i + 1}`, value })),
  );
}

test("演示数据集：N=5，首位 1 出现两次，4/5/9 各一次", () => {
  const s = memStore();
  const { datasetId } = importRows(s, DEMO);
  const { report } = s.createReport(datasetId, "first");
  assert.equal(report.n, 5);
  const obs = new Map(report.bins.map((b) => [b.bin, b.observed]));
  assert.equal(obs.get(1), 2);
  assert.equal(obs.get(4), 1);
  assert.equal(obs.get(5), 1);
  assert.equal(obs.get(9), 1);
  assert.equal([...obs.values()].reduce((a, b) => a + b, 0), 5);
  // 全部箱都输出
  assert.equal(report.bins.length, 9);
  s.close();
});

test("前两位模式：45、12、99、50、10", () => {
  const s = memStore();
  const { datasetId } = importRows(s, DEMO);
  const { report } = s.createReport(datasetId, "first_two");
  assert.equal(report.n, 5);
  const obs = new Map(report.bins.map((b) => [b.bin, b.observed]));
  for (const b of [45, 12, 99, 50, 10]) assert.equal(obs.get(b), 1, `bin ${b}`);
  assert.equal(report.bins.length, 90);
  s.close();
});

test("理论概率和在容差内为 1", () => {
  for (const mode of ["first", "first_two"] as const) {
    const sum = binsForMode(mode).reduce((a, d) => a + theoreticalProbability(d), 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, `${mode}: ${sum}`);
  }
});

test("加入非法文本与负零：rejected 与 excluded_zero 分开增加，N 不变", () => {
  const s = memStore();
  const v1 = importRows(s, DEMO, "k-evolve");
  const before = s.getDataset(v1.datasetId) as never as { valid_n: number };
  const v2 = importRows(s, [...DEMO, "1,000", "-0"], "k-evolve");
  assert.notEqual(v1.datasetId, v2.datasetId);
  assert.equal(v2.version, 2);
  const d2 = s.getDataset(v2.datasetId) as never as {
    valid_n: number; rejected_count: number; excluded_zero_count: number; total_rows: number;
  };
  assert.equal(d2.valid_n, before.valid_n);
  assert.equal(d2.rejected_count, 1);
  assert.equal(d2.excluded_zero_count, 2);
  assert.equal(d2.total_rows, 8);
  assert.equal(d2.valid_n + d2.rejected_count + d2.excluded_zero_count, d2.total_rows);
  const { report, partial } = s.createReport(v2.datasetId, "first");
  assert.equal(report.n, 5);
  assert.equal(partial, true);
  s.close();
});

test("幂等重试与重复行 ID", () => {
  const s = memStore();
  const a = importRows(s, DEMO, "k-idem");
  const b = importRows(s, DEMO, "k-idem");
  assert.equal(b.reused, true);
  assert.equal(a.datasetId, b.datasetId);
  assert.throws(
    () => importRows(s, ["1", "2"], "k-idem").datasetId && s.importDataset("t", "x", [{ id: "a", value: "1" }, { id: "a", value: "2" }]),
    (e: unknown) => e instanceof ApiError && (e as ApiError).code === "DUPLICATE_ROW_ID",
  );
  s.close();
});

test("手工核对卡方贡献与 MAD", () => {
  const s = memStore();
  const { datasetId } = importRows(s, DEMO);
  const { report } = s.createReport(datasetId, "first");
  let chi = 0;
  let mad = 0;
  for (const b of report.bins) {
    const e = 5 * b.theoretical;
    assert.ok(Math.abs(b.expected! - e) < 1e-12);
    const c = (b.observed - e) ** 2 / e;
    assert.ok(Math.abs(b.chiContribution! - c) < 1e-12);
    chi += c;
    mad += Math.abs(b.observed / 5 - b.theoretical);
  }
  assert.ok(Math.abs(report.chiSquare! - chi) < 1e-12);
  assert.ok(Math.abs(report.mad! - mad / 9) < 1e-12);
  // N=5 时所有箱期望数 < 5，应全部标注
  assert.ok(report.bins.every((b) => b.expectedBelowFive));
  s.close();
});

test("N=0（全零批次）：理论比例保留，频率与统计量为 null", () => {
  const s = memStore();
  const { datasetId } = importRows(s, ["0", "-0.0", "0e9"]);
  const { report } = s.createReport(datasetId, "first");
  assert.equal(report.n, 0);
  assert.equal(report.chiSquare, null);
  assert.equal(report.mad, null);
  assert.ok(report.bins.every((b) => b.frequency === null && b.observed === 0));
  assert.ok(Math.abs(report.theorySum - 1) < 1e-12);
  s.close();
});

test("单一有效样本", () => {
  const s = memStore();
  const { datasetId } = importRows(s, ["42"]);
  const { report } = s.createReport(datasetId, "first");
  assert.equal(report.n, 1);
  const bin4 = report.bins.find((b) => b.bin === 4)!;
  assert.equal(bin4.observed, 1);
  assert.equal(bin4.frequency, 1);
  s.close();
});

test("乘以 10 的整数次幂分布不变", () => {
  const s = memStore();
  const a = importRows(s, ["1.5", "250", "0.031"], "ka");
  const b = importRows(s, ["1.5e2", "2.50e4", "3.1e-4"], "kb");
  const ra = s.createReport(a.datasetId, "first_two").report;
  const rb = s.createReport(b.datasetId, "first_two").report;
  assert.deepEqual(
    ra.bins.map((x) => x.observed),
    rb.bins.map((x) => x.observed),
  );
  s.close();
});

test("按箱查询来源行", () => {
  const s = memStore();
  const { datasetId } = importRows(s, DEMO);
  const { reportId } = s.createReport(datasetId, "first");
  const r = s.rowsForBin(reportId, 1, 1, 50);
  assert.equal(r.total, 2);
  const ids = (r.items as { row_id: string }[]).map((x) => x.row_id).sort();
  assert.deepEqual(ids, ["r3", "r6"]);
  s.close();
});

test("重启后读取与冻结报告一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "benford-"));
  const dbPath = path.join(dir, "t.db");
  let s = new BenfordStore(dbPath);
  const { datasetId } = importRows(s, DEMO);
  const r1 = s.createReport(datasetId, "first");
  s.close();
  s = new BenfordStore(dbPath);
  const r2 = s.createReport(datasetId, "first");
  assert.equal(r2.reportId, r1.reportId);
  assert.deepEqual(r2.report, r1.report);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("文本不同但数值相等的两行是两个观测", () => {
  const s = memStore();
  const { datasetId } = importRows(s, ["1.0", "1.00", "1e0"]);
  const { report } = s.createReport(datasetId, "first");
  assert.equal(report.n, 3);
  s.close();
});
