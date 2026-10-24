export function formatRupees(paise) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(paise) / 100);
}
export function rupeesToPaise(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid series price');
  return Math.round(amount * 100);
}
