export function cents(value) {
  if (!Number.isFinite(value)) return null;
  const amount = Math.round(value * 100);
  return Number.isSafeInteger(amount) ? amount : null;
}

export function decimalToCents(value) {
  if (!Number.isFinite(value)) throw new TypeError('Amount must be finite.');
  const amount = Math.round(value * 100);
  if (!Number.isSafeInteger(amount)) throw new RangeError('Amount exceeds the safe integer-cent range.');
  return amount;
}
