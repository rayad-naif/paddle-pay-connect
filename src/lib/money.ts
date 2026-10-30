// GHL sends amounts in major units (100.00); Paddle wants integer strings in minor units ("10000").
const ZERO_DECIMAL = new Set(['JPY', 'KRW']);

function decimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** decimals(currency));
}

export function fromMinor(minor: number | string, currency: string): number {
  return Number(minor) / 10 ** decimals(currency);
}
