import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumericText, MAX_EXPONENT_DIGITS } from "../src/parse";

test("基本提取：整数、小数、负号、空白", () => {
  assert.equal(parseNumericText("123").firstDigit, 1);
  assert.equal(parseNumericText("  -0.00450 ").firstDigit, 4);
  assert.equal(parseNumericText("  -0.00450 ").normalized, "-0.00450");
  assert.equal(parseNumericText("12e3").firstDigit, 1);
  assert.equal(parseNumericText("9.99E-8").firstDigit, 9);
  assert.equal(parseNumericText("100.0").firstDigit, 1);
});

test("前两位：不足两位右侧补零，原始精度分开记录", () => {
  assert.equal(parseNumericText("5").firstTwo, 50);
  assert.equal(parseNumericText("0.005").firstTwo, 50);
  assert.equal(parseNumericText("5e300").firstTwo, 50);
  assert.equal(parseNumericText("5").rawPrecision, 1);
  assert.equal(parseNumericText("-0.00450").firstTwo, 45);
  assert.equal(parseNumericText("-0.00450").rawPrecision, 3);
  assert.equal(parseNumericText("12e3").firstTwo, 12);
  assert.equal(parseNumericText("9.99E-8").firstTwo, 99);
  assert.equal(parseNumericText("100.0").firstTwo, 10);
});

test("指数只移动小数点，不改变有效数字起点；超出双精度范围也可提取", () => {
  assert.equal(parseNumericText("1e99999").firstDigit, 1);
  assert.equal(parseNumericText("7e-99999").firstDigit, 7);
  assert.equal(parseNumericText("2.5e308").firstDigit, 2);
  assert.equal(parseNumericText("2.5e309").firstDigit, 2);
  assert.equal(parseNumericText("1e-400").firstDigit, 1);
});

test("小数点两侧可缺一侧", () => {
  assert.equal(parseNumericText(".5").firstDigit, 5);
  assert.equal(parseNumericText("5.").firstDigit, 5);
  assert.equal(parseNumericText(".").status, "rejected");
});

test("所有数值零排除：负零、带指数的零", () => {
  for (const z of ["0", "-0", "+0.0", "0e5", "-0.000e-3", "0.000"]) {
    const p = parseNumericText(z);
    assert.equal(p.status, "excluded_zero", z);
    assert.equal(p.firstDigit, null);
  }
});

test("非法文本：千分位、货币、NaN、Infinity、百分号、空、超长指数", () => {
  for (const bad of ["1,000", "$5", "NaN", "Infinity", "-Infinity", "50%", "", "abc", "1e", "e5", "--1", "1.2.3"]) {
    assert.equal(parseNumericText(bad).status, "rejected", bad);
  }
  const longExp = `1e${"9".repeat(MAX_EXPONENT_DIGITS + 1)}`;
  assert.equal(parseNumericText(longExp).status, "rejected");
  assert.equal(parseNumericText("x".repeat(300)).status, "rejected");
  assert.equal(parseNumericText(123 as unknown as string).status, "rejected");
});

test("尾零与前导零", () => {
  const p = parseNumericText("0.0012300");
  assert.equal(p.significantDigits, "12300");
  assert.equal(p.firstDigit, 1);
  assert.equal(p.firstTwo, 12);
  assert.equal(p.rawPrecision, 5);
});
