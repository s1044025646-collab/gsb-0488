import { MAX_EXPONENT_DIGITS, MAX_TEXT_LENGTH } from './constants.js';
import type { RowStatus } from './constants.js';

export interface ParsedValue {
  status: RowStatus;
  reason: string;
  normalized: string | null;
  sign: '+' | '-';
  mantissaDigits: string;
  exponent: number | null;
  significantDigits: string;
  firstDigit: number | null;
  firstTwo: number | null;
  precision: number;
  zero: boolean;
}

const NUMBER_PATTERN = /^[ \t\r\n]*([+-]?)(?:(0|[0-9]+)(?:\.([0-9]*))?|\.(0|[0-9]+))(?:[eE]([+-]?[0-9]+))?[ \t\r\n]*$/;

export function parseDecimalText(raw: unknown): ParsedValue {
  const failure = (reason: string): ParsedValue => ({
    status: 'rejected',
    reason,
    normalized: null,
    sign: '+',
    mantissaDigits: '',
    exponent: null,
    significantDigits: '',
    firstDigit: null,
    firstTwo: null,
    precision: 0,
    zero: false
  });

  if (typeof raw !== 'string') return failure('VALUE_NOT_STRING');
  if (raw.length === 0) return failure('EMPTY_TEXT');
  if (raw.length > MAX_TEXT_LENGTH) return failure('TEXT_TOO_LONG');
  if (/[\u00A0]/.test(raw)) return failure('UNSUPPORTED_WHITESPACE');

  const match = NUMBER_PATTERN.exec(raw);
  if (!match) {
    const upper = raw.toUpperCase();
    if (upper.includes('NAN') || upper.includes('INFINITY')) return failure('NON_FINITE_LITERAL');
    if (raw.includes(',')) return failure('THOUSANDS_SEPARATOR_NOT_ALLOWED');
    if (raw.includes('%')) return failure('PERCENT_NOT_ALLOWED');
    if (/[$€£¥￥]/.test(raw)) return failure('CURRENCY_SYMBOL_NOT_ALLOWED');
    return failure('INVALID_DECIMAL_TEXT');
  }

  const sign = match[1] === '-' ? '-' : '+';
  const whole = match[2] ?? '';
  const fraction = match[3] ?? match[4] ?? '';
  const exponentText = match[5];
  if (exponentText && exponentText.replace(/^[+-]/, '').length > MAX_EXPONENT_DIGITS) {
    return failure('EXPONENT_TOO_MANY_DIGITS');
  }

  const mantissaDigits = `${whole}${fraction}`;
  const significantDigits = mantissaDigits.replace(/^0+/, '');
  const zero = significantDigits.length === 0;
  const exponent = exponentText === undefined ? null : Number(exponentText);

  if (exponent !== null && (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 999_999)) {
    return failure('EXPONENT_OUT_OF_RANGE');
  }

  const normalized = buildNormalized(sign, whole || '0', fraction, exponent);
  if (zero) {
    return {
      status: 'excluded_zero',
      reason: 'ZERO_EXCLUDED_FROM_SAMPLE',
      normalized,
      sign,
      mantissaDigits,
      exponent,
      significantDigits: '',
      firstDigit: null,
      firstTwo: null,
      precision: 0,
      zero: true
    };
  }

  const firstCharacter = significantDigits.charAt(0);
  const firstDigit = Number(firstCharacter);
  const secondCharacter = significantDigits.charAt(1) || '0';
  const firstTwo = Number(`${firstCharacter}${secondCharacter}`);

  return {
    status: 'valid',
    reason: 'VALID_NON_ZERO',
    normalized,
    sign,
    mantissaDigits,
    exponent,
    significantDigits,
    firstDigit,
    firstTwo,
    precision: significantDigits.length,
    zero: false
  };
}

function buildNormalized(sign: '+' | '-', whole: string, fraction: string, exponent: number | null): string {
  const signPart = sign === '-' ? '-' : '';
  const decimalPart = fraction ? `.${fraction}` : '';
  const exponentPart = exponent === null ? '' : `e${exponent}`;
  return `${signPart}${whole}${decimalPart}${exponentPart}`;
}
