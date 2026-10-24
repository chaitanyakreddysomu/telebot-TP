import QRCode from 'qrcode';
export function createUpiUri(order, series) {
  const params = new URLSearchParams({ pa: order.merchant_upi_id, pn: order.merchant_name,
    am: (Number(order.amount_paise) / 100).toFixed(2), cu: 'INR', tn: order.transaction_note });
  return `upi://pay?${params.toString()}`;
}
export async function makeQrDataUrl(uri) { return QRCode.toDataURL(uri, { errorCorrectionLevel: 'H', margin: 1, width: 280 }); }
