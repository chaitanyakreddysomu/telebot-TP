import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { getSeries } from './series.service.js';

const CHECKOUT_LINK_EXPIRY_MINUTES = 30;
const hash = token => createHash('sha256').update(token).digest('hex');
export async function createOrder({ user, seriesId, telegramChatId = null, telegramMessageId = null }) {
  const series = await getSeries(seriesId);
  if (!series) throw Object.assign(new Error('Series is unavailable'), { status: 404 });
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  // Avoid characters OCR commonly confuses: zero and the letter O.
  const noteAlphabet = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
  const noteSuffix = Array.from({ length: 14 }, () =>
    noteAlphabet[randomInt(noteAlphabet.length)]
  ).join('');
  const note = `PFM-${noteSuffix}`;
  // Add ₹0.01–₹0.50 so OCR can distinguish visually similar receipts.
  const amountPaise = series.pricePaise + randomInt(1, 51);
  const expiresAt = new Date(Date.now() + CHECKOUT_LINK_EXPIRY_MINUTES * 60_000).toISOString();
  const row = { id, telegram_user_id: String(user.id), telegram_username: user.username || null,
    telegram_first_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null, series_id: series.id, amount_paise: amountPaise,
    telegram_chat_id: telegramChatId, telegram_order_message_id: telegramMessageId,
    merchant_name: env.MERCHANT_NAME, merchant_upi_id: env.MERCHANT_UPI_ID, transaction_note: note,
    checkout_token_hash: hash(token), status: 'pending', expires_at: expiresAt };
  const { error } = await supabase.from('payment_orders').insert(row);
  if (error) throw error;
  return { id, token, series, amountPaise, expiresAt };
}
export async function orderByToken(token) {
  const { data, error } = await supabase.from('payment_orders').select('*')
    .eq('checkout_token_hash', hash(token)).maybeSingle();
  if (error) throw error;
  if (data) {
    const { data: series, error: seriesError } = await supabase.from(env.SUPABASE_SERIES_TABLE)
      .select('series_name,platform,duration').eq('id', data.series_id).maybeSingle();
    if (seriesError) throw seriesError;
    data.series = series;
  }
  return data;
}
export async function updateOrderStatus(id, status, fields = {}) {
  const { data, error } = await supabase.from('payment_orders').update({ status, updated_at: new Date().toISOString(), ...fields })
    .eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
}

export async function expirePendingOrders() {
  const { data, error } = await supabase.from('payment_orders')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .in('status', ['pending', 'proof_submitted']).lt('expires_at', new Date().toISOString())
    .select('id,series_id,amount_paise,telegram_chat_id,telegram_order_message_id');
  if (error) throw error;
  return data || [];
}
