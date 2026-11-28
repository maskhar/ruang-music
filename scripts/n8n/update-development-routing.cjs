// Copy this script to the n8n container and run with --deploy after the backend
// accepts session-aware WhatsApp commands. A run without --deploy is read-only.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const WORKFLOW_ID = 'xanTFAOSvArYVB9E';
const BACKEND_URL = 'http://dev-spotify-player:3210/api/integrations/whatsapp';

function parserCode() {
  return `const event = $json.body ?? $json;
const payload = event.payload ?? {};
const group = String(payload.from ?? '');
const sender = String(payload.participant ?? '');
const command = String(payload.body ?? '').trim();
if (event.session !== 'carubra' || event.event !== 'message' ||
    payload.fromMe === true || payload.hasMedia === true ||
    !/^\\d+@g\\.us$/.test(group) ||
    !/^\\d+@(?:c\\.us|s\\.whatsapp\\.net|lid)$/.test(sender) ||
    !command.startsWith('/') || !payload.id) return [];
return [{json: {
  session: event.session,
  groupId: group,
  senderId: sender,
  messageId: payload.id,
  text: command,
  requester: String(payload._data?.notifyName ?? payload.pushName ?? 'Anggota WhatsApp').slice(0, 60)
}}];`;
}

function formatterCode() {
  return `const command = $('Validasi grup dan peminta').first().json;
const response = $json;
const body = response.body ?? response;
const status = Number(response.statusCode ?? 200);
if (status < 200 || status >= 300 || body.duplicate === true ||
    typeof body.reply !== 'string' || !body.reply) return [];
return [{json: {
  chatId: command.groupId,
  messageId: command.messageId,
  reply: body.reply
}}];`;
}

function prepare(current) {
  assert.equal(current.id, WORKFLOW_ID);
  assert.equal(current.active, true, 'Development workflow must be active');
  const nodes = structuredClone(current.nodes);
  const getNode = (name) => {
    const node = nodes.find((item) => item.name === name);
    assert.ok(node, `Missing node ${name}`);
    return node;
  };
  const trigger = getNode('WAHA Trigger');
  const parser = getNode('Validasi grup dan peminta');
  const request = getNode('Request Ruang Musik');
  const formatter = getNode('Siapkan balasan aplikasi');
  const reply = getNode('Reply WhatsApp');
  assert.ok(trigger.webhookId, 'Existing WAHA webhook must be preserved');
  assert.equal(request.parameters.url, BACKEND_URL, 'Workflow is not pointed at development backend');
  assert.match(reply.parameters.jsonBody, /session:["']carubra["']/);
  assert.equal(request.retryOnFail, false);
  parser.parameters.jsCode = parserCode();
  formatter.parameters.jsCode = formatterCode();
  return {
    name: current.name,
    nodes,
    connections: current.connections,
    settings: current.settings,
    staticData: current.staticData
  };
}

async function main() {
  const { api } = require('/tmp/api.cjs');
  const before = await api(`/workflows/${WORKFLOW_ID}`);
  const proposed = prepare(before);
  const triggerBefore = before.nodes.find((node) => node.name === 'WAHA Trigger');
  const triggerAfter = proposed.nodes.find((node) => node.name === 'WAHA Trigger');
  assert.equal(triggerAfter.webhookId, triggerBefore.webhookId);
  if (!process.argv.includes('--deploy')) {
    console.log('Development adapter ready; run --deploy to publish. Workflow and webhook unchanged.');
    return;
  }
  const health = await fetch('http://dev-spotify-player:3210/healthz', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.ok && (await health.json()).rooms, true, 'Development room backend is unavailable');
  const backup = `/tmp/${WORKFLOW_ID}-before-room-routing.json`;
  fs.writeFileSync(backup, JSON.stringify(before), { flag: 'wx', mode: 0o600 });
  const latest = await api(`/workflows/${WORKFLOW_ID}`);
  assert.equal(latest.versionId, before.versionId, 'Workflow changed during preparation');
  await api(`/workflows/${WORKFLOW_ID}`, 'PUT', proposed);
  try {
    await api(`/workflows/${WORKFLOW_ID}/activate`, 'POST', {});
    const saved = await api(`/workflows/${WORKFLOW_ID}`);
    assert.equal(saved.active, true);
    assert.equal(saved.nodes.find((node) => node.name === 'WAHA Trigger').webhookId, triggerBefore.webhookId);
    assert.equal(saved.nodes.find((node) => node.name === 'Validasi grup dan peminta').parameters.jsCode, parserCode());
    console.log(`Development adapter updated: ${WORKFLOW_ID}. Backup: ${backup}`);
  } catch (error) {
    await api(`/workflows/${WORKFLOW_ID}`, 'PUT', {
      name: before.name,
      nodes: before.nodes,
      connections: before.connections,
      settings: before.settings,
      staticData: before.staticData
    });
    await api(`/workflows/${WORKFLOW_ID}/activate`, 'POST', {});
    throw error;
  }
}

module.exports = { parserCode, formatterCode, prepare };
if (require.main === module) main().catch((error) => {
  console.error(`Development adapter update failed: ${error.message}`);
  process.exitCode = 1;
});
