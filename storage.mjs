const KEY='nailtalk-prototype-v1';
let db;
export let storageMode='IndexedDB';
function open() { return new Promise((resolve,reject)=>{const r=indexedDB.open(KEY,1);r.onupgradeneeded=()=>r.result.createObjectStore('progress');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}); }
async function transaction(mode, action) { db ||= await open(); return new Promise((resolve,reject)=>{const tx=db.transaction('progress',mode);const r=action(tx.objectStore('progress'));tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
export async function load(lesson="L-S07") { try { return await transaction('readonly',s=>s.get(lesson)); } catch { storageMode='localStorage';try{return JSON.parse(localStorage.getItem(lesson === "L-S07" ? KEY : KEY+lesson));}catch{storageMode='Không lưu được';return null;} } }
export async function save(value,lesson="L-S07") { try {await transaction('readwrite',s=>s.put(value,lesson));} catch {storageMode='localStorage';try{localStorage.setItem(lesson === "L-S07" ? KEY : KEY+lesson,JSON.stringify(value));}catch{storageMode='Không lưu được';}} }
export async function clear() {try {await transaction('readwrite',s=>s.clear());}catch{}try{localStorage.removeItem(KEY);for(let n=1;n<=8;n++)localStorage.removeItem(KEY+"L-S"+String(n).padStart(2,"0"));}catch{} }
