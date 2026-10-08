import { binsForMode, type DigitMode } from './constants.js';

export interface AnalysisRow {
  status: 'valid' | 'rejected' | 'excluded_zero';
  firstDigit: number | null;
  firstTwo: number | null;
}

export interface BinStatistic {
  bin: number;
  observed: number;
  frequency: number | null;
  probability: number;
  expected: number | null;
  difference: number | null;
  expectedBelowFive: boolean;
  chiSquareContribution: number | null;
}

export interface Report {
  mode: DigitMode;
  totalRows: number;
  validCount: number;
  rejectedCount: number;
  excludedZeroCount: number;
  bins: BinStatistic[];
  chiSquare: number | null;
  mad: number | null;
  partialValidData: boolean;
  caveats: string[];
}

export function theoreticalProbability(bin: number): number {
  return Math.log10(1 + 1 / bin);
}

export function buildReport(rows: AnalysisRow[], totalRows: number, mode: DigitMode): Report {
  const validRows = rows.filter((row) => row.status === 'valid');
  const rejectedCount = rows.filter((row) => row.status === 'rejected').length;
  const excludedZeroCount = rows.filter((row) => row.status === 'excluded_zero').length;
  const n = validRows.length;
  const counts = new Map<number, number>();

  for (const row of validRows) {
    const bin = mode === 'first' ? row.firstDigit : row.firstTwo;
    if (bin === null) continue;
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }

  let chiSquare = 0;
  let absoluteFrequencyDifferenceSum = 0;
  const bins = binsForMode(mode).map((bin) => {
    const observed = counts.get(bin) ?? 0;
    const probability = theoreticalProbability(bin);
    const expected = n === 0 ? null : n * probability;
    const frequency = n === 0 ? null : observed / n;
    const difference = frequency === null || expected === null ? null : observed - expected;
    const contribution = expected === null || expected === 0 ? null : Math.pow(observed - expected, 2) / expected;
    if (contribution !== null) chiSquare += contribution;
    if (frequency !== null) absoluteFrequencyDifferenceSum += Math.abs(frequency - probability);
    return {
      bin,
      observed,
      frequency,
      probability,
      expected,
      difference,
      expectedBelowFive: expected !== null && expected < 5,
      chiSquareContribution: contribution
    };
  });

  const binCount = bins.length;
  return {
    mode,
    totalRows,
    validCount: n,
    rejectedCount,
    excludedZeroCount,
    bins,
    chiSquare: n === 0 ? null : chiSquare,
    mad: n === 0 ? null : absoluteFrequencyDifferenceSum / binCount,
    partialValidData: rejectedCount > 0,
    caveats: buildCaveats(n, rejectedCount, bins)
  };
}

function buildCaveats(n: number, rejectedCount: number, bins: BinStatistic[]): string[] {
  const caveats = [
    '卡方统计量与 MAD 仅为描述性偏差，不计算 p 值，不自动产生造假或审计风险结论。',
    '编号型数据、人为取整、带有上下限的数据或样本量不足时，Benford 理论比例可能不适用。',
    '不得为改善拟合结果删除合法观测。'
  ];
  if (n === 0) caveats.push('有效非零样本 N=0；频率、期望数、差值和偏差统计量均为 null。');
  if (rejectedCount > 0) caveats.push('存在 rejected 行；报告是明确标注的部分有效报告，rejected 不计入 N。');
  if (bins.some((bin) => bin.expectedBelowFive)) caveats.push('存在期望数小于 5 的箱，卡方基准的稳定性可能不足。');
  return caveats;
}
