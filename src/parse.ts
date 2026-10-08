/**
 * 数字文本解析与有效数字提取。
 * 全程不经过 JavaScript Number，避免上溢/下溢/舍入改变首位有效数字。
 */

export const MAX_TEXT_LENGTH = 256; // 原始文本最大字符数（含空白）
export const MAX_EXPONENT_DIGITS = 6; // 指数部分数字位数上限

export type RowStatus = "valid" | "excluded_zero" | "rejected";

export interface ParsedRow {
  status: RowStatus;
  /** 去掉前后空白后的文本（合法时） */
  normalized: string | null;
  /** 拒绝原因（status = rejected 时） */
  reason: string | null;
  /** 尾数去掉小数点与前导零后的有效数字串（全零时为空串） */
  significantDigits: string | null;
  /** 原始文本自身提供的有效位数（不含数学补零） */
  rawPrecision: number | null;
  /** 首位有效数字 1-9（valid 时） */
  firstDigit: number | null;
  /** 前两位有效数字 10-99，不足两位右侧补零（valid 时） */
  firstTwo: number | null;
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/;

export function parseNumericText(input: unknown): ParsedRow {
  const rejected = (reason: string): ParsedRow => ({
    status: "rejected",
    normalized: null,
    reason,
    significantDigits: null,
    rawPrecision: null,
    firstDigit: null,
    firstTwo: null,
  });

  if (typeof input !== "string") return rejected("值必须是字符串");
  if (input.length === 0) return rejected("空文本");
  if (input.length > MAX_TEXT_LENGTH)
    return rejected(`文本长度超过上限 ${MAX_TEXT_LENGTH}`);

  const trimmed = input.trim();
  if (trimmed.length === 0) return rejected("空白文本");

  const m = NUMBER_RE.exec(trimmed);
  if (!m) return rejected("不是合法的十进制数字文本");

  const expPart = m[1];
  if (expPart !== undefined) {
    const expDigits = expPart.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
    if (expDigits.length > MAX_EXPONENT_DIGITS)
      return rejected(`指数位数超过上限 ${MAX_EXPONENT_DIGITS}`);
  }

  // 去掉符号与指数，只保留尾数部分
  const mantissa = trimmed
    .replace(/^[+-]/, "")
    .replace(/[eE][+-]?\d+$/, "")
    .replace(".", "");
  // 跳过前导零，得到从第一个非零数字开始的有效数字串
  const sig = mantissa.replace(/^0+/, "");

  if (sig.length === 0) {
    // 所有数值零（含 -0、0e5、0.000）均排除出有效样本
    return {
      status: "excluded_zero",
      normalized: trimmed,
      reason: "数值为零，无首位有效数字",
      significantDigits: "",
      rawPrecision: 0,
      firstDigit: null,
      firstTwo: null,
    };
  }

  const firstDigit = Number(sig[0]);
  const firstTwo =
    sig.length >= 2 ? Number(sig.slice(0, 2)) : Number(sig[0] + "0");

  return {
    status: "valid",
    normalized: trimmed,
    reason: null,
    significantDigits: sig,
    rawPrecision: sig.length,
    firstDigit,
    firstTwo,
  };
}
