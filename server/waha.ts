import type { Config } from './config.ts';
import { AppError } from './types.ts';

export interface IncomingMessage {
  groupId: string;
  session: string;
  senderId: string;
  messageId: string;
  text: string;
}

export interface WahaJoinInfo {
  groupId: string;
  groupName: string | null;
  requiresApproval: boolean;
}

export type WahaJoinStatus = 'joined' | 'already_member' | 'pending';
const groupIdFormat = /^[0-9]+@g\.us$/;

export interface WahaParticipant {
  id: string;
  phone: string | null;
  aliases: string[];
}

export function normalizeParticipantId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,24})@(c\.us|s\.whatsapp\.net|lid)$/.exec(value);
  if (!match) return null;
  return match[1] + (match[2] === 'lid' ? '@lid' : '@c.us');
}

function normalizePhoneId(value: unknown) {
  if (typeof value === 'string' && /^\+?\d{1,24}$/.test(value)) return value.replace(/^\+/,'')+'@c.us';
  const id = normalizeParticipantId(value);
  return id?.endsWith('@c.us') ? id : null;
}

export function inviteCodeFromUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new AppError('Tempel link undangan grup WhatsApp yang valid.'); }
  const code = url.pathname.match(/^\/([A-Za-z0-9_-]{18,64})\/?$/)?.[1];
  const query = [...url.searchParams];
  const whatsappQuery = !query.length || (query.length === 1 && query[0][0] === 'mode' && /^[A-Za-z0-9_-]{1,32}$/.test(query[0][1]));
  if (url.origin !== 'https://chat.whatsapp.com' || url.username || url.password || url.hash || !code || !whatsappQuery) {
    throw new AppError('Gunakan link undangan dari https://chat.whatsapp.com/.');
  }
  return code;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string,unknown>;
  return {};
}

function groupIdFrom(value: unknown): string | null {
  if (typeof value === 'string') return groupIdFormat.test(value) ? value : null;
  const wid = asRecord(value);
  if (typeof wid._serialized === 'string') return groupIdFrom(wid._serialized);
  return wid.server === 'g.us' && typeof wid.user === 'string' ? groupIdFrom(wid.user + '@g.us') : null;
}

function wahaGroupsPath(config: Config) {
  return '/api/' + encodeURIComponent(config.wahaSession) + '/groups';
}

async function wahaGroupRequest(config: Config, path: string, body?: {code: string}, signal = AbortSignal.timeout(body ? 12000 : 6000)) {
  if (!config.wahaUrl || !config.wahaKey) throw new AppError('WhatsApp belum dikonfigurasi.',503);
  const headers: Record<string,string> = {'X-Api-Key':config.wahaKey};
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(config.wahaUrl.replace(/\/$/,'') + path, {
    method:body ? 'POST' : 'GET',
    headers,
    body:body ? JSON.stringify(body) : undefined,
    redirect:'error',
    signal
  }).catch(() => { throw new AppError('WAHA belum merespons. Periksa apakah Carubra sudah masuk ke grup.',503); });
}

export async function getWahaGroupParticipants(config: Config, groupId: string): Promise<WahaParticipant[]> {
  if (!groupIdFormat.test(groupId)) throw new AppError('ID grup WhatsApp tidak valid.');
  const response = await wahaGroupRequest(config,wahaGroupsPath(config)+'/'+encodeURIComponent(groupId)+'/participants/v2');
  const rows: unknown = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(rows)) {
    throw new AppError('Daftar anggota grup belum bisa diperiksa. Pastikan Carubra masih berada di grup.',503);
  }
  const participants = new Map<string,WahaParticipant>();
  let activeRows = 0;
  for (const row of rows) {
    const {id:rawId,pn,role} = asRecord(row);
    if (role === 'left') continue;
    activeRows++;
    const participant = normalizeParticipantId(rawId);
    const phoneId = normalizePhoneId(pn);
    const id = participant || phoneId;
    if (!id) continue;
    const aliases = id.endsWith('@lid') && phoneId ? [id,phoneId] : [id];
    if (participants.get(id)?.phone && !phoneId) continue;
    const phone = aliases.find(alias => alias.endsWith('@c.us'))?.split('@')[0];
    participants.set(id,{id,phone:phone ? '+'+phone : null,aliases});
  }
  if (activeRows && !participants.size) throw new AppError('Identitas anggota grup belum bisa dibaca.',503);
  for (const {id,aliases} of participants.values()) {
    if (id.endsWith('@lid') && aliases[1]) participants.delete(aliases[1]);
  }
  return [...participants.values()];
}

export async function getWahaParticipantAlias(config: Config, id: string, signal?: AbortSignal): Promise<string | null> {
  const canonical = normalizeParticipantId(id);
  if (!canonical) return null;
  const fromLid = canonical.endsWith('@lid');
  const path = '/api/'+encodeURIComponent(config.wahaSession)+'/lids/'+(fromLid ? '' : 'pn/')+encodeURIComponent(canonical);
  try {
    const response = await wahaGroupRequest(config,path,undefined,signal);
    if (!response.ok) return null;
    const mapping = asRecord(await response.json());
    const lid = normalizeParticipantId(mapping.lid), phone = normalizePhoneId(mapping.pn);
    if (!lid?.endsWith('@lid') || !phone) return null;
    if (fromLid) return lid === canonical ? phone : null;
    return phone === canonical ? lid : null;
  } catch {
    return null;
  }
}

export async function getWahaJoinInfo(config: Config, code: string): Promise<WahaJoinInfo> {
  const response = await wahaGroupRequest(config,wahaGroupsPath(config) + '/join-info?' + new URLSearchParams({code}));
  const info = asRecord(await response.json().catch(() => null));
  if (!response.ok) {
    if ([400,404,410,422].includes(response.status)) throw new AppError('Link undangan tidak valid atau sudah kedaluwarsa.',400);
    throw new AppError('Info grup belum bisa diperiksa. Coba salin link terbaru atau tambahkan Carubra secara manual.',502);
  }
  const metadata = asRecord(info.groupMetadata);
  const groupId = groupIdFrom(info.gid) ?? groupIdFrom(info.id) ?? groupIdFrom(info.groupId) ?? groupIdFrom(metadata.id);
  if (!groupId) throw new AppError('ID grup belum bisa diverifikasi dari link undangan.',502);
  const displayName = [info.subject,info.name,info.subjectName,metadata.subject,asRecord(info.subject).subject]
    .find((item): item is string => typeof item === 'string' && !!item.trim());
  const approval = [info.membershipApprovalMode,info.newMembersApprovalRequired,info.approvalRequired,
    metadata.membershipApprovalMode,metadata.newMembersApprovalRequired];
  return {groupId,groupName:displayName?.trim().slice(0,120) ?? null,
    requiresApproval:approval.some(value=>value === true || value === 1 || value === 'on')};
}

export async function joinWahaGroup(config: Config, code: string, info: WahaJoinInfo): Promise<WahaJoinStatus> {
  const session = await wahaGroupRequest(config,'/api/sessions/' + encodeURIComponent(config.wahaSession));
  const me = asRecord(asRecord(await session.json().catch(() => null)).me);
  const ownIds = new Set([me.id, me.lid].filter((id): id is string => typeof id === 'string' && !!id));
  if (!session.ok || !ownIds.size) throw new AppError('Session WhatsApp Carubra belum siap.',503);

  const path = wahaGroupsPath(config);
  const confirmsMembership = async () => {
    try {
      const response = await wahaGroupRequest(config,path + '/' + encodeURIComponent(info.groupId) + '/participants/v2');
      if (!response.ok) return false;
      const participants: unknown = await response.json();
      return Array.isArray(participants) && participants.some(row => {
        const {id,pn} = asRecord(row);
        return [id,pn].some(value=>typeof value === 'string' && ownIds.has(value));
      });
    } catch { return false; }
  };

  if (await confirmsMembership()) return 'already_member';
  const response = await wahaGroupRequest(config,path + '/join',{code});
  if (!response.ok) {
    if ([400,404,410,422].includes(response.status)) throw new AppError('Undangan WhatsApp ditolak atau sudah kedaluwarsa.',400);
    throw new AppError('WhatsApp belum mengonfirmasi permintaan bergabung. Periksa grup sebelum mencoba lagi.',502);
  }
  const joined = asRecord(await response.json().catch(() => null));
  if (groupIdFrom(joined.id) !== info.groupId) throw new AppError('WhatsApp tidak mengonfirmasi grup yang dipilih.',502);
  return await confirmsMembership() ? 'joined' : 'pending';
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
