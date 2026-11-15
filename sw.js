// Local static assets only. No telemetry, uploads or external requests.
import {rangeResponse} from './range.mjs';
const CACHE='nailtalk-APP_PROTO-v014-DRAFT-1';
const SHELL=['./','index.html','style.css','app.mjs','logic.mjs','player.mjs','storage.mjs','media.mjs','cinematic.mjs','lipsync.mjs','range.mjs','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png'];
const PACKS=['L-S01','L-S02','L-S03','L-S04','L-S05','L-S06','L-S07','L-S08'];
const url=p=>new URL(p,self.registration.scope).href;
const FORMAT=url('audio-format');
async function sha(response){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
const needed=(file,format)=>!file.path.startsWith('audio/') || file.path.endsWith('.'+format);
async function currentFormat(){return (await (await caches.open(CACHE)).match(FORMAT))?.text();}
async function installPack(format){
  const stage=await caches.open(CACHE+'-stage');
  try {
  for(const id of PACKS){
  const PACK=`packs/${id}/pack.json`;
  const response=await fetch(url(PACK),{cache:'no-store'});if(!response.ok)throw Error('pack unavailable');
  const pack=await response.clone().json();if(pack.schema_version!==1||pack.min_shell_version>1)throw Error('incompatible pack');
    await stage.put(url(PACK),response);
    for(const f of pack.files.filter(f=>needed(f,format))){
      const r=await fetch(url(`packs/${id}/`+f.path),{cache:'no-store'});
      if(!r.ok||await sha(r.clone())!==f.sha256)throw Error('incomplete pack');
      await stage.put(url(`packs/${id}/`+f.path),r);
    }
  }
    const active=await caches.open(CACHE);
    for(const request of await stage.keys())await active.put(request,await stage.match(request));
    // Commit selection only after all assets validate. Remove the previous codec.
    if(format){
      for(const request of await active.keys())if(/\/audio\//.test(request.url)&&!request.url.endsWith('.'+format))await active.delete(request);
      await active.put(FORMAT,new Response(format));
    }
  } finally {await caches.delete(CACHE+'-stage');}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(SHELL.map(url));await installPack(null);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('nailtalk-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE), cached=await cache.match(event.request,{ignoreSearch:true});
    if(cached){
      if(event.request.headers.has('Range')&&/\/audio\//.test(event.request.url))return rangeResponse(cached,event.request.headers.get('Range'));
      return cached;
    }
    // First codec installation may still be staging when a learner taps play.
    // Serve same-origin media online during that window; offline misses still fail.
    try { const response=await fetch(event.request); if(response.ok)return response; } catch {}
    return event.request.mode==='navigate'?await cache.match(url('index.html')):new Response('Local asset unavailable',{status:503});
  })());
});
// Serialize mutations so multiple open clients cannot mix staged packs/codecs.
let queue=Promise.resolve();
self.addEventListener('message',event=>{
  queue=queue.catch(()=>{}).then(async()=>{
    try {
      const cache=await caches.open(CACHE);
      switch(event.data.type){
        case 'CLEAR':for(const key of await caches.keys())if(key.startsWith('nailtalk-'))await caches.delete(key);await self.registration.unregister();break;
        case 'REMOVE_PACK':for(const r of await cache.keys())if(r.url.includes('/packs/')&&!r.url.endsWith('/pack.json'))await cache.delete(r);break;
        case 'SELECT_FORMAT':
          if(!['ogg','mp3'].includes(event.data.format))throw Error('unsupported audio');
          if(await currentFormat()!==event.data.format)await installPack(event.data.format);
          break;
        case 'INSTALL_PACK':await cache.addAll(SHELL.map(url));await installPack(event.data.format||await currentFormat());break;
        case 'CHECK':{
          const format=await currentFormat();let ready=!!format;
          for(const p of SHELL)if(!await cache.match(url(p)))ready=false;
          for(const id of PACKS){
          const r=await cache.match(url(`packs/${id}/pack.json`));
          if(!r)ready=false;
          else{const pack=await r.json();for(const f of pack.files.filter(f=>needed(f,format))){const asset=await cache.match(url(`packs/${id}/`+f.path));if(!asset||await sha(asset)!==f.sha256)ready=false;}}
          }
          event.ports[0]?.postMessage({ready,format});return;
        }
      }
      event.ports[0]?.postMessage({ok:true});
    }catch(error){event.ports[0]?.postMessage({error:error.message});}
  });
  event.waitUntil(queue);
});
