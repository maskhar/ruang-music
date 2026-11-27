let activeRoom = (()=>{try{return localStorage.getItem('ruang-musik-room')||'default';}catch{return 'default';}})();
export function setActiveRoom(id: string) { activeRoom = id; try { localStorage.setItem('ruang-musik-room', id); } catch { /* Optional persistence. */ } }
export function getActiveRoom() { return activeRoom; }
export async function api<T = any>(path: string, method = 'GET', body?: unknown, roomId = activeRoom): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['/api/session','/api/login','/api/logout','/api/rooms','/api/invitations/accept'].includes(path)) headers['X-Room-Id'] = roomId;
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Permintaan gagal.'); return data;
}
