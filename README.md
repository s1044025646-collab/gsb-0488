# Benford 首位有效数字核验后端

这是一个 Windows 本地运行的 TypeScript / Node.js / SQLite 后端，只提供 API 与 CLI。它用于分析用户显式导入的离线十进制字符串，生成 Benford 首位或前两位有效数字分布。

## 适用边界

- 只分析用户通过 JSON 或 CSV 明确提交的数据，不连接银行、审计平台或外部样本。
- 输出卡方统计量与 MAD 仅作描述性偏差，不计算 p 值，不设置自动造假阈值。
- 卡方较大、MAD 较大或期望数小于 5 都不能单独构成审计结论。
- 编号、电话、人为取整、受上下限约束的数据，或样本量过小，均可能不适合 Benford 基准。
- 不得为改善拟合结果删除合法记录；文本不同但数值相等的两行仍是两个观测，默认不去重。

## 数字口径

- 接受可选正负号、十进制小数和 `e/E` 整数指数，至少包含一个数字。
- 接受行首行尾 ASCII 空白；不接受千位分隔符、货币符号、百分号、`NaN`、`Infinity`。
- 上限：单次 100,000 行；单条文本 1,000 字符；指数位数 6 位。
- 实现直接处理字符串，不先转为 JavaScript `Number`，因此上限内的超大或超小指数不会因上溢、下溢或舍入改变首位。
- 处理方式：移除尾数小数点并跳过前导零，第一位非零字符即首位有效数字。
- 前两位模式只有一位有效数字时右侧数学补零：`5`、`0.005`、`5e300` 的前两位均为 50；原始精度单独记录。
- 合法零（含 `0`、`-0`、`-0e12`）记为 `excluded_zero`，不计入 N，也不进入理论箱。
- 非法文本记为 `rejected`，不计入 N；有 rejected 时报告标记为部分有效报告。
- 行 ID 缺失或重复会整体拒绝导入，数据库事务回滚，不发布半个数据集。

理论概率统一为：

```text
p(d) = log10(1 + 1/d)
```

首位箱为 1-9；前两位箱为 10-99。每箱输出观测数 `O`、频率 `O/N`、理论概率、期望数 `N*p`、差值、期望数是否小于 5、卡方贡献。N=0 时仍输出全部箱和理论概率，但频率、期望数、差值、卡方和 MAD 为 `null`。

## 环境要求

- Windows PowerShell
- Node.js 25（本项目使用 Node 内置 `node:sqlite`，无需 Docker、WSL、原生编译或在线服务）
- npm

## 构建、测试、启动、演示

```powershell
npm install
npm run build
npm test
$env:BENFORD_DATA_DIR="data"
npm start
npm run demo
```

固定端口：

```powershell
npm start -- --port 3000
```

不传 `--port` 且未设置 `PORT` 时，服务自动选择空闲端口。SQLite 文件默认位于项目内 `data/benford.sqlite`。

## JSON 导入

```powershell
$body = @'
[
  {"id":"r1","value":"0"},
  {"id":"r2","value":"-0.00450"},
  {"id":"r3","value":"12e3"},
  {"id":"r4","value":"9.99E-8"},
  {"id":"r5","value":"5"},
  {"id":"r6","value":"100.0"}
]
'@
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/datasets/demo/import?idempotency-key=demo-1" -ContentType "application/json" -Body $body
```

同一幂等键重放返回同一版本，不重复加样本。对同一 `datasetId` 提交新数据会生成新版本，旧版本和冻结报告保留。

## CSV 导入

CSV 必须包含 `id,value` 表头：

```csv
id,value
r1,0
r2,-0.00450
r3,12e3
```

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/datasets/demo/import" -ContentType "text/csv" -InFile ".\sample.csv"
```

## API

- `POST /api/datasets/:datasetId/import?idempotency-key=...`：JSON 或 CSV 导入。
- `GET /api/versions/:versionId/reports/first`：首位冻结报告。
- `GET /api/versions/:versionId/reports/first-two`：前两位冻结报告。
- `GET /api/versions/:versionId/reports/first/export`：导出报告 CSV。
- `GET /api/versions/:versionId/rows?limit=100&offset=0`：分页查看逐行原始字符串、规范化结果、状态、精度、有效数字和来源。
- `GET /api/versions/:versionId/bins/:bin/sources?mode=first`：分页查询某箱的原始有效行。
- `GET /api/versions/:versionId/bins/:bin/sources?mode=first-two`：查询前两位箱来源。
- `GET /api/compare?left=VERSION_ID&right=VERSION_ID`：比较两个冻结版本。

分页只影响返回列表，不改变正式箱计数。

## CLI

```powershell
node dist/cli.js import --dataset demo --file sample.json --idempotency-key demo-1
node dist/cli.js report --version VERSION_ID --mode first
node dist/cli.js report --version VERSION_ID --mode first-two
node dist/cli.js rows --version VERSION_ID --limit 100 --offset 0
node dist/cli.js sources --version VERSION_ID --mode first --bin 1
node dist/cli.js compare --left VERSION_A --right VERSION_B
node dist/cli.js export --version VERSION_ID --output report.json
```

也可在构建后使用 `npx benford ...`。

## 固定演示

演示输入：

```json
["0", "-0.00450", "12e3", "9.99E-8", "5", "100.0"]
```

有效非零 N=5：

- 首位：1 出现 2 次，4、5、9 各 1 次。
- 前两位：45、12、99、50、10 各 1 次。

随后加入非法文本 `1,234` 和负零 `-0e12`：`rejected` 与 `excluded_zero` 分开增加，原 N=5 不变。演示还会把合法非零值乘 `10^10`，验证整数十的幂只移动小数点、不改变有效数字分布。该结论不能推广为任意实数倍缩放在有限样本下必然不变。

## 错误码

常见错误码包括：`INVALID_RECORDS_SHAPE`、`MISSING_ROW_ID`、`DUPLICATE_ROW_ID`、`TOO_MANY_ROWS`、`TEXT_TOO_LONG`、`INVALID_DECIMAL_TEXT`、`NON_FINITE_LITERAL`、`THOUSANDS_SEPARATOR_NOT_ALLOWED`、`CURRENCY_SYMBOL_NOT_ALLOWED`、`PERCENT_NOT_ALLOWED`、`EXPONENT_TOO_MANY_DIGITS`、`INVALID_MODE`、`INVALID_BIN`、`VERSION_NOT_FOUND`。
