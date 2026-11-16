// Batch91 (NTE-DEC-085): main-thread side of the on-device speaking score.
const READY_KEY = 'nailtalk-scorer';
export const SCORER_MB = 65;
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
// Downloads (first time) and starts the model. progress({loaded,total}) reports bytes across files.
export async function loadScorer(progress) {
    if (mock()) return;
    const files = new Map();
    onProgress = m => {
        files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        progress?.({ loaded, total });
    };
    await call({ cmd: 'load' });
    try { localStorage.setItem(READY_KEY, 'ready'); } catch {}
}
export async function transcribe(samples16k) {
    if (mock()) return mock().transcribe(samples16k);
    const copy = new Float32Array(samples16k);
    const m = await call({ cmd: 'run', audio: copy }, [copy.buffer]);
    return m.text;
}
