import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  BASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_INVITE_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),
  TELEGRAM_ADMIN_ID: z.string().optional().default(''),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_SERIES_TABLE: z.string().default('seriesList'),
  SUPABASE_STORAGE_BUCKET: z.string().default('payment-proofs'),
  MERCHANT_NAME: z.string().min(1),
  MERCHANT_UPI_ID: z.string().regex(/^[\w.\-]{2,256}@[\w.-]{2,64}$/),
  MAX_PROOF_FILE_SIZE_MB: z.coerce.number().int().min(1).max(10).default(5),
  OCR_DEBUG: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  OCR_SPACE_API_KEY: z.string().min(1),
  INTERNAL_API_SECRET: z.string().min(32),
  PAYMENT_PROVIDER: z.string().optional().default(''),
  PAYMENT_PROVIDER_API_KEY: z.string().optional().default(''),
  PAYMENT_PROVIDER_WEBHOOK_SECRET: z.string().optional().default('')
});

const runtimeEnv = {
  ...process.env,
  // Support the exact .env spelling already used by this project.
  OCR_SPACE_API_KEY: process.env.OCR_SPACE_API_KEY || process.env.ocr_space_API,
};
const parsed = schema.safeParse(runtimeEnv);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  process.exit(1);
}
export const env = parsed.data;
