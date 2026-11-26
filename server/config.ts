import 'dotenv/config';
import { resolve } from 'node:path';
export function loadConfig(env = process.env) {
  const origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:3210').origin;
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD harus minimal 16 karakter. Lihat .env.example.');
  if (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || '')) throw new Error('ENCRYPTION_KEY harus 64 karakter hex.');
  return { port: Number(env.PORT || 3210), origin, cookieSecure: origin.startsWith('https:'), dataDir: resolve(env.DATA_DIR || './data'), password: env.ADMIN_PASSWORD, encryptionKey: env.ENCRYPTION_KEY!, clientId: env.SPOTIFY_CLIENT_ID || '', groupId: env.WHATSAPP_GROUP_ID || '120363430180897172@g.us', integrationToken: env.INTEGRATION_TOKEN || '', wahaUrl: env.WAHA_URL || '', wahaKey: env.WAHA_API_KEY || '', wahaSession: env.WAHA_SESSION || 'carubra', trustProxy: env.TRUST_PROXY || 'loopback' };
}
export type Config = ReturnType<typeof loadConfig>;
