// Batch91 (NTE-DEC-085): main-thread side of the on-device speaking score.
const READY_KEY = 'nailtalk-scorer';
export const SCORER_MB = 66;
let worker = null, seq = 0, onProgress = null;
const waits = new Map();

function ensure() {
    if (worker) return worker;
    worker = new Worker(new URL('./scorer-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'progress') { onProgress?.(m); return; }
        const w = waits.get(m.id);
        if (!w) return;
        waits.delete(m.id);
        m.type === 'error' ? w.reject(Error(m.message)) : w.resolve(m);
    };
    worker.onerror = () => {
        for (const w of waits.values()) w.reject(Error('scorer worker failed'));
        waits.clear();
        worker = null;
    };
    return worker;
}
function call(msg, transfer = []) {
    const id = ++seq;
    const p = new Promise((resolve, reject) => waits.set(id, { resolve, reject }));
    ensure().postMessage({ ...msg, id }, transfer);
    return p;
}
// Browser tests replace the model with globalThis.__nailtalkScorerMock = { transcribe: async () => text }.
const mock = () => globalThis.__nailtalkScorerMock;
export function scorerReady() {
    if (mock()) return true;
    try { return localStorage.getItem(READY_KEY) === 'ready'; } catch { return false; }
}
export function forgetScorer() {
    try { localStorage.removeItem(READY_KEY); } catch {}
    worker?.terminate(); worker = null;
}
// Batch95 (owner: one loading process with a status): download every scorer file in one pass against a
// fixed total from SCORER_FILES.json, then start the model. progress({phase,loaded,total}) with phase
// 'download' then 'prepare'. Files go through the service worker, which keeps them in its scorer cache.
export async function loadScorer(progress) {
    if (mock()) return;
    const pin = await (await fetch(new URL('./models/SCORER_FILES.json', import.meta.url))).json();
    const entries = Object.entries(pin.sizes || {});
    const total = entries.reduce((a, [, n]) => a + n, 0);
    let loaded = 0;
    progress?.({ phase: 'download', loaded, total });
    for (const [rel, size] of entries) {
        const r = await fetch(new URL('./' + rel, import.meta.url));
        if (!r.ok) throw Error('scorer file unavailable: ' + rel);
        if (r.body?.getReader) {
            const reader = r.body.getReader();
            let got = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                got += value.length;
                progress?.({ phase: 'download', loaded: loaded + Math.min(got, size), total });
            }
        } else {
            await r.arrayBuffer();
        }
        loaded += size;
        progress?.({ phase: 'download', loaded, total });
    }
    progress?.({ phase: 'prepare', loaded: total, total });
    onProgress = null;
    await call({ cmd: 'load' });
    try { localStorage.setItem(READY_KEY, 'ready'); } catch {}
}
export async function transcribe(samples16k) {
    if (mock()) return mock().transcribe(samples16k);
    const copy = new Float32Array(samples16k);
    const m = await call({ cmd: 'run', audio: copy }, [copy.buffer]);
    return m.text;
}
