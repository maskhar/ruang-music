// Copy to n8n /tmp and run there. Preview by default. --deploy updates both
// existing workflows after the room-aware production backend is healthy.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const PRODUCTION_ID = 'mMKGZXtIS2uvso8W';
const DEVELOPMENT_ID = 'xanTFAOSvArYVB9E';
const PRODUCTION_URL = 'http://spotify-player:3210/api/integrations/whatsapp';
const DEVELOPMENT_URL = 'http://dev-spotify-player:3210/api/integrations/whatsapp';
const CONFIG_PATH = '/tmp/production-routing-config.json';

function parserCode(groups, mode) {
  const allowed = mode === 'development' ? '!' : '';
  const groupCheck = `${allowed}${JSON.stringify(groups)}.includes(group)`;
  return `const event = $json.body ?? $json;
const payload = event.payload ?? {};
const group = String(payload.from ?? '');
const sender = String(payload.participant ?? '');
const command = String(payload.body ?? '').trim();
if (event.session !== 'carubra' || event.event !== 'message' ||
    payload.fromMe === true || payload.hasMedia === true ||
    !/^\\d+@g\\.us$/.test(group) || ${groupCheck} ||
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
const status = Number(response.statusCode ?? 0);
if (status < 200 || status >= 300 || body.duplicate === true ||
    typeof body.reply !== 'string' || !body.reply) return [];
return [{json: {
  chatId: command.groupId,
  messageId: command.messageId,
  reply: body.reply
}}];`;
}

function existingProductionGroups(workflow) {
  const code = workflow.nodes.find(node => node.name === 'Validasi grup dan peminta')?.parameters?.jsCode || '';
  const match = code.match(/!\s*(\[[^\]]+\])\.includes\(p\.from\)/);
  assert.ok(match, 'Production parser no longer has expected static group list');
  const groups = JSON.parse(match[1]);
  assert.ok(Array.isArray(groups) && groups.every(group => /^\d+@g\.us$/.test(group)));
  return groups;
}

function prepare(workflow, mode, developmentGroups) {
  const expectedId = mode === 'production' ? PRODUCTION_ID : DEVELOPMENT_ID;
  const expectedUrl = mode === 'production' ? PRODUCTION_URL : DEVELOPMENT_URL;
  assert.equal(workflow.id, expectedId);
  assert.equal(workflow.active, true, `${mode} workflow is inactive`);
  assert.equal(workflow.activeVersionId, workflow.versionId, `${mode} has unpublished edits`);
  const nodes = structuredClone(workflow.nodes);
  const node = name => {
    const found = nodes.find(item => item.name === name);
    assert.ok(found, `Missing ${mode} node ${name}`);
    return found;
  };
  const trigger = node('WAHA Trigger');
  const parser = node('Validasi grup dan peminta');
  const request = node('Request Ruang Musik');
  const formatter = node('Siapkan balasan aplikasi');
  const reply = node('Reply WhatsApp');
  assert.ok(trigger.webhookId);
  assert.equal(request.parameters.url, expectedUrl);
  assert.ok(request.credentials?.httpHeaderAuth?.id);
  assert.equal(request.retryOnFail, false);
  assert.match(reply.parameters.jsonBody, /session:\s*["']carubra["']/);
  assert.ok(reply.credentials?.wahaApi?.id);
  assert.ok(workflow.connections?.['WAHA Trigger']?.main?.[1]?.some(edge => edge.node === parser.name));
  parser.parameters.jsCode = parserCode(developmentGroups, mode);
  formatter.parameters.jsCode = formatterCode();
  return {
    name: workflow.name,
    nodes,
    connections: workflow.connections,
    settings: workflow.settings,
    staticData: workflow.staticData
  };
}

function validateConfig(config, productionGroups) {
  const groups = config.developmentGroups;
  assert.ok(Array.isArray(groups) && groups.length > 0, 'Specify developmentGroups');
  assert.ok(groups.every(group => typeof group === 'string' && /^\d+@g\.us$/.test(group) && group !== '0@g.us'));
  assert.equal(new Set(groups).size, groups.length, 'Duplicate development group');
  assert.ok(groups.every(group => !productionGroups.includes(group)), 'Development group overlaps production');
  return groups;
}

async function checkBackend(url, environment) {
  const response = await fetch(url, {signal: AbortSignal.timeout(10000)});
  assert.equal(response.status, 200, `${environment} backend unhealthy`);
  const health = await response.json();
  assert.equal(health.rooms, true, `${environment} backend lacks room routing`);
}

async function restore(api, workflow) {
  const draft = await api(`/workflows/${workflow.id}`, 'PUT', {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings,
    staticData: workflow.staticData
  });
  await api(`/workflows/${workflow.id}/activate`, 'POST', {versionId:draft.versionId});
}

async function deploy(api, production, development, config) {
  const productionGroups = existingProductionGroups(production);
  const groups = validateConfig(config, productionGroups);
  if (process.argv.includes('--deploy')) {
    assert.equal(config.productionBlockedDevelopmentGroups,true,
      'Confirm production WHATSAPP_BLOCKED_GROUP_IDS includes every development group');
  }
  const proposedDev = prepare(development, 'development', groups);
  const proposedProd = prepare(production, 'production', groups);
  for (const [group, shouldRouteDev] of [[groups[0], true], [productionGroups[0], false]]) {
    const event = {session:'carubra',event:'message',payload:{from:group,participant:'628123@c.us',id:'preview',body:'/help'}};
    const parseDev = new Function('$json', proposedDev.nodes.find(node => node.name === 'Validasi grup dan peminta').parameters.jsCode);
    const parseProd = new Function('$json', proposedProd.nodes.find(node => node.name === 'Validasi grup dan peminta').parameters.jsCode);
    assert.equal(parseDev(event).length, Number(shouldRouteDev));
    assert.equal(parseProd(event).length, Number(!shouldRouteDev));
  }
  if (!process.argv.includes('--deploy')) {
    console.log('Preview passed. Development ingress restricted; production parser routes other groups. No changes made.');
    return;
  }
  await Promise.all([
    checkBackend('http://spotify-player:3210/healthz', 'Production'),
    checkBackend('http://dev-spotify-player:3210/healthz', 'Development')
  ]);
  const current = await Promise.all([
    api(`/workflows/${DEVELOPMENT_ID}`),
    api(`/workflows/${PRODUCTION_ID}`)
  ]);
  assert.equal(current[0].versionId, development.versionId, 'Development workflow changed before cutover');
  assert.equal(current[1].versionId, production.versionId, 'Production workflow changed before cutover');
  const backupPath = `/tmp/spotify-room-routing-${Date.now()}.json`;
  fs.writeFileSync(backupPath, JSON.stringify({production,development}), {flag:'wx',mode:0o600});
  const originals = [development,production];
  const proposals = [proposedDev,proposedProd];
  const changed = [];
  try {
    for (let i=0; i<2; i++) {
      const before = originals[i];
      changed.push(before);
      const draft = await api(`/workflows/${before.id}`, 'PUT', proposals[i]);
      await api(`/workflows/${before.id}/activate`, 'POST', {versionId:draft.versionId});
      const saved = await api(`/workflows/${before.id}`);
      assert.equal(saved.active,true);
      assert.equal(saved.versionId,saved.activeVersionId, 'Published version differs from saved version');
      assert.equal(saved.nodes.find(node => node.name === 'WAHA Trigger').webhookId,
        before.nodes.find(node => node.name === 'WAHA Trigger').webhookId);
      assert.equal(saved.nodes.find(node => node.name === 'Validasi grup dan peminta').parameters.jsCode,
        proposals[i].nodes.find(node => node.name === 'Validasi grup dan peminta').parameters.jsCode);
      assert.equal(saved.nodes.find(node => node.name === 'Siapkan balasan aplikasi').parameters.jsCode,
        formatterCode());
      assert.equal(saved.nodes.find(node => node.name === 'Request Ruang Musik').retryOnFail,false);
    }
  } catch (error) {
    for (const original of changed.reverse()) {
      try { await restore(api,original); }
      catch (rollbackError) { console.error(`Rollback failed for ${original.id}: ${rollbackError.message}`); }
    }
    throw error;
  }
  console.log(`Routing published and verified. Backup: ${backupPath}`);
}

async function main() {
  const {api} = require('/tmp/api.cjs');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8'));
  const [production,development] = await Promise.all([
    api(`/workflows/${PRODUCTION_ID}`),api(`/workflows/${DEVELOPMENT_ID}`)
  ]);
  await deploy(api,production,development,config);
}

module.exports = {parserCode,formatterCode,existingProductionGroups,prepare,validateConfig};
if (require.main === module) main().catch(error => {
  console.error(`Routing cutover failed: ${error.message}`);
  process.exitCode = 1;
});
