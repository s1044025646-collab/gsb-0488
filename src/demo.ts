import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { BenfordStore } from './store/database.js';
import type { InputRecord } from './io/records.js';

const demoDir = resolve('data/demo');
rmSync(demoDir, { recursive: true, force: true });
const store = new BenfordStore(resolve(demoDir, 'benford.sqlite'));

const base: InputRecord[] = ['0', '-0.00450', '12e3', '9.99E-8', '5', '100.0']
  .map((value, index) => ({ id: `r${index + 1}`, value }));
const first = store.importRecords('demo', base, 'demo-v1');

const changed: InputRecord[] = [
  ...base,
  { id: 'bad-1', value: '1,234' },
  { id: 'neg-zero', value: '-0e12' },
  { id: 'power-ten', value: '0.005' }
];
const second = store.importRecords('demo', changed, 'demo-v2');

const powersOfTen: InputRecord[] = base
  .filter((item) => item.id !== 'r1')
  .map((item) => ({ id: item.id, value: multiplyByPowerOfTen(String(item.value), 10) }));
const scaled = store.importRecords('demo', powersOfTen, 'demo-v3');

console.log(JSON.stringify({
  base: summarize(first),
  afterRejectedAndNegativeZero: summarize(second),
  integerPowerOfTenScale: summarize(scaled),
  note: '精确乘 10 的整数次幂只移动小数点，不改变有效数字起始；任意实数倍缩放不保证有限样本分布不变。'
}, null, 2));
store.close();

function summarize(result: ReturnType<BenfordStore['importRecords']>) {
  const firstBins = new Map(result.reports.first.bins.filter((bin) => bin.observed > 0).map((bin) => [bin.bin, bin.observed]));
  const twoBins = new Map(result.reports.first_two.bins.filter((bin) => bin.observed > 0).map((bin) => [bin.bin, bin.observed]));
  return {
    versionId: result.versionId,
    N: result.reports.first.validCount,
    rejected: result.reports.first.rejectedCount,
    excludedZero: result.reports.first.excludedZeroCount,
    firstDigitCounts: Object.fromEntries(firstBins),
    firstTwoCounts: Object.fromEntries(twoBins),
    chiSquare: result.reports.first.chiSquare,
    mad: result.reports.first.mad
  };
}

function multiplyByPowerOfTen(value: string, increment: number): string {
  const match = /^([^eE]+)(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return value;
  const mantissa = match[1];
  const exponent = match[2] === undefined ? increment : Number(match[2]) + increment;
  return `${mantissa}e${exponent}`;
}
