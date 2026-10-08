import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BenfordStore } from "../src/db";
import { createServer, listen } from "../src/server";

let base = "";
let server: ReturnType<typeof createServer>;
let store: BenfordStore;

before(async () => {
  store = new BenfordStore(":memory:");
  server = createServer(store);
  const port = await listen(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  store.close();
});

test("API：JSON 导入 -> 报告 -> 按箱查询 -> 导出 -> 比较", async () => {
  const rows = ["0", "-0.00450", "12e3", "9.99E-8", "5", "100.0"].map((value, i) => ({
    id: `r${i + 1}`,
    value,
  }));
  let res = await fetch(`${base}/api/datasets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "api-demo", importKey: "api-k1", rows }),
  });
  assert.equal(res.status, 201);
  const imported = (await res.json()) as { datasetId: number };

  // 幂等重试
  res = await fetch(`${base}/api/datasets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "api-demo", importKey: "api-k1", rows }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${base}/api/datasets/${imported.datasetId}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "first" }),
  });
  assert.equal(res.status, 201);
  const rep = (await res.json()) as { reportId: number; report: { n: number } };
  assert.equal(rep.report.n, 5);

  res = await fetch(`${base}/api/reports/${rep.reportId}/bins/1/rows`);
  const binRows = (await res.json()) as { total: number };
  assert.equal(binRows.total, 2);

  res = await fetch(`${base}/api/reports/${rep.reportId}/export?format=csv`);
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.ok(csv.startsWith("bin,observed,frequency"));

  res = await fetch(
    `${base}/api/datasets/${imported.datasetId}/compare?other=${imported.datasetId}&mode=first`,
  );
  assert.equal(res.status, 200);

  res = await fetch(`${base}/api/datasets/${imported.datasetId}/rows?status=excluded_zero`);
  const zeros = (await res.json()) as { total: number };
  assert.equal(zeros.total, 1);
});

test("API：CSV 导入与错误码", async () => {
  const res = await fetch(`${base}/api/datasets?format=csv&importKey=csv-k1`, {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: "id,value\na,1.5\nb,250\n",
  });
  assert.equal(res.status, 201);

  const dup = await fetch(`${base}/api/datasets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      importKey: "dup",
      rows: [
        { id: "x", value: "1" },
        { id: "x", value: "2" },
      ],
    }),
  });
  assert.equal(dup.status, 400);
  const err = (await dup.json()) as { error: string };
  assert.equal(err.error, "DUPLICATE_ROW_ID");

  const notFound = await fetch(`${base}/api/datasets/99999`);
  assert.equal(notFound.status, 404);

  const badMode = await fetch(`${base}/api/datasets/1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "third" }),
  });
  assert.equal(badMode.status, 400);
});
