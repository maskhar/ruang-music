const test = require('node:test');
const assert = require('node:assert/strict');
const {parserCode,formatterCode,validateConfig,prepare} = require('./update-production-routing.cjs');

const productionGroups = ['12345678901@g.us','12345678902@g.us'];
const developmentGroups = ['12345678903@g.us'];
function parse(mode,group) {
  const fn = new Function('$json',parserCode(developmentGroups,mode));
  return fn({session:'carubra',event:'message',payload:{from:group,participant:'628123@c.us',id:'message-1',body:'/play song'}});
}
function format(response) {
  const code = formatterCode();
  const lookup = () => ({first:()=>({json:{groupId:'12345678903@g.us',messageId:'message-1'}})});
  return new Function('$json','$',code)(response,lookup);
}

test('production parser forwards valid room groups with WAHA session',()=>{
  for(const group of [...productionGroups,'12345678904@g.us']) {
    assert.equal(parse('production',group)[0].json.session,'carubra');
  }
  assert.deepEqual(parse('production',developmentGroups[0]),[]);
  assert.deepEqual(parse('production','628123@c.us'),[]);
});

test('development parser forwards only configured development groups',()=>{
  assert.equal(parse('development',developmentGroups[0]).length,1);
  for(const group of [...productionGroups,'12345678904@g.us']) assert.deepEqual(parse('development',group),[]);
});

test('backend errors, missing status, duplicates, and malformed replies do not reach WAHA',()=>{
  assert.deepEqual(format({statusCode:200,body:{reply:'Terhubung'}}).map(x=>x.json.reply),['Terhubung']);
  for(const response of [
    {statusCode:403,body:{reply:'Wrong workflow'}},
    {statusCode:500,body:{reply:'Server error'}},
    {body:{reply:'Unknown status'}},
    {statusCode:200,body:{reply:'Duplicate',duplicate:true}},
    {statusCode:200,body:{error:'No reply field'}},
    {error:'Network error'}
  ]) assert.deepEqual(format(response),[]);
});

test('development groups must be valid, unique, and disjoint from initial production bindings',()=>{
  assert.deepEqual(validateConfig({developmentGroups},productionGroups),developmentGroups);
  assert.throws(()=>validateConfig({developmentGroups:['invalid']},productionGroups));
  assert.throws(()=>validateConfig({developmentGroups:[developmentGroups[0],developmentGroups[0]]},productionGroups));
  assert.throws(()=>validateConfig({developmentGroups:[productionGroups[0]]},productionGroups));
});

test('workflow preparation preserves webhook IDs, credential IDs, node layout, and connection output',()=>{
  const nodes=['WAHA Trigger','Validasi grup dan peminta','Request Ruang Musik','Siapkan balasan aplikasi','Reply WhatsApp'].map((name,index)=>({
    id:`node-${index}`,name,position:[index*100,0],parameters:{},credentials:{},
    ...(name==='WAHA Trigger'?{webhookId:'webhook-preserved'}:{}),
    ...(name==='Request Ruang Musik'?{retryOnFail:false}: {})
  }));
  Object.assign(nodes[2].parameters,{url:'http://spotify-player:3210/api/integrations/whatsapp'});
  Object.assign(nodes[2].credentials,{httpHeaderAuth:{id:'credential-header'}});
  Object.assign(nodes[4].parameters,{jsonBody:"={{ JSON.stringify({session:'carubra'}) }}"});
  Object.assign(nodes[4].credentials,{wahaApi:{id:'credential-waha'}});
  const workflow={id:'mMKGZXtIS2uvso8W',active:true,activeVersionId:'v1',versionId:'v1',nodes,connections:{'WAHA Trigger':{main:[[],[{node:'Validasi grup dan peminta'}]]}},settings:{executionOrder:'v1'}};
  const prepared=prepare(workflow,'production',developmentGroups);
  assert.equal(prepared.nodes[0].webhookId,'webhook-preserved');
  assert.equal(prepared.nodes[2].credentials.httpHeaderAuth.id,'credential-header');
  assert.equal(prepared.nodes[4].credentials.wahaApi.id,'credential-waha');
  assert.deepEqual(prepared.connections,workflow.connections);
  assert.deepEqual(prepared.nodes.map(node=>node.position),workflow.nodes.map(node=>node.position));
});
