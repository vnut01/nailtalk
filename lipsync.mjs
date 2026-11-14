// Audio time is source time at every playback rate and for both source codecs.
export const MIN_SHAPE_HOLD = .100;
const smoothed = new WeakMap();
// Pure, source-time coalescing. Long silence (including the S05 dropout) is
// never borrowed. A short plosive takes time from an adjacent non-silence cue
// when that donor can still meet the hold; otherwise nearest-group wins.
export function smoothTrack(track, hold = MIN_SHAPE_HOLD) {
    const cues = (track?.mouthCues || []).map(c => ({...c}));
    const compact = () => {
        for (let i = cues.length-1; i > 0; i--) {
            if (cues[i].value === cues[i-1].value && Math.abs(cues[i].start-cues[i-1].end)<1e-7) {
                cues[i-1].end = cues[i].end; cues.splice(i,1);
            }
        }
    };
    compact();
    for (let i = 1; i < cues.length-1;) {
        const c = cues[i], missing = hold-(c.end-c.start);
        if (missing <= 1e-7) { i++; continue; }
        const neighbours = [i-1,i+1];
        if (c.value === 'A') {
            const donor = neighbours.find(n => cues[n].value !== 'X' && cues[n].end-cues[n].start >= hold+missing-1e-7);
            if (donor !== undefined) {
                if (donor < i) { c.start -= missing; cues[donor].end = c.start; }
                else { c.end += missing; cues[donor].start = c.end; }
                i++; continue;
            }
        }
        const group = markShape(c.value);
        const distance = n => {
            const g = markShape(cues[n].value);
            return g === group ? 0 : (g === 'SLIGHT' || group === 'SLIGHT' ? 1 : 2);
        };
        neighbours.sort((a,b) => distance(a)-distance(b) ||
            (cues[b].end-cues[b].start)-(cues[a].end-cues[a].start));
        const n = neighbours[0];
        if (n < i) cues[n].end = c.end; else cues[n].start = c.start;
        cues.splice(i,1); compact(); i = Math.max(1,i-1);
    }
    return {...track, mouthCues:cues};
}
export function visemeAt(track, time) {
    if (!track || !Number.isFinite(time) || time < 0 || time >= track.duration) return 'X';
    if (!smoothed.has(track)) smoothed.set(track, smoothTrack(track));
    return smoothed.get(track).mouthCues.find(c => time >= c.start && time < c.end)?.value || 'X';
}
export function markShape(shape) {
    return ({A:'CLOSED',X:'CLOSED',B:'SLIGHT',C:'SLIGHT',E:'SLIGHT',D:'OPEN',F:'ROUND',G:'SLIGHT',H:'SLIGHT'})[shape] || 'CLOSED';
}
export function nextBlink(now, random = Math.random, character = 'linh') {
    return now + (character === 'mark' ? 3000 + random()*3000 : 2500 + random()*3500);
}
export function blinkAt(now, start, mode = 'phased') {
    const elapsed = now - start;
    if (mode === 'none' || elapsed < 0 || elapsed >= (mode === 'closed' ? 100 : 180)) return null;
    return mode === 'closed' ? 'CLOSED' : elapsed < 50 || elapsed >= 120 ? 'HALF' : 'CLOSED';
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
export function characterBlink(now, starts, character, plosive = false, random = Math.random, mode = 'closed') {
    // Mark retains his historical 150 ms phases; Linh uses reviewed per-lesson modes.
    if (character === 'mark') {
        if (now >= starts.mark+150) starts.mark = nextBlink(now,random,'mark');
        const t = now-starts.mark;
        return t < 0 || t >= 150 ? null : t < 45 || t >= 105 ? 'HALF' : 'CLOSED';
    }
    const duration = mode === 'closed' ? 100 : 180;
    const doubleKey = character+'Double';
    if (now >= starts[character]+duration) {
        const double = !starts[doubleKey] && random() < .15;
        starts[character] = double ? starts[character]+duration+120 : nextBlink(now,random);
        starts[doubleKey] = double;
    }
    if (character === 'linh' && plosive && now >= starts.linh) starts.linh = now+100;
    return blinkAt(now,starts[character],mode);
}
