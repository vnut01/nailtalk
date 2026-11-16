// Batch90: microphone capture without MediaRecorder.
// On iPhone the owner could record only once per session with MediaRecorder (Batch88/89 fixes did not help),
// so takes are captured as raw samples through Web Audio, resampled to 16 kHz (WAV for playback, floats for scoring).
// Each take opens a fresh microphone stream and AudioContext and closes both when it stops.

export function createAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    // Called inside the tap handler, before any await, so iOS lets the context run.
    ctx.resume?.().catch(() => {});
    return ctx;
}

export async function openCapture(ctx) {
    if (!ctx || !navigator.mediaDevices?.getUserMedia) throw Error("unavailable");
    const session = navigator.audioSession;
    const prevType = session?.type;
    try { if (session) session.type = "play-and-record"; } catch {}
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
        restoreSession(session, prevType);
        ctx.close?.().catch(() => {});
        throw e;
    }
    try { await ctx.resume?.(); } catch {}
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    const track = stream.getAudioTracks()[0];
    const cap = { state: "recording", level: 0, peak: 0, frames: 0, sampleRate: ctx.sampleRate, onstop: null, blob: null, diag: null };
    proc.onaudioprocess = e => {
        if (cap.state !== "recording") return;
        const d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        let m = 0;
        for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
        cap.level = m;
        if (m > cap.peak) cap.peak = m;
        cap.frames += d.length;
    };
    source.connect(proc);
    proc.connect(ctx.destination);
    cap.stop = () => {
        if (cap.state !== "recording") return;
        cap.state = "inactive";
        try { source.disconnect(); proc.disconnect(); } catch {}
        cap.diag = {
            seconds: Math.round(cap.frames / cap.sampleRate * 10) / 10,
            peak: Math.round(cap.peak * 1000) / 1000,
            sampleRate: cap.sampleRate,
            trackMuted: !!track?.muted,
            trackState: track?.readyState || "none",
            contextState: ctx.state,
            session: session ? String(session.type) : "none"
        };
        stream.getTracks().forEach(t => t.stop());
        ctx.close?.().catch(() => {});
        restoreSession(session, prevType);
        cap.samples = cap.frames ? resample(chunks, cap.sampleRate, 16000) : new Float32Array(0);
        cap.blob = cap.frames ? wavFromSamples(cap.samples, 16000) : new Blob([], { type: "audio/wav" });
        cap.onstop?.();
    };
    return cap;
}

function restoreSession(session, prevType) {
    try { if (session) session.type = prevType && prevType !== "play-and-record" ? prevType : "auto"; } catch {}
}

// Linear-interpolation resampling to an exact target rate (Whisper needs 16 kHz).
// Going down, each output sample first averages the input span it covers.
export function resample(chunks, rate, target) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const input = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { input.set(c, o); o += c.length; }
    if (rate === target) return input;
    const len = Math.floor(n * target / rate);
    const out = new Float32Array(len);
    const step = rate / target;
    for (let i = 0; i < len; i++) {
        const start = i * step, end = Math.min(n, start + step);
        if (step > 1) {
            let sum = 0, count = 0;
            for (let j = Math.floor(start); j < Math.ceil(end); j++) { sum += input[j]; count++; }
            out[i] = count ? sum / count : 0;
        } else {
            const j = Math.floor(start), f = start - j;
            out[i] = input[j] * (1 - f) + (input[Math.min(n - 1, j + 1)] || 0) * f;
        }
    }
    return out;
}

export function wavFromSamples(samples, rate) {
    const len = samples.length;
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
}

export function encodeWav(chunks, rate, target) {
    return wavFromSamples(resample(chunks, rate, target), target);
}
