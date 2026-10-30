import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mapLink, canonicalTarget } from '../shared/link-map.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DAY=24*60*60*1000;
const fields=new Set(['version','site','type','eventId','pagePath','targetId','targetHost','targetCanonical','unreviewed','traffic','testRunId','sessionToken']);
function fail(statusCode,code,message=code){const e=new Error(message);e.statusCode=statusCode;e.code=code;throw e;}
function digest(value){return createHash('sha256').update(value).digest('hex');}
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');

export function createCollector({ config, catalog, rules, reader, receipts, fetchImpl=fetch, now=Date.now, onAccepted=()=>{} }) {
  const key=Buffer.from(config.tokenSecret,'base64url');
  if(key.length!==32)throw new Error('COLLECTOR_TOKEN_SECRET must encode exactly 32 bytes.');
  const targets=new Map(catalog.targets.map(t=>[t.id,t]));
  const reviewedIdentities=new Map(catalog.targets.map(known=>{
    const canonicals=new Set([known.canonical]),hosts=new Set([known.host]);
    const rule=rules.targets.find(row=>row[0]===known.id);
    for(const value of rule?[rule[4],...(rule[5]||[])]:[]){
      const href=value.startsWith('download:')?value.slice(9):value;
      try{
        const link={href,download:known.kind==='download',attrs:{}};
        const mapped=mapLink(link,rules),variant=canonicalTarget(href,{origin:rules.origin,download:link.download});
        if(mapped?.id===known.id&&mapped.reviewed&&mapped.kind===known.kind&&variant){
          canonicals.add(variant.key);hosts.add(mapped.host);
        }
      }catch{/* Invalid/unreviewed variants never widen the accepted identity. */}
    }
    return [known.id,{canonicals,hosts}];
  }));
  const active=new Map();
  let inFlight=0;
  const rate=new Map();
  const nativeSecret=createHash('sha512').update(config.umamiAppSecret).digest('hex');
  function seal(value){
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
  }
  function open(token){
    if(typeof token!=='string'||!token||token.length>8192)return null;
    try{
      const data=Buffer.from(token,'base64url');
      const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
      decipher.setAuthTag(data.subarray(12,28));
      const value=JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8'));
      if(value.v!==1||value.websiteId!==config.websiteId||!UUID.test(value.identityId)||!Number.isFinite(value.expiresAt)||value.expiresAt<=now()||value.expiresAt>now()+DAY+1000||typeof value.cache!=='string'||value.cache.length>4096)return null;
      return value;
    }catch{return null;}
  }
  function nativeCache(found){
    const encoded=b64({alg:'HS256',typ:'JWT'})+'.'+b64({websiteId:config.websiteId,sessionId:found.sessionId,visitId:found.visitId,iat:Math.floor(Date.parse(found.createdAt)/1000),type:'cache'});
    return encoded+'.'+createHmac('sha256',nativeSecret).update(encoded).digest('base64url');
  }
  function validate(body){
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!fields.has(k)))fail(400,'invalid_fields');
    if(body.version!==1||body.site!=='hub'||!UUID.test(body.eventId||'')||!['pageview','outbound_click','download_click','mapping_issue'].includes(body.type))fail(400,'invalid_event');
    if(!['/','/index.html'].includes(body.pagePath))fail(400,'invalid_page');
    if(!['production','test'].includes(body.traffic)||body.traffic==='test'&&!config.allowTestTraffic)fail(400,'invalid_traffic');
    if(body.traffic==='test'&&!/^[A-Za-z0-9_-]{1,64}$/.test(body.testRunId||''))fail(400,'invalid_test_run');
    if(body.traffic==='production'&&body.testRunId!==undefined)fail(400,'invalid_test_run');
    if(body.sessionToken!==undefined&&(typeof body.sessionToken!=='string'||body.sessionToken.length>8192))fail(400,'invalid_session');
    const clean={version:1,site:'hub',type:body.type,eventId:body.eventId.toLowerCase(),pagePath:'/',traffic:body.traffic};
    if(body.traffic==='test')clean.testRunId=body.testRunId;
    if(body.type==='pageview'){
      if(['targetId','targetHost','targetCanonical','unreviewed'].some(k=>body[k]!==undefined))fail(400,'unexpected_target');
      return clean;
    }
    if(typeof body.targetCanonical!=='string'||body.targetCanonical.length>500||typeof body.targetHost!=='string'||body.targetHost.length>255||/[\r\n]/.test(body.targetHost))fail(400,'invalid_target');
    if(body.type==='mapping_issue'){
      const target=canonicalTarget(body.targetCanonical,{origin:rules.origin});
      if(!target||target.key!==body.targetCanonical||target.query.length||target.host!==body.targetHost)fail(400,'invalid_diagnostic');
      return {...clean,targetHost:target.host,targetCanonical:target.key};
    }
    if(!ID.test(body.targetId||'')||typeof body.unreviewed!=='boolean')fail(400,'invalid_target');
    const known=targets.get(body.targetId);
    if(known){
      // Current clients report the primary canonical plus the actual alias host;
      // cached pre-migration clients may still report an explicitly reviewed old
      // canonical. Both normalize to the authoritative catalog metadata below.
      const identity=reviewedIdentities.get(known.id);
      if(!identity.canonicals.has(body.targetCanonical)||!identity.hosts.has(body.targetHost)||body.type!==(known.kind==='download'?'download_click':'outbound_click'))fail(400,'target_mismatch');
      return {...clean,targetId:known.id,targetHost:known.host,targetCanonical:known.canonical,unreviewed:false};
    }
    // A new ordinary destination may be reported under the shared stable-ID
    // algorithm. Arbitrary new semantic IDs must first enter the reviewed catalog.
    const href=body.targetCanonical.startsWith('download:')?body.targetCanonical.slice(9):body.targetCanonical;
    let mapped;try{mapped=mapLink({href,download:body.type==='download_click',attrs:{}},rules);}catch{fail(400,'unreviewed_target');}
    if(!mapped||mapped.id!==body.targetId||mapped.canonical!==body.targetCanonical||mapped.host!==body.targetHost||!body.unreviewed)fail(400,'unreviewed_target');
    return {...clean,targetId:mapped.id,targetHost:mapped.host,targetCanonical:mapped.canonical,unreviewed:true};
  }
  function limit(ownerHash){
    const time=now();
    for(const [k,v] of rate)if(v.until<=time)rate.delete(k);
    const entry=rate.get(ownerHash)||{count:0,until:time+60000};
    if(entry.count>=3000||inFlight>=24||(!rate.has(ownerHash)&&rate.size>=10000))fail(429,'collection_busy');
    entry.count++;rate.set(ownerHash,entry);
  }
  function response(identityId,cache,expiresAt){
    return {accepted:true,sessionToken:seal({v:1,websiteId:config.websiteId,identityId,cache,expiresAt}),expiresAt};
  }
  async function process(clean,client,session,ownerHash,payloadHash){
    const freshIdentity=session?.identityId||randomUUID();
    const identityExpiry=session?.expiresAt||now()+DAY;
    const reservation=await receipts.reserve({eventId:clean.eventId,ownerHash,payloadHash,identityId:freshIdentity,expiresAt:new Date(identityExpiry).toISOString()});
    const receipt=reservation.receipt;
    const expiresAt=Date.parse(receipt.expiresAt);
    if(expiresAt<=now())fail(410,'identity_expired');
    if(receipt.response)return receipt.response;
    if(!reservation.created){
      const found=await reader.findEventByTag(clean.eventId);
      if(found){const restored=response(receipt.identityId,nativeCache(found),expiresAt);return await receipts.complete(clean.eventId,restored);}
      if(!await receipts.claimRetry(clean.eventId,15000))fail(503,'receipt_pending');
    }
    const payload={website:config.websiteId,hostname:config.hubHostname,url:'/',title:'AMD Developer Hub',id:receipt.identityId,ip:client.ip,userAgent:client.userAgent,tag:clean.eventId};
    if(clean.type!=='pageview'){
      payload.name=clean.type==='outbound_click'?'hub_outbound':clean.type==='download_click'?'hub_download':'hub_mapping_issue';
      payload.data=clean.type==='mapping_issue'?{targetCanonical:clean.targetCanonical,targetHost:clean.targetHost,issue:'unreviewed_query'}
        :{targetId:clean.targetId,targetCanonical:clean.targetCanonical,targetHost:clean.targetHost,unreviewed:clean.unreviewed};
    }
    const headers={'Content-Type':'application/json','User-Agent':client.userAgent};
    if(session?.identityId===receipt.identityId&&session.cache)headers['x-umami-cache']=session.cache;
    let upstream,body;
    try{
      upstream=await fetchImpl(config.umamiUrl+'/api/send',{method:'POST',headers,body:JSON.stringify({type:'event',payload}),signal:AbortSignal.timeout(8000),redirect:'error'});
      body=await upstream.json();
    }catch{fail(503,'upstream_unavailable');}
    if(!upstream.ok)fail(503,'upstream_rejected');
    if(body?.beep==='boop'){
      const ignored={accepted:false,ignored:'bot'};return await receipts.complete(clean.eventId,ignored);
    }
    if(typeof body?.cache!=='string'||!UUID.test(body?.visitId||'')||!UUID.test(body?.sessionId||''))fail(503,'upstream_unconfirmed');
    const accepted=response(receipt.identityId,body.cache,expiresAt);
    const saved=await receipts.complete(clean.eventId,accepted);onAccepted();return saved;
  }
  return {
    validate,
    async collect(body,client){
      const clean=validate(body);
      if(!client?.ip||!client?.userAgent)fail(400,'missing_client_context');
      const ownerHash=createHmac('sha256',key).update(client.ip+'\n'+client.userAgent).digest('hex');
      const payloadHash=digest(JSON.stringify(clean));
      const session=open(body.sessionToken);
      if(body.sessionToken&&!session)fail(410,'identity_expired');
      if(!session&&clean.type!=='pageview')fail(409,'session_required');
      limit(ownerHash);
      const taskKey=ownerHash+':'+clean.eventId+':'+payloadHash;
      if(active.has(taskKey))return active.get(taskKey);
      inFlight++;
      const task=process(clean,client,session,ownerHash,payloadHash).catch(error=>{
        if(error.statusCode===410&&error.code==='receipt_expired')fail(410,'identity_expired');
        throw error;
      }).finally(()=>{inFlight--;active.delete(taskKey);});
      active.set(taskKey,task);return task;
    }
  };
}
