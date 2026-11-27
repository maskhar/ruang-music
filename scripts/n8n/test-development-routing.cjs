const test = require('node:test');
const assert = require('node:assert/strict');
const { parserCode, formatterCode, prepare } = require('./update-development-routing.cjs');

function parse(payload, session = 'carubra') {
  return new Function('$json', parserCode())({event: 'message', session, payload});
}
function format(httpResponse, command) {
  return new Function('$json', '$', formatterCode())(httpResponse, () => ({first: () => ({json: command})}));
}

test('development parser passes valid group and session for backend room routing', () => {
  const payload = {from: '123456789@g.us', participant: '628123@c.us', id: 'message-1', body: '/play lagu'};
  assert.deepEqual(parse(payload), [{json: {
    session: 'carubra', groupId: payload.from, senderId: payload.participant,
    messageId: payload.id, text: payload.body, requester: 'Anggota WhatsApp'
  }}]);
  assert.deepEqual(parse(payload, 'unknown'), []);
  assert.deepEqual(parse({...payload, from: '628123@c.us'}), []);
  assert.deepEqual(parse({...payload, fromMe: true}), []);
  assert.deepEqual(parse({...payload, hasMedia: true}), []);
  assert.deepEqual(parse({...payload, body: 'hello'}), []);
});

test('development formatter only replies to backend-confirmed commands', () => {
  const command = {groupId: '123456789@g.us', messageId: 'message-1'};
  assert.deepEqual(format({statusCode: 200, body: {reply: 'Masuk antrean'}}, command), [{json: {
    chatId: command.groupId, messageId: command.messageId, reply: 'Masuk antrean'
  }}]);
  assert.deepEqual(format({statusCode: 403, body: {error: 'Grup tidak diizinkan'}}, command), []);
  assert.deepEqual(format({statusCode: 500, body: {error: 'Server gagal'}}, command), []);
  assert.deepEqual(format({statusCode: 200, body: {reply: 'Sudah diproses', duplicate: true}}, command), []);
  assert.deepEqual(format({error: 'Connection refused'}, command), []);
});

test('prepare retains existing webhook and credentials', () => {
  const nodes = [
    {name: 'WAHA Trigger', webhookId: 'original'},
    {name: 'Validasi grup dan peminta', parameters: {jsCode: 'old'}},
    {name: 'Request Ruang Musik', parameters: {url: 'http://dev-spotify-player:3210/api/integrations/whatsapp'}, retryOnFail: false, credentials: {httpHeaderAuth: {id: 'dev'}}},
    {name: 'Siapkan balasan aplikasi', parameters: {jsCode: 'old'}},
    {name: 'Reply WhatsApp', parameters: {jsonBody: '={{ JSON.stringify({session:"carubra"}) }}'}, credentials: {wahaApi: {id: 'waha'}}}
  ];
  const before = {id: 'xanTFAOSvArYVB9E', active: true, name: 'DEVELOPMENT', nodes, connections: {}, settings: {}};
  const prepared = prepare(before);
  assert.equal(prepared.nodes[0].webhookId, 'original');
  assert.equal(prepared.nodes[2].credentials.httpHeaderAuth.id, 'dev');
  assert.equal(prepared.nodes[4].credentials.wahaApi.id, 'waha');
  assert.equal(nodes[1].parameters.jsCode, 'old');
});
