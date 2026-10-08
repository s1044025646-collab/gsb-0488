export const MAX_ROWS = 100_000;
export const MAX_TEXT_LENGTH = 1_000;
export const MAX_EXPONENT_DIGITS = 6;

export const RULES = Object.freeze({
  maxRows: MAX_ROWS,
  maxTextLength: MAX_TEXT_LENGTH,
  maxExponentDigits: MAX_EXPONENT_DIGITS,
  acceptsSigns: true,
  acceptsDecimalFractions: true,
  acceptsScientificNotation: true,
  rejectsThousandsSeparators: true,
  rejectsCurrencySymbols: true,
  rejectsNanInfinityAndPercent: true,
  doesNotConvertToJavaScriptNumber: true
});

export type RowStatus = 'valid' | 'rejected' | 'excluded_zero';

export type DigitMode = 'first' | 'first_two';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function binsForMode(mode: DigitMode): number[] {
  return mode === 'first'
    ? Array.from({ length: 9 }, (_, index) => index + 1)
    : Array.from({ length: 90 }, (_, index) => index + 10);
}

export function modeName(mode: DigitMode): string {
  return mode === 'first' ? '首位有效数字' : '前两位有效数字';
}
