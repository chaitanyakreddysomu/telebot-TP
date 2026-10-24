import { app } from './app.js';
import { env } from './config/env.js';
import { bot, editExpiredOrderMessages } from './bot/bot.js';
import { expirePendingOrders } from './services/order.service.js';

const server = app.listen(env.PORT, () => console.log(`App listening on port ${env.PORT}`));
if (!env.TELEGRAM_WEBHOOK_SECRET) bot.launch().catch(err => { console.error('Bot launch failed:', err.message); process.exitCode = 1; });
const expiryTimer = setInterval(async () => {
  try {
    const expiredOrders = await expirePendingOrders();
    await editExpiredOrderMessages(expiredOrders);
  } catch (err) { console.error('Order expiry job failed:', err.message); }
}, 60_000);
expiryTimer.unref();
const stop = signal => { console.log(`Received ${signal}; shutting down`); server.close(() => bot.stop(signal)); };
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
