import { useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from './api';

type Participant = { id: string; phone: string | null; allowed: boolean };
type ControlList = { groupId: string; participants: Participant[]; unmatchedPermissions: boolean };

export function WhatsappControls({ roomId }: { roomId: string }) {
  const [groups, setGroups] = useState<string[]>([]);
  const [groupId, setGroupId] = useState('');
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [unmatchedPermissions, setUnmatchedPermissions] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('groups');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void api<{ groups: string[] }>(`/api/rooms/${roomId}/whatsapp/control-groups`, 'GET', undefined, roomId)
      .then(result => { if (!active) return; setGroups(result.groups); setGroupId(result.groups[0] || ''); })
      .catch(() => { if (active) setError('Daftar grup tidak dapat dimuat. Tutup lalu buka kembali pengaturan.'); })
      .finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [roomId]);

  async function load() {
    if (!groupId || busy) return;
    setBusy('load'); setError(''); setMessage(''); setParticipants(null); setSelected([]);
    try {
      const result = await api<ControlList>(`/api/rooms/${roomId}/whatsapp/controls?groupId=${encodeURIComponent(groupId)}`, 'GET', undefined, roomId);
      setParticipants(result.participants);
      setUnmatchedPermissions(result.unmatchedPermissions);
      setSelected(result.participants.filter(item => item.allowed).map(item => item.id));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  async function save() {
    if (!groupId || !participants || busy) return;
    setBusy('save'); setError(''); setMessage('');
    try {
      await api(`/api/rooms/${roomId}/whatsapp/controls`, 'PUT', { groupId, participantIds: selected }, roomId);
      setParticipants(previous => previous?.map(item => ({ ...item, allowed: selected.includes(item.id) })) || null);
      setUnmatchedPermissions(false);
      setMessage(selected.length ? `Akses kontrol disimpan untuk ${selected.length} anggota.` : 'Whitelist kosong. Semua kontrol WhatsApp /next, /stop, /pause, dan /volume terkunci.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  const term = search.trim().toLowerCase();
  const displayed = participants?.filter(item => (item.phone || '').toLowerCase().includes(term) || item.id.includes(term)) || [];
  const changed = !!participants && (unmatchedPermissions || participants.some(item => item.allowed !== selected.includes(item.id)));
  return <section className="room-admin-panel whatsapp-controls" aria-labelledby="whatsapp-controls-title">
    <h3 id="whatsapp-controls-title"><ShieldCheck size={18} aria-hidden="true"/> Akses kontrol WhatsApp</h3>
    <p>Hanya anggota terpilih boleh memakai /next, /stop, /pause, dan /volume. Request lagu tetap mengikuti izin grup.</p>
    {groups.length > 1 && <><label htmlFor="controls-group">Grup</label><select id="controls-group" value={groupId} disabled={!!busy} onChange={event => { setGroupId(event.target.value); setParticipants(null); setSelected([]); setSearch(''); setMessage(''); setError(''); }}>{groups.map(group => <option key={group} value={group}>{group}</option>)}</select></>}
    {groups.length === 1 && <p className="control-group-label">Grup: <code>{groupId}</code></p>}
    {busy === 'groups' && <p role="status"><LoaderCircle className="spin" size={16}/> Memuat daftar grup…</p>}
    {!busy && !groups.length && !error && <p>Belum ada grup terhubung untuk ruang ini.</p>}
    {!!groups.length && <button type="button" className="secondary" onClick={() => void load()} disabled={!!busy}>
      {busy === 'load' ? <LoaderCircle className="spin" size={16} aria-hidden="true"/> : <RefreshCw size={16} aria-hidden="true"/>}
      {busy === 'load' ? 'Memuat anggota grup…' : participants ? 'Muat ulang anggota grup' : 'Muat anggota grup'}
    </button>}
    {error && <p className="danger-text" role="alert">{error}</p>}
    {participants && <>
      <p className="control-warning">Whitelist kosong mengunci empat kontrol ini, termasuk aliasnya.</p>
      {unmatchedPermissions && <p className="control-warning">Sebagian izin lama tidak cocok dengan daftar anggota saat ini. Simpan untuk menerapkan izin sesuai pilihan di bawah.</p>}
      <label htmlFor="controls-search">Cari anggota grup</label><input id="controls-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nomor atau ID WAHA"/>
      <div className="control-list" role="group" aria-label="Anggota yang diizinkan mengontrol musik">
        {displayed.length ? displayed.map(item => <label className="control-member" key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={!!busy} onChange={event => setSelected(previous => event.target.checked ? [...previous,item.id] : previous.filter(id => id !== item.id))}/><span>{item.phone || item.id}</span></label>) : <p>{participants.length ? 'Tidak ada anggota cocok.' : 'Grup belum memiliki anggota yang dapat dipilih.'}</p>}
      </div>
      <button type="button" className="primary" disabled={!!busy || !changed} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} Simpan akses kontrol ({selected.length})</button>
    </>}
    {message && <p className="control-success" role="status">{message}</p>}
  </section>;
}
