import 'dotenv/config';
import { resolve } from 'node:path';
export function loadConfig(env = process.env) {
  const origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:3210').origin;
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD harus minimal 16 karakter. Lihat .env.example.');
  if (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || '')) throw new Error('ENCRYPTION_KEY harus 64 karakter hex.');
  const groupIds = [...new Set((env.WHATSAPP_GROUP_IDS || env.WHATSAPP_GROUP_ID || '0@g.us').split(',').map(id => id.trim()).filter(Boolean))];
  if (!groupIds.length || groupIds.some(id => !/^[0-9]+@g\.us$/.test(id))) throw new Error('WHATSAPP_GROUP_IDS harus berisi ID grup valid, dipisahkan koma.');
  return { port: Number(env.PORT || 3210), origin, cookieSecure: origin.startsWith('https:'), dataDir: resolve(env.DATA_DIR || './data'), password: env.ADMIN_PASSWORD, encryptionKey: env.ENCRYPTION_KEY!, clientId: env.SPOTIFY_CLIENT_ID || '', groupId: groupIds[0], groupIds, integrationToken: env.INTEGRATION_TOKEN || '', wahaUrl: env.WAHA_URL || '', wahaKey: env.WAHA_API_KEY || '', wahaSession: env.WAHA_SESSION || 'carubra', trustProxy: env.TRUST_PROXY || 'loopback' };
}
export type Config = ReturnType<typeof loadConfig>;
