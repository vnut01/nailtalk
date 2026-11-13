// Local static assets only. No telemetry, uploads or external requests.
const CACHE='nailtalk-APP_PROTO-v002-DRAFT-1';
const SHELL=['./','index.html','style.css','app.mjs','logic.mjs','storage.mjs','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png'];
const PACK='packs/L-S07/pack.json';
const url=p=>new URL(p,self.registration.scope).href;
async function sha(response){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function installPack(){
  const response=await fetch(url(PACK),{cache:'no-store'});if(!response.ok)throw Error('pack unavailable');
  const pack=await response.clone().json();if(pack.schema_version!==1||pack.min_shell_version>1)throw Error('incompatible pack');
  const stage=await caches.open(CACHE+'-stage');
  try{await stage.put(url(PACK),response);for(const f of pack.files){const r=await fetch(url('packs/L-S07/'+f.path),{cache:'no-store'});if(!r.ok||await sha(r.clone())!==f.sha256)throw Error('incomplete pack');await stage.put(url('packs/L-S07/'+f.path),r);}const active=await caches.open(CACHE);for(const request of await stage.keys())await active.put(request,await stage.match(request));}finally{await caches.delete(CACHE+'-stage');}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(SHELL.map(url));await installPack();await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('nailtalk-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;event.respondWith((async()=>{const cache=await caches.open(CACHE);return await cache.match(event.request,{ignoreSearch:true})||(event.request.mode==='navigate'?await cache.match(url('index.html')):new Response('Local asset unavailable',{status:503}));})());});
self.addEventListener('message',event=>event.waitUntil((async()=>{try{const cache=await caches.open(CACHE);switch(event.data.type){case 'CLEAR':for(const key of await caches.keys())if(key.startsWith('nailtalk-'))await caches.delete(key);await self.registration.unregister();break;case 'REMOVE_PACK':for(const r of await cache.keys())if(r.url.includes('/packs/')&&!r.url.endsWith('/pack.json'))await cache.delete(r);break;case 'INSTALL_PACK':await cache.addAll(SHELL.map(url));await installPack();break;case 'CHECK':{let ready=true;for(const p of SHELL)if(!await cache.match(url(p)))ready=false;const r=await cache.match(url(PACK));if(!r)ready=false;else{const pack=await r.json();for(const f of pack.files){const asset=await cache.match(url('packs/L-S07/'+f.path));if(!asset||await sha(asset)!==f.sha256)ready=false;}}event.ports[0]?.postMessage({ready});return;}}event.ports[0]?.postMessage({ok:true});}catch(error){event.ports[0]?.postMessage({error:error.message});}})()));
