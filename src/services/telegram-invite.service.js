import { env } from '../config/env.js';

export async function createChannelInviteLink(channelId, { memberLimit = 1, expireAt } = {}) {
  const botToken = env.TELEGRAM_INVITE_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const payload = { chat_id: channelId, member_limit: memberLimit };
  if (expireAt) payload.expire_date = expireAt;

  const response = await fetch(`https://api.telegram.org/bot${botToken}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok || !result.result?.invite_link) {
    throw new Error(result.description || `Telegram createChatInviteLink failed (${response.status})`);
  }
  return result.result.invite_link;
}
