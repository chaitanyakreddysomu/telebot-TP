import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env } from './config/env.js';
import { supabase } from './config/supabase.js';
import { bot } from './bot/bot.js';
import { listSeries, getSeries } from './services/series.service.js';
import { createOrder, orderByToken } from './services/order.service.js';
import { createUpiUri, makeQrDataUrl } from './services/upi.service.js';
import { readReceipt } from './services/ocr.service.js';
import { reviewReceipt } from './services/verification.service.js';
import { deliverOrder } from './services/delivery.service.js';
import { recordVerifiedPayment } from './services/payment-history.service.js';
import { formatRupees } from './utils/money.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const app = express();
app.set('view engine', 'ejs'); app.set('views', fileURLToPath(new URL('./views', import.meta.url)));
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:', 'https://w7.pngwing.com', 'https://play-lh.googleusercontent.com'], styleSrc: ["'self'", "'unsafe-inline'"] } } }));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: 0 }));
app.use(express.json({ limit: '32kb' }));
const apiLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const maxProofFileSizeMb = process.env.VERCEL ? Math.min(env.MAX_PROOF_FILE_SIZE_MB, 4) : env.MAX_PROOF_FILE_SIZE_MB;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxProofFileSizeMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)) });
const checkoutPath = token => `/checkout/${encodeURIComponent(token)}`;
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/series', apiLimit, async (req, res, next) => { try { const { items } = await listSeries(Number(req.query.page || 0)); res.json(items); } catch (e) { next(e); } });
app.get('/api/series/:id', apiLimit, async (req, res, next) => { try { const item = await getSeries(req.params.id); item ? res.json(item) : res.sendStatus(404); } catch (e) { next(e); } });
app.post('/api/payments', apiLimit, async (req, res, next) => {
  try {
    if (req.get('authorization') !== `Bearer ${env.INTERNAL_API_SECRET}`) return res.sendStatus(401);
    const parsed = z.object({ telegram_user_id: z.string().regex(/^\d{1,20}$/), series_id: z.string().min(1).max(64), telegram_username: z.string().max(64).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
    const order = await createOrder({ user: { id: parsed.data.telegram_user_id, username: parsed.data.telegram_username }, seriesId: parsed.data.series_id });
    res.status(201).json({ order_id: order.id, series_name: order.series.name, platform: order.series.platform,
      episode_count: order.series.episodeCount, amount_paise: order.amountPaise, currency: 'INR',
      payment_link: `${env.BASE_URL}${checkoutPath(order.token)}`, status: 'pending' });
  } catch (e) { next(e); }
});
app.get('/checkout/:token', async (req, res, next) => {
  try {
    const order = await orderByToken(req.params.token);
    if (!order) return res.status(404).render('state', {
      title: 'Checkout unavailable', message: 'This checkout link is invalid or unavailable.', expired: false,
    });
    if (order.status === 'expired' || new Date(order.expires_at) <= new Date()) {
      const alreadyPaid = ['verified', 'delivered', 'delivery_pending'].includes(order.status);
      return res.status(410).render('state', {
        title: 'Payment link expired',
        message: alreadyPaid
          ? 'This checkout link has expired. If you already paid, your channel invite was sent in Telegram. Send /start in the bot for a new order.'
          : 'This checkout link has expired. Send /start in the Telegram bot to create a new payment link.',
        expired: true,
        seriesName: order.series?.series_name || 'Pocket FM series',
        platform: order.series?.platform || 'pocket_fm',
        episodes: order.series?.duration || 'Not listed',
        amount: formatRupees(order.amount_paise),
      });
    }
    const series = order.series || {};
    const uri = createUpiUri(order, series); const qr = await makeQrDataUrl(uri);
    res.render('checkout', { order, series, qr, uri, amount: formatRupees(order.amount_paise), maxMb: maxProofFileSizeMb });
  } catch (e) { next(e); }
});
app.post('/api/checkout/:token/proof', apiLimit, upload.single('proof'), async (req, res, next) => {
  try {
    const order = await orderByToken(req.params.token);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (new Date(order.expires_at) < new Date() || !['pending', 'proof_submitted', 'under_review'].includes(order.status)) return res.status(409).json({ error: 'Order cannot accept proof' });
    if (!req.file) return res.status(400).json({ error: 'Upload a JPEG or PNG receipt image' });
    const { count: proofCount, error: proofCountError } = await supabase.from('payment_proofs')
      .select('id', { count: 'exact', head: true }).eq('order_id', order.id);
    if (proofCountError) throw proofCountError;
    if ((proofCount || 0) >= 3) return res.status(409).json({ error: 'All 3 receipt upload attempts have been used. Please create a new order.' });
    const signature = req.file.buffer.subarray(0, 12).toString('hex');
    const valid = (req.file.mimetype === 'image/jpeg' && signature.startsWith('ffd8ff')) ||
      (req.file.mimetype === 'image/png' && signature.startsWith('89504e470d0a1a0a'));
    if (!valid) return res.status(400).json({ error: 'The file content does not match a supported image format' });
    const path = `${order.id}/${Date.now()}-${randomUUID()}`;
    const { error: storageError } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (storageError) throw storageError;
    await supabase.from('payment_orders').update({ status: 'proof_submitted', updated_at: new Date().toISOString() }).eq('id', order.id);
    const receipt = await readReceipt(req.file.buffer, Number(order.amount_paise), req.file.mimetype);
    if (env.OCR_DEBUG) {
      console.info('[Receipt OCR]', JSON.stringify({ orderId: order.id, paymentStatus: receipt.paymentStatus,
        amountPaise: receipt.amountPaise, amountResolution: receipt.amountResolution,
        ambiguousAmount: receipt.ambiguousAmount, amountCandidates: receipt.amountCandidates,
        transactionNote: receipt.transactionNote, payeeName: receipt.payeeName,
        payeeUpiId: receipt.payeeUpiId, payerName: receipt.payerName,
        payerBank: receipt.payerBank, transactionDate: receipt.transactionDate, transactionId: receipt.transactionId,
        confidence: receipt.confidence, recognizedText: receipt.text }, null, 2));
    }
    const review = await reviewReceipt(order, receipt, path);
    let deliverySent = false;
    if (env.OCR_DEBUG) console.info('[OCR verification result]', JSON.stringify({ orderId: order.id,
      attempt: review.attempt, remainingAttempts: review.remainingAttempts,
      checks: review.checks, status: review.status, passed: review.passed }, null, 2));
    if (review.passed) {
      try {
        await recordVerifiedPayment(order);
      } catch (historyError) {
        console.error('[Verified payment history write failed]', { orderId: order.id, error: historyError.message });
      }
      try {
        await deliverOrder(order.id);
        deliverySent = true;
      } catch (deliveryError) {
        console.error('[Telegram payment fulfillment failed]', { orderId: order.id, error: deliveryError.message });
        const notice = `✅ Payment successful! Your payment of ${formatRupees(order.amount_paise)} has been verified, but the channel invite could not be generated automatically. Please contact support; do not pay again.`;
        try {
          if (order.telegram_chat_id && order.telegram_order_message_id) {
            await bot.telegram.editMessageText(order.telegram_chat_id, order.telegram_order_message_id, undefined, notice);
          } else {
            await bot.telegram.sendMessage(order.telegram_user_id, notice);
          }
        } catch (telegramError) {
          console.error('[Telegram payment confirmation failed]', { orderId: order.id, error: telegramError.message });
        }
      }
    }
    const uploadMessage = review.checks.duplicateTransactionId
      ? `This transaction ID belongs to another order. Attempt ${review.attempt} of 3 has failed.`
      : review.passed
        ? deliverySent
          ? 'Payment verified. Your one-time channel invite link was sent in Telegram.'
          : 'Payment verified, but the channel invite could not be sent automatically. Please contact support; do not pay again.'
        : review.status === 'rejected'
          ? 'Payment proof rejected after 3 attempts. Please create a new order.'
          : `Attempt ${review.attempt} of 3 did not pass all required checks. You can upload a corrected receipt; ${review.remainingAttempts} attempt(s) remain.`;
    res.json({ status: review.status, deliverySent,
      ocrMatch: { checks: review.checks }, message: uploadMessage,
      extracted: { paymentStatus: receipt.paymentStatus, amountPaise: receipt.amountPaise,
        amountResolution: receipt.amountResolution, ambiguousAmount: receipt.ambiguousAmount,
        amountCandidates: receipt.amountCandidates,
        transactionNote: receipt.transactionNote, payeeName: receipt.payeeName,
        payeeUpiId: receipt.payeeUpiId, payerName: receipt.payerName,
        payerBank: receipt.payerBank,
        transactionDate: receipt.transactionDate, transactionId: receipt.transactionId,
        confidence: receipt.confidence, recognizedText: receipt.text } });
  } catch (e) { next(e); }
});
app.get('/api/checkout/:token/status', apiLimit, async (req, res, next) => { try { const o = await orderByToken(req.params.token); o ? res.json({ status: o.status, testMode: o.verification_source === 'ocr_test' }) : res.sendStatus(404); } catch (e) { next(e); } });
app.post('/api/webhooks/payment-provider', apiLimit, async (_req, res) => res.status(501).json({ error: 'No trusted payment provider adapter is configured' }));
app.post('/api/internal/deliver/:orderId', async (req, res, next) => {
  if (req.get('authorization') !== `Bearer ${env.INTERNAL_API_SECRET}`) return res.sendStatus(401);
  try { res.json(await deliverOrder(req.params.orderId)); } catch (e) { next(e); }
});
app.post('/api/internal/register-telegram-webhook', async (req, res, next) => {
  if (req.get('authorization') !== `Bearer ${env.INTERNAL_API_SECRET}`) return res.sendStatus(401);
  if (!env.TELEGRAM_WEBHOOK_SECRET) return res.status(400).json({ error: 'Set TELEGRAM_WEBHOOK_SECRET before registering the webhook.' });
  try {
    const webhookUrl = `${env.BASE_URL.replace(/\/$/, '')}/telegram/webhook`;
    await bot.telegram.setWebhook(webhookUrl, { secret_token: env.TELEGRAM_WEBHOOK_SECRET });
    res.json({ ok: true, webhookUrl });
  } catch (e) { next(e); }
});
app.post('/telegram/webhook', async (req, res) => {
  if (!env.TELEGRAM_WEBHOOK_SECRET || req.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(401);
  try { await bot.handleUpdate(req.body); res.sendStatus(200); } catch { res.sendStatus(500); }
});
app.get('/checkout/:token/status-page', (_req, res) => res.json({ ok: true }));
app.use((err, _req, res, _next) => { console.error('Request failed:', err.message); res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' }); });
export { app };
export default app;
