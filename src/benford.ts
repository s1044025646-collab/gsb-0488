/** Benford 理论分布与描述性偏差统计量。 */

export type Mode = "first" | "first_two";

export function binsForMode(mode: Mode): number[] {
  if (mode === "first") {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9];
  }
  const bins: number[] = [];
  for (let d = 10; d <= 99; d++) bins.push(d);
  return bins;
}

/** p(d) = log10(1 + 1/d) */
export function theoreticalProbability(d: number): number {
  return Math.log10(1 + 1 / d);
}

export interface BinStat {
  bin: number;
  observed: number;
  /** N = 0 时为 null */
  frequency: number | null;
  theoretical: number;
  /** N * p；N = 0 时为 0 */
  expected: number;
  /** O - E；N = 0 时为 null */
  difference: number | null;
  /** 期望数 < 5 时标注：卡方基准可能不适用 */
  expectedBelowFive: boolean;
  /** (O-E)^2/E；N = 0 时为 null */
  chiContribution: number | null;
}

export interface BenfordReport {
  mode: Mode;
  n: number;
  bins: BinStat[];
  /** sum((O-E)^2/E)，仅描述性；N = 0 时为 null */
  chiSquare: number | null;
  /** 平均绝对频率差 mean(|O/N - p|)；N = 0 时为 null */
  mad: number | null;
  theorySum: number;
}

export function buildReport(
  mode: Mode,
  observedCounts: Map<number, number>,
): BenfordReport {
  const bins = binsForMode(mode);
  let n = 0;
  for (const b of bins) n += observedCounts.get(b) ?? 0;

  let chiSquare = 0;
  let madSum = 0;
  let theorySum = 0;
  const stats: BinStat[] = bins.map((b) => {
    const observed = observedCounts.get(b) ?? 0;
    const theoretical = theoreticalProbability(b);
    theorySum += theoretical;
    const expected = n * theoretical;
    if (n === 0) {
      return {
        bin: b,
        observed,
        frequency: null,
        theoretical,
        expected: 0,
        difference: null,
        expectedBelowFive: true,
        chiContribution: null,
      };
    }
    const frequency = observed / n;
    const chiContribution =
      expected > 0 ? (observed - expected) ** 2 / expected : 0;
    chiSquare += chiContribution;
    madSum += Math.abs(frequency - theoretical);
    return {
      bin: b,
      observed,
      frequency,
      theoretical,
      expected,
      difference: observed - expected,
      expectedBelowFive: expected < 5,
      chiContribution,
    };
  });

  return {
    mode,
    n,
    bins: stats,
    chiSquare: n === 0 ? null : chiSquare,
    mad: n === 0 ? null : madSum / bins.length,
    theorySum,
  };
}
