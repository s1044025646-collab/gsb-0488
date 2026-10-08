import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseDecimalText } from '../core/parse.js';
import { buildReport, theoreticalProbability } from '../core/statistics.js';
import { normalizeRecords, parseCsv } from '../io/records.js';
import { BenfordStore } from '../store/database.js';

const tempDir = mkdtempSync(join(tmpdir(), 'benford-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('decimal text extraction', () => {
  it('extracts leading digits without JavaScript Number conversion', () => {
    assert.deepEqual(['0', '-0.00450', '12e3', '9.99E-8', '5', '100.0'].map((value) => {
      const parsed = parseDecimalText(value);
      return [parsed.status, parsed.firstDigit, parsed.firstTwo, parsed.normalized];
    }), [
      ['excluded_zero', null, null, '0'],
      ['valid', 4, 45, '-0.00450'],
      ['valid', 1, 12, '12e3'],
      ['valid', 9, 99, '9.99e-8'],
      ['valid', 5, 50, '5'],
      ['valid', 1, 10, '100.0']
    ]);
  });

  it('handles extreme exponents, missing decimal side, whitespace, signs and trailing zeros', () => {
    assert.equal(parseDecimalText('  5e300 ').firstTwo, 50);
    assert.equal(parseDecimalText('5e-300').firstTwo, 50);
    assert.equal(parseDecimalText('.000001').firstTwo, 10);
    assert.equal(parseDecimalText('123.').firstTwo, 12);
    assert.equal(parseDecimalText('-000100').sign, '-');
    assert.equal(parseDecimalText('-0e999999').status, 'excluded_zero');
  });

  it('rejects unsupported syntax separately from legal zeros', () => {
    for (const value of ['NaN', 'Infinity', '1,000', '$12', '12%', '1e', '0x9', '1.2.3']) {
      assert.equal(parseDecimalText(value).status, 'rejected', value);
    }
  });
});

describe('report statistics', () => {
  it('matches expected demo counts and mathematical invariants', () => {
    const rows = ['0', '-0.00450', '12e3', '9.99E-8', '5', '100.0'].map((value) => parseDecimalText(value));
    const report = buildReport(rows, rows.length, 'first');
    const two = buildReport(rows, rows.length, 'first_two');
    assert.equal(report.validCount, 5);
    assert.equal(report.excludedZeroCount, 1);
    assert.deepEqual(report.bins.filter((bin) => bin.observed > 0).map((bin) => [bin.bin, bin.observed]), [[1, 2], [4, 1], [5, 1], [9, 1]]);
    assert.deepEqual(two.bins.filter((bin) => bin.observed > 0).map((bin) => [bin.bin, bin.observed]), [[10, 1], [12, 1], [45, 1], [50, 1], [99, 1]]);
    assert.equal(report.bins.reduce((sum, bin) => sum + bin.observed, 0), 5);
    assert.ok(Math.abs(report.bins.reduce((sum, bin) => sum + bin.probability, 0) - 1) < 1e-12);
    const expectedChi = report.bins.reduce((sum, bin) => sum + (bin.chiSquareContribution ?? 0), 0);
    assert.ok(Math.abs((report.chiSquare ?? 0) - expectedChi) < 1e-12);
  });

  it('returns null deviations for N=0 while preserving theory', () => {
    const report = buildReport([parseDecimalText('0')], 1, 'first');
    assert.equal(report.validCount, 0);
    assert.equal(report.chiSquare, null);
    assert.equal(report.mad, null);
    assert.equal(report.bins.length, 9);
  });

  it('supports one valid observation and all-zero batch', () => {
    assert.equal(buildReport([parseDecimalText('7')], 1, 'first').bins[6]?.observed, 1);
    const zeros = buildReport([parseDecimalText('0'), parseDecimalText('-0')], 2, 'first_two');
    assert.equal(zeros.validCount, 0);
    assert.equal(zeros.excludedZeroCount, 2);
    assert.equal(zeros.bins.length, 90);
  });
});

describe('input validation and persistence', () => {
  it('rejects missing and duplicate row IDs', () => {
    assert.throws(() => normalizeRecords([{ id: 'a', value: '1' }, { value: '2' }]), (error: unknown) => hasCode(error, 'MISSING_ROW_ID'));
    assert.throws(() => normalizeRecords([{ id: 'x', value: '1' }, { id: 'x', value: '2' }]), (error: unknown) => hasCode(error, 'DUPLICATE_ROW_ID'));
    assert.equal(parseCsv('id,value\na,1\nb,2').length, 2);
  });

  it('persists reports, idempotent retries and new versions, then rereads after restart', () => {
    const file = join(tempDir, 'persist.sqlite');
    let store = new BenfordStore(file);
    const first = store.importRecords('set', [{ id: 'a', value: '1' }, { id: 'z', value: '0' }], 'key-1');
    assert.equal(first.versionNumber, 1);
    const retry = store.importRecords('set', [{ id: 'a', value: '1' }, { id: 'z', value: '0' }], 'key-1');
    assert.equal(retry.versionId, first.versionId);
    assert.equal(retry.idempotentRetry, true);
    const second = store.importRecords('set', [{ id: 'a', value: '1' }, { id: 'b', value: 'bad' }], undefined);
    assert.equal(second.versionNumber, 2);
    assert.equal(second.reports.first.rejectedCount, 1);
    assert.equal(second.reports.first.partialValidData, true);
    store.close();

    store = new BenfordStore(file);
    const reread = store.getReport(first.versionId, 'first').report;
    assert.deepEqual(reread, first.reports.first);
    assert.equal(store.sources(first.versionId, 'first', 1, 100, 0).total, 1);
    store.close();
  });

  it('does not publish half a dataset when transaction validation fails', () => {
    const file = join(tempDir, 'rollback.sqlite');
    const store = new BenfordStore(file);
    const initial = store.importRecords('set', [{ id: 'a', value: '1' }], undefined);
    assert.throws(() => store.importRecords('set', [{ id: 'a', value: '1' }, { id: 'a', value: '2' }], undefined));
    assert.equal(store.getReport(initial.versionId, 'first').report.validCount, 1);
    assert.throws(() => store.getReport(initial.versionId.replace(/./g, 'x'), 'first'));
    store.close();
  });
});

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

describe('theoretical probabilities', () => {
  it('uses log10(1+1/d)', () => {
    assert.ok(Math.abs(theoreticalProbability(1) - Math.log10(2)) < 1e-15);
    assert.ok(Math.abs(theoreticalProbability(99) - Math.log10(100 / 99)) < 1e-15);
  });
});
