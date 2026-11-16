// Batch91 (NTE-DEC-085): on-device speech recognition for the speaking score.
// Runs Whisper tiny.en through Transformers.js inside this worker. Model and runtime are served from this
// app's own folder; nothing is fetched from other hosts and no audio leaves the device.
import { pipeline, env } from './vendor/transformers/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;
env.useBrowserCache = false; // the service worker caches these files
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1; // no cross-origin isolation on the preview host

let recognizer = null;
function load() {
    recognizer ||= pipeline('automatic-speech-recognition', 'whisper-tiny.en', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: p => { if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); }
    });
    return recognizer;
}

onmessage = async e => {
    const { id, cmd, audio } = e.data;
    try {
        const asr = await load();
        if (cmd === 'load') { postMessage({ id, type: 'ready' }); return; }
        const out = await asr(audio);
        postMessage({ id, type: 'result', text: String(out?.text || '').trim() });
    } catch (err) {
        recognizer = null;
        postMessage({ id, type: 'error', message: String(err?.message || err) });
    }
};
