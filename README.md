# Benford 首位有效数字提取与样本口径核验后端

离线、本地运行的 Benford 首位/前两位有效数字分布检查服务。仅提供 **API 与 CLI**，无前端。
技术栈：TypeScript + Node.js（内置 `node:http`、`node:sqlite`）+ SQLite，**零运行时第三方依赖**，
不需要 Docker / WSL / 外部在线服务。

## 适用前提与边界

- 只分析用户**显式导入**的数据；不连接银行、审计平台或任何外部样本源。
- Benford 分布适用于跨数量级、自然生成、非编号型的数值数据。
  样本量小、编号型数据（发票号、身份证）、人为取整/定价（如 9.99）都可能使
  理论基准**不适用**；期望数小于 5 的箱会被明确标注。
- 卡方统计量与 MAD 仅为**描述性偏差指标**：不计算 p 值、不设通过阈值、
  不生成风险标签，更不能据此认定造假。不会为"改善"分布而删除任何记录。
- 报告按 `(数据集, 口径)` 冻结保存，重启后读取结果一致。

## 核心口径

- **纯字符串提取**：从原始十进制文本提取有效数字，全程不转为 JavaScript Number，
  因此 `1e99999`、`2.5e309` 等超出双精度范围的值也能正确取首位。
- 接受：可选正负号、十进制小数（`.5`、`5.` 均可）、`e/E` 整数指数、前后空白。
  拒绝：千位分隔符、货币符号、`NaN`、`Infinity`、百分号、非字符串、空文本。
- 上限：文本 256 字符，指数数字 6 位，单次导入 100000 行，请求体 20MB。
- 符号不影响首位；**所有数值零**（含 `-0`、`0e5`）记为 `excluded_zero`，不计入 N，
  保留排除理由，不设"零箱"。
- 提取规则：尾数去小数点、跳过前导零，第一个非零字符即首位；指数只移动小数点。
  前两位模式不足两位时**右侧数学补零**（`5`、`0.005`、`5e300` 均为 50），
  原始有效位数（`rawPrecision`）单独记录，不声称输入有额外测量精度。
- 文本不同但数值相等的行是**两个观测**，不去重。行 ID 缺失或重复则**整体拒绝导入**。
- 非法文本逐行记为 `rejected`，不计入 N；含 rejected 行的数据集可生成标注
  `partial: true` 的部分有效报告。导入在单事务中完成，失败即整体回滚。
- 理论概率统一 `p(d) = log10(1 + 1/d)`；首位模式箱 1-9，前两位模式箱 10-99，
  观测为零的箱也会输出。N=0 时仍输出理论比例与零计数，频率/卡方/MAD 返回 `null`。
- 幂等：相同 `importKey` + 相同内容重试返回已有数据集；相同 key 不同内容生成新版本。
  来源列表分页不影响正式箱计数。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 仅安装开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（node:test）
npm start          # 启动 API（PORT 环境变量指定端口，默认自动选空闲端口）
npm run demo       # 内置演示（见下）
node dist/cli.js serve --port 8080
```

数据库文件默认在项目内 `data/benford.db`，可用环境变量 `BENFORD_DB` 覆盖。

## CLI

```
node dist/cli.js serve [--port N]
node dist/cli.js import --file data.json [--format csv] [--key k] [--name n]
node dist/cli.js datasets [--page N] [--pageSize N]
node dist/cli.js rows --dataset ID [--status valid|rejected|excluded_zero]
node dist/cli.js report --dataset ID [--mode first|first_two]
node dist/cli.js bins --report ID --bin N
node dist/cli.js compare --a ID --b ID [--mode first|first_two]
node dist/cli.js export --report ID [--format json|csv]
node dist/cli.js demo
```

JSON 导入文件格式：`{"rows": [{"id": "r1", "value": "12e3"}, ...]}`；
CSV 为两列 `id,value`（首行表头可省略）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/datasets` | JSON 或 CSV（`?format=csv`）导入；body 含 `name`/`importKey`/`rows` |
| GET | `/api/datasets?page=&pageSize=` | 数据集分页列表 |
| GET | `/api/datasets/:id` | 数据集状态计数 |
| GET | `/api/datasets/:id/rows?status=&page=` | 逐行规范化结果与数字来源 |
| POST | `/api/datasets/:id/reports` | 生成（或返回已冻结）报告，body `{"mode":"first"|"first_two"}` |
| GET | `/api/reports/:id` | 读取冻结报告 |
| GET | `/api/reports/:id/bins/:bin/rows` | 按箱查询来源行 |
| GET | `/api/datasets/:id/compare?other=:id2&mode=` | 比较两个样本版本 |
| GET | `/api/reports/:id/export?format=json|csv` | 导出报告 |

错误统一返回 `{"error": 错误码, "message": 说明}`，错误码包括
`DUPLICATE_ROW_ID`、`MISSING_ROW_ID`、`EMPTY_IMPORT`、`TOO_MANY_ROWS`、
`TEXT_TOO_LONG`、`INVALID_MODE`、`INVALID_STATUS`、`CSV_FORMAT`、`INVALID_JSON`、
`BODY_TOO_LARGE`、`DATASET_NOT_FOUND`、`REPORT_NOT_FOUND`、`NOT_FOUND`。

## 演示

`npm run demo` 依次执行：

1. 导入 `["0","-0.00450","12e3","9.99E-8","5","100.0"]`：有效 N=5，
   首位 `1` 出现两次（`12e3`、`100.0`），`4`、`5`、`9` 各一次；
   前两位为 `45、12、99、50、10`；`0` 记为 `excluded_zero`。
2. 同 key 追加一个非法文本 `1,000` 与一个负零 `-0` 生成 v2：
   `rejected` 与 `excluded_zero` 分别 +1，N 仍为 5。
3. 将全部合法非零值精确乘以 10 的整数次幂（字符串级指数调整）导入 v3 并比较：
   各箱频率差全为 0。注意：这只对 10 的整数次幂严格成立，
   **任意实数倍缩放对有限样本不保证分布不变**。

## 测试覆盖

`npm test`（21 个用例）覆盖：极小/极大指数（含超出双精度范围）、前导零、
小数点两侧缺一侧、尾零、空白、负号、重复行 ID、单一有效样本、全零批次（N=0）、
手工首位期望核对、理论概率和容差为 1、各箱 O 之和等于 N、状态计数总和等于输入行数、
逐箱卡方贡献与 MAD 复算、10 的幂缩放不变性、按箱来源核对、重启后冻结报告一致、
幂等重试、API 端到端（JSON/CSV 导入、报告、按箱查询、导出、比较、错误码）。

## 限制

- 单机本地服务，监听 `127.0.0.1`，无认证与多用户隔离。
- 卡方/MAD 为描述性统计量，未提供 p 值与显著性判定（有意为之）。
- CSV 解析为极简实现（两列、引号转义），不支持任意方言。
