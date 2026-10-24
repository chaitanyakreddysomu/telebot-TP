import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';
import { bot } from '../bot/bot.js';
import { formatRupees } from '../utils/money.js';
import { createChannelInviteLink } from './telegram-invite.service.js';

const INVITE_EXPIRY_MINUTES = 24 * 60;

export async function deliverOrder(orderId) {
  const { data: order, error } = await supabase.from('payment_orders').select('*').eq('id', orderId).maybeSingle();
  if (error) throw error;
  if (order?.verification_source === 'ocr_test') throw Object.assign(new Error('OCR test approvals cannot trigger product delivery'), { status: 409 });
  if (!order || !['verified', 'delivery_pending'].includes(order.status)) throw Object.assign(new Error('Order is not eligible for delivery'), { status: 409 });
  const { data: series, error: seriesError } = await supabase.from(env.SUPABASE_SERIES_TABLE)
    .select('channel_id,series_name,platform,duration').eq('id', order.series_id).maybeSingle();
  if (seriesError) throw seriesError;
  const { data: alreadyDelivered } = await supabase.from('deliveries').select('*').eq('order_id', orderId).eq('status', 'delivered').maybeSingle();
  if (alreadyDelivered) return alreadyDelivered;
  const channelId = series?.channel_id;
  if (!channelId) throw new Error('No channel is configured for this series');
  const { data: reserved, error: reserveError } = await supabase.rpc('reserve_order_delivery', { p_order_id: order.id });
  if (reserveError) throw reserveError;
  if (!reserved) {
    const { data: existing } = await supabase.from('deliveries').select('*').eq('order_id', orderId).maybeSingle();
    if (existing?.status === 'delivered') return existing;
    throw Object.assign(new Error('Delivery is already reserved or requires retry review'), { status: 409 });
  }
  const inviteLink = await createChannelInviteLink(channelId, {
    memberLimit: 1,
    expireAt: Math.floor(Date.now() / 1000) + INVITE_EXPIRY_MINUTES * 60,
  });
  await supabase.from('deliveries').update({ telegram_invite_link: inviteLink, status: 'sending' }).eq('order_id', order.id);
  const seriesName = series?.series_name || 'your selected series';
  const successText = `✅ Payment successful!\n\nSeries name : ${seriesName}\nPlatform: ${series?.platform || 'pocket_fm'}\nEpisodes: ${series?.duration || 'Not listed'}\nPrice: ${formatRupees(order.amount_paise)}\n\nChannel invite link: ${inviteLink}\n\nNeed more series? /start`;
  let messageId = order.telegram_order_message_id;
  if (order.telegram_chat_id && messageId) {
    await bot.telegram.editMessageText(order.telegram_chat_id, messageId, undefined, successText);
  } else {
    const sent = await bot.telegram.sendMessage(order.telegram_user_id, successText);
    messageId = sent.message_id;
  }
  const { data, error: updateError } = await supabase.from('deliveries').update({ telegram_invite_link: inviteLink,
    telegram_message_id: messageId, status: 'delivered', delivered_at: new Date().toISOString() }).eq('order_id', order.id).select().single();
  if (updateError) throw updateError;
  await supabase.from('payment_orders').update({ status: 'delivered', updated_at: new Date().toISOString() }).eq('id', order.id);
  return data;
}
