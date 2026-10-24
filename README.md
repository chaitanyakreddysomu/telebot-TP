# Pocket FM Telegram bot and checkout backend

This is a single Node.js/Express application with a Telegraf bot, Supabase catalogue and order storage, a hosted checkout page, private proof uploads, OCR triage, and Telegram invite delivery.

## Setup

1. Use Node.js 20 or newer and run `npm install`.
2. Copy `.env.example` to `.env` and supply fresh credentials. Do not put credentials in source control. The Telegram bot must be an admin in each private delivery channel.
3. Create a **private** Supabase Storage bucket matching `SUPABASE_STORAGE_BUCKET`.
4. Review and apply `supabase/migrations/001_payment_backend.sql` in Supabase. For an existing installation, also apply `supabase/migrations/002_telegram_checkout_message.sql` and `supabase/migrations/003_payments_history.sql`. The history migration adds an order reference to `payments` so verified purchases are recorded once, and neither migration changes the existing `seriesList` table.
5. Start with `npm start`. For local polling, leave `TELEGRAM_WEBHOOK_SECRET` empty. For webhook deployments, set it and configure Telegram's webhook to `/telegram/webhook` with the same secret.

### Vercel deployment

Vercel runs the Express app as a serverless function, so deploy `src/app.js` (which exports the app as default) rather than starting `src/server.js`. Set `BASE_URL` to the production Vercel URL and set a random `TELEGRAM_WEBHOOK_SECRET`. After deployment, register Telegram's webhook once by sending `POST https://<your-domain>/api/internal/register-telegram-webhook` with `Authorization: Bearer <INTERNAL_API_SECRET>`. Keep only one deployment configured to receive Telegram updates. Vercel limits function request bodies to 4.5 MB, so receipt uploads are capped at 4 MB on Vercel even if `MAX_PROOF_FILE_SIZE_MB` is higher.

Receipt OCR uses OCR.space Engine 2. The app accepts the existing `.env` key name `ocr_space_API` (or `OCR_SPACE_API_KEY`). OCR.space receives the image from the server; the API key is never sent to the browser. Upload JPEG or PNG. OCR.space currently lists a 1 MB image limit for its free plan and 5 MB for PRO, so the usable upload limit depends on the API key's plan.

The catalogue reader maps the existing `seriesList` fields (`series_name`, `platform`, `duration`, `price`, `channel_id`, `is_active`) used by the supplied Python bot. `price` is treated as rupees. Set `SUPABASE_SERIES_TABLE` if your existing table has another name. If your table uses different columns, adjust `src/services/series.service.js` to match it.

Set `TELEGRAM_ADMIN_ID` to your Telegram numeric user ID to enable the admin-only `/link Series Name` command. It creates and returns a one-use invite link for the matching series, and reports if the series or its channel ID is missing or Telegram cannot create the link. Invite links use the direct Telegram Bot API with `TELEGRAM_INVITE_BOT_TOKEN`; leave it blank to use `TELEGRAM_BOT_TOKEN`. The invite bot must be an admin in each channel and have invite-link permission.

## Payment safety

The Telegram catalogue edits one message as the user moves from the welcome screen to a two-column list of 10 series per page and then to a checkout link. Checkout payment links expire after 30 minutes, and the Telegram link message is edited after expiry. Checkout totals add ₹0.01–₹0.50 to the catalogue price. Receipt verification checks the OCR transaction note, amount, success wording, and duplicate transaction ID; an order is rejected only after three failed receipt attempts. OCR text is still only a screenshot reading and is not a direct payment-provider confirmation.

Configure `BASE_URL` to the public HTTPS origin in production. Protect the internal delivery endpoint with a long random `INTERNAL_API_SECRET`. Keep the Supabase service-role key server-side only. Ensure Supabase RLS is enabled for these tables and do not grant browser access to them.

The old Python source pasted in chat included credentials. Revoke and replace those credentials before deployment; this project deliberately contains no secrets.
