import type { Config } from './config.ts';
import { AppError } from './types.ts';

export interface IncomingMessage {
  groupId: string;
  session: string;
  senderId: string;
  messageId: string;
  text: string;
}

export async function verifyWahaMessage(config: Config, message: IncomingMessage) {
  if (!config.wahaUrl || !config.wahaKey) {
    throw new AppError('WhatsApp belum dikonfigurasi. Hubungi admin aplikasi.', 503);
  }
  const {groupId,session,messageId} = message;
  const path = '/api/' + encodeURIComponent(session) + '/chats/' + encodeURIComponent(groupId) +
    '/messages/' + encodeURIComponent(messageId) + '?downloadMedia=false';
  const response = await fetch(config.wahaUrl.replace(/\/$/, '') + path, {
    headers: {'X-Api-Key':config.wahaKey},
    signal: AbortSignal.timeout(6000),
    redirect: 'error'
  }).catch(() => { throw new AppError('Pesan WhatsApp belum bisa diverifikasi. Kirim ulang command.',503); });
  if (response.status === 404) return false;
  if (!response.ok) throw new AppError('Pesan WhatsApp belum bisa diverifikasi. Kirim ulang command.',503);
  const data = await response.json().catch(() => null);
  return data?.id === messageId && data.from === groupId && data.fromMe === false &&
    data.participant === message.senderId && typeof data.body === 'string' && data.body.trim() === message.text;
}
