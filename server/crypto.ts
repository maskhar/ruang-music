import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function passwordMatches(input: string, expected: string) { return timingSafeEqual(scryptSync(input, 'carubra-admin-v1', 32), scryptSync(expected, 'carubra-admin-v1', 32)); }
export function encrypt(value: unknown, key: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(v => v.toString('base64url')).join('.'); }
export function decrypt<T>(value: string, key: string): T { const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64url')); const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv); cipher.setAuthTag(tag); return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString()); }
