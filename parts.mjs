// Source-time lookup uses the same cue durations and gaps as AudioPlayer.
export function subtitleCue(cues, milliseconds) {
    let start=0;
    for(const cue of cues) {
        if(milliseconds>=start && milliseconds<start+cue.duration_ms)return cue;
        start+=cue.duration_ms+(cue.gap_after_ms||0);
    }
    return null;
}
