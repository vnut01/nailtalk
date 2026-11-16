// Local static assets only. No telemetry, uploads or external requests.
import {rangeResponse} from './range.mjs';
const CACHE='nailtalk-APP_PROTO-v029-DRAFT-1';
const SHELL=['./','index.html','style.css','app.mjs','logic.mjs','parts.mjs','path.mjs','lesson-content.json','player.mjs','capture.mjs','pronounce.mjs','scorer.mjs','scorer-worker.mjs','storage.mjs','media.mjs','cinematic.mjs','lipsync.mjs','range.mjs','catalog.json','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png'];
const PACKS=['L-S01','L-S08','L-S02','L-S05','L-S07','L-S06','L-S03','L-S04','L-S09','L-S14','L-S13','L-S10','L-S11','L-S12','L-S15','L-S16'];
const url=p=>new URL(p,self.registration.scope).href;
// Batch91: the on-device scoring model and runtime (about 65 MB) are cached on first use in their own cache,
// kept across app versions; only "Xóa dữ liệu" removes them.
const SCORER_CACHE='scorer-v1';
const scorerAsset=u=>/\/(models|vendor)\//.test(new URL(u).pathname);
const FORMAT=url('audio-format');
const marker=id=>url('offline-ready/'+id);
// S06's approved safety review uses the existing MP3 sources in either codec mode.
const safetyMP3=/V2_S06_(?:LINDA_0[12]|LINH_2[5-8]|SUSAN_03)\.mp3$/;
const needed=(file,format)=>!file.path.startsWith('audio/') || file.path.endsWith('.'+format) || safetyMP3.test(file.path);
async function sha(response){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function currentFormat(){return (await (await caches.open(CACHE)).match(FORMAT))?.text();}
async function status(){
  const cache=await caches.open(CACHE), format=await currentFormat(), ids=[];
  for(const id of PACKS)if((await cache.match(marker(id)))&&format)ids.push(id);
  return {ready:ids.length===PACKS.length,completed:ids.length,ids,format,downloading:running};
}
async function progress(error){
  const data={type:'OFFLINE_PROGRESS',...await status(),...(error?{error}: {})};
  for(const client of await self.clients.matchAll({includeUncontrolled:true}))client.postMessage(data);
}
async function verifyPack(id,format){
  const cache=await caches.open(CACHE), response=await cache.match(url(`packs/${id}/pack.json`));
  if(!response)return false;
  const pack=await response.json();
  for(const f of pack.files.filter(f=>needed(f,format))){const r=await cache.match(url(`packs/${id}/`+f.path));if(!r||await sha(r)!==f.sha256)return false;}
  return true;
}
let preferred=null, runningId=null, running=false, stopped=false;
// Mutations are serialized. START can reprioritize at the next asset boundary.
let queue=Promise.resolve();
function serialize(fn){const task=queue.catch(()=>{}).then(fn);queue=task;return task;}
async function selectFormat(format){
  if(!['ogg','mp3'].includes(format))throw Error('unsupported audio');
  if(await currentFormat()===format)return;
  const cache=await caches.open(CACHE);
  for(const r of await cache.keys())if(r.url.includes('/offline-ready/')||(/\/audio\//.test(r.url)&&!r.url.endsWith('.'+format)))await cache.delete(r);
  await cache.put(FORMAT,new Response(format));
}
async function installPack(id,format){
  const cache=await caches.open(CACHE);
  if(await verifyPack(id,format)){await cache.put(marker(id),new Response(format));return true;}
  await cache.delete(marker(id));
  const response=await fetch(url(`packs/${id}/pack.json`));
  if(!response.ok)throw Error('pack unavailable');
  const pack=await response.clone().json();
  if(pack.schema_version!==1||pack.min_shell_version>1)throw Error('incompatible pack');
  const files=pack.files.filter(f=>needed(f,format));
  // Only one pack at a time, with six bounded asset requests inside that pack.
  let cursor=0;
  const results=await Promise.allSettled(Array.from({length:6},async()=>{
    while(cursor<files.length){
      if(stopped||preferred&&preferred!==id)return;
      const f=files[cursor++], path=url(`packs/${id}/`+f.path), cached=await cache.match(path);
      if(cached&&await sha(cached.clone())===f.sha256)continue;
      const r=await fetch(path);
      if(!r.ok||await sha(r.clone())!==f.sha256)throw Error('incomplete pack');
      await cache.put(path,r);
    }
  }));
  const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  if(stopped||preferred&&preferred!==id)return false;
  await cache.put(url(`packs/${id}/pack.json`),response);
  // Marker is the commit: partial/interrupted packs can never be offline-ready.
  if(!await verifyPack(id,format))throw Error('pack verification failed');
  await cache.put(marker(id),new Response(format));
  return true;
}
async function downloadAll(){
  if(running)return;
  running=true;stopped=false;
  try{
    const format=await currentFormat();if(!format)throw Error('unsupported audio');await progress();
    const remaining=new Set(PACKS);
    while(remaining.size&&!stopped){
      const id=preferred||remaining.values().next().value;
      runningId=id;
      const complete=await installPack(id,format);
      if(complete){remaining.delete(id);if(preferred===id)preferred=null;await progress();}
    }
  }catch(error){await progress(error.message);}
  finally{running=false;runningId=null;}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(SHELL.map(url));await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('nailtalk-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    if(scorerAsset(event.request.url)){
      const sc=await caches.open(SCORER_CACHE), hit=await sc.match(event.request,{ignoreSearch:true});
      if(hit)return hit;
      try{const r=await fetch(event.request);if(r.ok&&r.status===200)await sc.put(event.request,r.clone());return r;}catch{}
      return new Response('Scorer asset unavailable',{status:503});
    }
    const cache=await caches.open(CACHE), cached=await cache.match(event.request,{ignoreSearch:true});
    if(cached){
      if(event.request.headers.has('Range')&&/\/audio\//.test(event.request.url))return rangeResponse(cached,event.request.headers.get('Range'));
      return cached;
    }
    try{const r=await fetch(event.request);if(r.ok)return r;}catch{}
    return event.request.mode==='navigate'?await cache.match(url('index.html')):new Response('Local asset unavailable',{status:503});
  })());
});
self.addEventListener('message',event=>{
  const {type,format,id}=event.data;
  if(['START','INSTALL_PACK'].includes(type)&&PACKS.includes(id))preferred=id;
  if(['CLEAR','REMOVE_PACK','SELECT_FORMAT'].includes(type)&&type!=='SELECT_FORMAT')stopped=true;
  const reply=data=>event.ports[0]?.postMessage(data);
  if(type==='PAUSE'){stopped=true;reply({ok:true});return;}
  if(type==='START'||type==='INSTALL_PACK'){
    if(!PACKS.includes(id)){reply({error:'unknown pack'});return;}
    reply({ok:true});
    event.waitUntil(serialize(async()=>{await selectFormat(format||await currentFormat());await downloadAll();}));return;
  }
  if(type==='STATUS'){event.waitUntil(status().then(reply));return;}
  // A matching codec must not interrupt an ongoing download when a page reloads.
  if(type==='SELECT_FORMAT'){
    event.waitUntil((async()=>{
      if(await currentFormat()!==format){stopped=true;await serialize(()=>selectFormat(format));}
      reply({ok:true});
    })().catch(error=>reply({error:error.message})));return;
  }
  event.waitUntil(serialize(async()=>{
    const cache=await caches.open(CACHE);
    switch(type){
      case 'CLEAR':for(const key of await caches.keys())if(key.startsWith('nailtalk-')||key===SCORER_CACHE)await caches.delete(key);await self.registration.unregister();break;
      case 'REMOVE_PACK':for(const r of await cache.keys())if(r.url.includes('/packs/')||r.url.includes('/offline-ready/'))await cache.delete(r);break;
      case 'CHECK':{
        let ready=!!await currentFormat();
        for(const p of SHELL)if(!await cache.match(url(p)))ready=false;
        for(const id of PACKS)if(!await verifyPack(id,await currentFormat())){ready=false;await cache.delete(marker(id));}
        reply({...await status(),ready});return;
      }
    }
    reply({ok:true});
  }).catch(error=>reply({error:error.message})));
});
