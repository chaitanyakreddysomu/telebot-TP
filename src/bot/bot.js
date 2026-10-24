import { Telegraf, Markup } from 'telegraf';
import { env } from '../config/env.js';
import { supabase } from '../config/supabase.js';
import { listSeries, getSeries, getSeriesByName } from '../services/series.service.js';
import { createOrder } from '../services/order.service.js';
import { createChannelInviteLink } from '../services/telegram-invite.service.js';
import { formatRupees } from '../utils/money.js';

export const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
const PAGE_SIZE = 10;

async function editSeriesMessage(ctx, page = 0) {
  const result = await listSeries(page, PAGE_SIZE);
  if (!result.items.length && page === 0) {
    return ctx.editMessageText('No active Pocket FM series are available right now.');
  }

  const rows = [];
  for (let i = 0; i < result.items.length; i += 2) {
    rows.push(result.items.slice(i, i + 2).map(item =>
      Markup.button.callback(item.name, `series:${item.id}`)));
  }
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('‹ Previous', `page:${page - 1}`));
  if (result.hasNext) nav.push(Markup.button.callback('Next ›', `page:${page + 1}`));
  if (nav.length) rows.push(nav);

  return ctx.editMessageText('Choose a Pocket FM series:', Markup.inlineKeyboard(rows));
}

async function sendCheckoutLink(ctx, series, { editMessage = false } = {}) {
  const telegramMessageId = editMessage ? ctx.callbackQuery.message.message_id : null;
  const order = await createOrder({
    user: ctx.from,
    seriesId: series.id,
    telegramChatId: ctx.chat.id,
    telegramMessageId,
  });
  const expiresInMinutes = Math.max(1, Math.ceil((new Date(order.expiresAt).getTime() - Date.now()) / 60_000));
  const message = `You Selected ${series.name} .\n\nSeries name : ${series.name}\nPlatform: ${series.platform}\nEpisodes: ${series.episodeCount || 'Not listed'}\nPrice: ${formatRupees(order.amountPaise)}\n\nLink : ${env.BASE_URL}/checkout/${order.token}\n\nLink will expire in ${expiresInMinutes} minutes.\n\n\nafter payment also your link is not generated message @TeluguSeries_request_bot`;

  if (editMessage) {
    await ctx.editMessageText(message);
    return;
  }

  const sent = await ctx.reply(message);
  const { error } = await supabase.from('payment_orders').update({
    telegram_order_message_id: sent.message_id,
  }).eq('id', order.id);
  if (error) console.error('[Checkout Telegram message ID save failed]', { orderId: order.id, error: error.message });
}

bot.start(async ctx => {
  const payload = ctx.startPayload?.trim();
  if (payload) {
    try {
      const series = await getSeriesByName(payload);
      if (!series) return ctx.reply(`Series "${payload}" was not found. Send /start to browse available series.`);
      await sendCheckoutLink(ctx, series);
    } catch (error) {
      console.error('[Telegram deep-link checkout failed]', { payload, error: error.message });
      await ctx.reply('Could not open this series checkout. Please send /start and choose the series from the list.');
    }
    return;
  }

  await ctx.reply(`Usage: https://t.me/+hVshgnJlzPs3Njhl\n\nDon't know how to use the bot? Open the usage channel above and watch the video.\n\nWelcome, ${ctx.from.first_name || 'there'}!\n\nSelect Pocket FM below for the series list.`,
    Markup.inlineKeyboard([[Markup.button.callback('Pocket FM', 'page:0')]]));
});

bot.command('myseries', async ctx => {
  try {
    const { data: purchases, error } = await supabase.from('payments')
      .select('series_name,date')
      .eq('user_id', String(ctx.from.id))
      .order('date', { ascending: false });
    if (error) throw error;

    const seriesNames = [...new Set((purchases || []).map(item => item.series_name).filter(Boolean))];
    if (!seriesNames.length) return ctx.reply('You have not purchased any series yet.');
    await ctx.reply(`Your purchased series:\n\n${seriesNames.map((name, index) => `${index + 1}. ${name}`).join('\n')}`);
  } catch (error) {
    console.error('[Telegram /myseries failed]', { userId: ctx.from.id, error: error.message });
    await ctx.reply('I could not load your purchased series right now. Please try again later.');
  }
});

bot.action(/^page:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  await editSeriesMessage(ctx, Number(ctx.match[1]));
});

bot.action(/^series:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  try {
    const series = await getSeries(ctx.match[1]);
    if (!series) return ctx.editMessageText('This series is no longer available.');

    await sendCheckoutLink(ctx, series, { editMessage: true });
  } catch (error) {
    console.error('Order creation failed:', error.message);
    await ctx.editMessageText('Could not create your order. Please use /start and try again.');
  }
});

bot.command('link', async ctx => {
  if (!env.TELEGRAM_ADMIN_ID || String(ctx.from.id) !== String(env.TELEGRAM_ADMIN_ID)) {
    return ctx.reply('You are not authorized to use this command.');
  }

  const seriesName = ctx.message.text.replace(/^\/link(?:@\w+)?\s*/i, '').trim();
  if (!seriesName) return ctx.reply('Usage: /link Series Name');

  let selectedChannelId = null;
  try {
    const seriesTable = 'seriesList';
    let { data: matches, error } = await supabase.from(seriesTable)
      .select('series_name,channel_id').eq('series_name', seriesName).limit(2);
    if (error) throw error;
    if (!matches?.length) {
      ({ data: matches, error } = await supabase.from(seriesTable)
        .select('series_name,channel_id').ilike('series_name', seriesName).limit(2));
      if (error) throw error;
    }
    if (!matches?.length) return ctx.reply(`Series "${seriesName}" was not found.`);
    if (matches.length > 1) return ctx.reply('More than one series matched. Please use the exact series name.');

    const series = matches[0];
    if (!series.channel_id) return ctx.reply(`No channel ID is configured for "${series.series_name}".`);
    selectedChannelId = series.channel_id;

    console.info('[Admin /link] Generating invite from seriesList channel_id', {
      seriesName: series.series_name,
      channelId: series.channel_id,
    });
    const inviteLink = await createChannelInviteLink(series.channel_id, {
      memberLimit: 1,
      expireAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });
    await ctx.reply(`✅ Invite link generated for ${series.series_name}.\nChannel ID: ${series.channel_id}\n${inviteLink}\n\nOne use · expires in 24 hours.`);
  } catch (error) {
    const telegramReason = error.response?.description || error.message || 'Unknown Telegram API error';
    console.error('[Admin /link command failed]', { seriesName, channelId: selectedChannelId, error: telegramReason });
    await ctx.reply(`Could not generate the invite link for "${seriesName}".${selectedChannelId ? `\nChannel ID: ${selectedChannelId}` : ''}\nTelegram error: ${telegramReason}`);
  }
});

export async function editExpiredOrderMessages(orders) {
  for (const order of orders) {
    if (!order.telegram_chat_id || !order.telegram_order_message_id) continue;
    try {
      const { data: series, error } = await supabase.from(env.SUPABASE_SERIES_TABLE)
        .select('series_name,platform,duration').eq('id', order.series_id).maybeSingle();
      if (error) throw error;
      const text = `Series name : ${series?.series_name || 'Pocket FM series'}\nPlatform: ${series?.platform || 'pocket_fm'}\nEpisodes: ${series?.duration || 'Not listed'}\nPrice: ${formatRupees(order.amount_paise)}\nLink : link expired /start for new link`;
      await bot.telegram.editMessageText(order.telegram_chat_id, order.telegram_order_message_id, undefined, text);
    } catch (error) {
      console.error('[Telegram expired checkout message update failed]', { orderId: order.id, error: error.message });
    }
  }
}

bot.catch(err => console.error('Telegram bot error:', err.message));
