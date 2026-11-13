// Audio time is source time at every playback rate and for both source codecs.
export function visemeAt(track, time) {
    if (!track || !Number.isFinite(time) || time < 0 || time >= track.duration) return 'X';
    return track.mouthCues.find(c => time >= c.start && time < c.end)?.value || 'X';
}
export function markShape(shape) {
    return ({A:'CLOSED',X:'CLOSED',B:'SLIGHT',C:'SLIGHT',E:'SLIGHT',D:'OPEN',F:'ROUND',G:'SLIGHT',H:'SLIGHT'})[shape] || 'CLOSED';
}
export function nextBlink(now, random = Math.random) { return now + 3000 + random() * 3000; }
export function blinkAt(now, start) {
    const elapsed = now - start;
    return elapsed < 0 || elapsed >= 150 ? null : elapsed < 45 || elapsed >= 105 ? 'HALF' : 'CLOSED';
}
// Gesture envelopes use source time, so rate changes cannot accumulate drift.
export function gestureAt(character, cue, time, enabled, nodCues = []) {
    if (!enabled || character !== 'linh' || !cue || !Number.isFinite(time) || time < 0 || time >= cue.duration_ms / 1000)
        return {head:0,arm:0};
    const duration = cue.duration_ms / 1000;
    const pulse = (start, length) => {
        const t = (time-start)/length;
        return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI*t)**2;
    };
    return {head:nodCues.includes(cue.id) ? 2.5*pulse(.12,Math.min(1.1,duration-.12)) : 0,
        arm:2*pulse(.15,Math.min(1.45,duration-.15))};
}
export function characterBlink(now, starts, character, plosive = false, random = Math.random) {
    if (now >= starts[character]+150) starts[character] = nextBlink(now,random);
    // Defer onset (and cancel a closing phase) on Linh's M/B/P viseme.
    if (character === 'linh' && plosive && now >= starts.linh) starts.linh = now+100;
    const phase = blinkAt(now,starts[character]);
    return character === 'linh' ? (phase ? 'CLOSED' : null) : phase;
}
