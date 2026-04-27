import 'dotenv/config';
import { z } from 'zod';

const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const csvList = z
  .string()
  .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8888),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  REDIS_URL: z.string().optional(),
  CACHE_TTL: z.coerce.number().int().positive().default(3600),

  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 chars; generate with crypto.randomBytes(48).toString('hex')"),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolString.default('false'),

  CORS_ORIGINS: csvList.default('http://localhost:5173,http://localhost:3000'),

  AWS_REGION: z.string().default('us-east-2'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_CLOUDFRONT_URL: z.string().optional(),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  GOOGLE_TRANSLATE_API_KEY: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
   
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

export const s3Enabled = Boolean(
  env.AWS_ACCESS_KEY_ID &&
  env.AWS_SECRET_ACCESS_KEY &&
  env.AWS_S3_BUCKET &&
  env.AWS_CLOUDFRONT_URL,
);

export const sentryEnabled = Boolean(env.SENTRY_DSN);

export const translateEnabled = Boolean(env.GOOGLE_TRANSLATE_API_KEY);
