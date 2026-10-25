export function cents(value) {
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function decimalToCents(value) {
  if (!Number.isFinite(value)) throw new TypeError('Amount must be finite.');
  return Math.round(value * 100);
}
