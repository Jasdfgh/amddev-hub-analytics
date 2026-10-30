import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, clientInfo } from './config.mjs';
import { createViewerAuth } from './auth.mjs';
import { createCollector } from './collector.mjs';
import { createReceiptStore } from './receipts.mjs';
import { createUmamiReader } from './umami-reader.mjs';
import { parseReportQuery, buildReport, buildDailyReport } from './reporting.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicFiles=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/dates.js','dates.js'],['/style.css','style.css'],['/favicon.svg','favicon.svg']]);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
function fail(statusCode,code,message=code){const e=new Error(message);e.statusCode=statusCode;e.code=code;throw e;}

export async function startServer(config=loadConfig()){
  const baseCatalog=JSON.parse(await fs.readFile(path.join(root,'shared/catalog.json'),'utf8'));
  const rules=JSON.parse(await fs.readFile(path.join(root,'shared/catalog-rules.json'),'utf8'));
  const reader=createUmamiReader({connectionString:config.readDatabaseUrl,websiteId:config.websiteId,hostname:config.hubHostname});
  await reader.assertReadOnly();
  const receipts=createReceiptStore({connectionString:config.receiptDatabaseUrl});
  const auth=createViewerAuth({passwordHash:config.passwordHash,sessionSecret:config.sessionSecret,secureCookie:config.secureCookie,username:config.viewerUsername});
  let catalogCache=null,catalogUntil=0;
  const factCache=new Map();
  const collector=createCollector({config,catalog:baseCatalog,rules,reader,receipts,onAccepted:()=>{catalogUntil=0;factCache.clear();}});
  const expectedHost=new URL(config.publicOrigin).host;
  let queryActive=0;
  async function catalog(force=false){
    if(!force&&catalogCache&&catalogUntil>Date.now())return catalogCache;
    const known=new Map(baseCatalog.targets.map(t=>[t.id,t]));
    for(const target of await reader.discoverTargets())if(!known.has(target.id))known.set(target.id,target);
    catalogCache={version:baseCatalog.version,categories:baseCatalog.categories,topics:baseCatalog.topics,
      targets:[...known.values()].map(({id,name,category,channel,topics,canonical,kind})=>({id,name,category,channel,topics,canonical,kind}))};
    catalogUntil=Date.now()+10000;return catalogCache;
  }
  function facts(query){
    const key=query.loadStart+':'+query.loadEnd, cached=factCache.get(key);
    if(cached&&cached.until>Date.now())return cached.value;
    if(factCache.size>=100)factCache.delete(factCache.keys().next().value);
    const promise=reader.loadFacts({start:query.loadStart,end:query.loadEnd});
    factCache.set(key,{until:Date.now()+5000,value:promise});
    promise.catch(()=>factCache.delete(key));return promise;
  }
  async function readJson(request,limit){
    if(!String(request.headers['content-type']||'').toLowerCase().startsWith('application/json'))fail(415,'json_required');
    if(Number(request.headers['content-length']||0)>limit)fail(413,'body_too_large');
    const chunks=[];let size=0;
    for await(const chunk of request){size+=chunk.length;if(size>limit)fail(413,'body_too_large');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'invalid_json');}
  }
  const server=http.createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Security-Policy',CSP);
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');
    response.setHeader('X-Robots-Tag','noindex, nofollow');
    if(config.secureCookie)response.setHeader('Strict-Transport-Security','max-age=86400');
    const json=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
    try{
      if(typeof request.url!=='string'||!request.url.startsWith('/')||request.url.startsWith('//'))fail(400,'invalid_request_target');
      const url=new URL(request.url,config.publicOrigin),route=url.pathname;
      if(route==='/healthz'&&request.method==='GET'){json(200,{status:'ok',mode:config.mode});return;}
      if(request.headers.host!==expectedHost)fail(421,'host_not_allowed');
      const origin=request.headers.origin;
      if(route==='/api/collect'){
        if(!origin||!config.allowedOrigins.has(origin))fail(403,'origin_not_allowed');
        response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');
        if(request.method==='OPTIONS'){
          response.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});response.end();return;
        }
        if(request.method!=='POST')fail(405,'method_not_allowed');
        json(200,await collector.collect(await readJson(request,12288),clientInfo(request,config)));return;
      }
      if(route.startsWith('/api/')){
        if(origin&&origin!==config.publicOrigin)fail(403,'origin_not_allowed');
        if(route==='/api/login'){
          if(request.method!=='POST')fail(405,'method_not_allowed');
          const body=await readJson(request,1024);
          if(!body||Array.isArray(body)||Object.keys(body).some(k=>k!=='password'))fail(400,'invalid_fields');
          const logged=await auth.login({password:body.password,clientKey:clientInfo(request,config).ip});
          response.setHeader('Set-Cookie',logged.cookie);
          json(200,{...logged.session,mode:config.mode,collection:{startedAt:config.collectionStartedAt,timezone:'Asia/Shanghai'}});return;
        }
        const session=auth.authenticate(request.headers.cookie);
        if(!session){json(401,{authenticated:false,login:{username:auth.username}});return;}
        if(route==='/api/session'&&request.method==='GET'){
          json(200,{...session,mode:config.mode,collection:{startedAt:config.collectionStartedAt,timezone:'Asia/Shanghai'}});return;
        }
        if(route==='/api/logout'&&request.method==='POST'){
          response.setHeader('Set-Cookie',auth.logout(request.headers.cookie));json(200,{authenticated:false});return;
        }
        // There is deliberately no generic Umami API proxy or write operation.
        if(request.method!=='GET')fail(403,'read_only');
        if(route==='/api/catalog'){json(200,await catalog());return;}
        if(!['/api/report','/api/outbound/daily'].includes(route))fail(404,'not_found');
        if(queryActive>=12)fail(429,'query_busy');
        queryActive++;
        try{
          let meta=await catalog(),query=parseReportQuery(url.searchParams,meta,{collectionStartedAt:config.collectionStartedAt});
          const loaded=await facts(query);
          const build=route==='/api/report'?buildReport:buildDailyReport;
          let result;
          try{result=build({query,facts:loaded,catalog:meta,collectionStartedAt:config.collectionStartedAt,mode:config.mode});}
          catch(error){
            if(error.code!=='CATALOG_OUTDATED')throw error;
            meta=await catalog(true);query=parseReportQuery(url.searchParams,meta,{collectionStartedAt:config.collectionStartedAt});
            result=build({query,facts:loaded,catalog:meta,collectionStartedAt:config.collectionStartedAt,mode:config.mode});
          }
          json(200,result);return;
        }finally{queryActive--;}
      }
      if(!['GET','HEAD'].includes(request.method))fail(405,'method_not_allowed');
      const file=publicFiles.get(route);if(!file)fail(404,'not_found');
      const bytes=await fs.readFile(path.join(root,'public',file));
      response.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':bytes.length});
      response.end(request.method==='HEAD'?undefined:bytes);
    }catch(error){
      const status=Number.isInteger(error.statusCode)?error.statusCode:503;
      if(error.retryAfterSeconds)response.setHeader('Retry-After',String(error.retryAfterSeconds));
      if(!response.headersSent)json(status,{error:status>=500?'服务暂时不可用，请稍后重试。':error.message,code:error.code||'request_failed'});
      else response.end();
      if(status>=500)console.error(JSON.stringify({event:'request_failed',code:error.code||'internal',status}));
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxRequestsPerSocket=100;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
  let closing=false;
  async function close(){if(closing)return;closing=true;auth.resetAll();await new Promise(resolve=>server.close(resolve));await Promise.all([reader.close(),receipts.close()]);}
  return {server,close,auth,reader,receipts,config};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startServer().then(app=>{
    console.log(`Hub analytics listening on ${app.config.publicOrigin} (${app.config.mode}; Umami-backed)`);
    const stop=()=>app.close().then(()=>process.exit(0)).catch(()=>process.exit(1));
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }).catch(error=>{console.error('Startup failed: '+error.message);process.exitCode=1;});
}
