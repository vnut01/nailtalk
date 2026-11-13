// Shared capability decision; the worker caches exactly this format.
export function audioFormat(canPlayType) {
    if (canPlayType('audio/ogg; codecs="opus"')) return 'ogg';
    return canPlayType('audio/mpeg') ? 'mp3' : null;
}
export function audioPath(cue, format) {
    return format === 'mp3' ? cue.audio_fallback : format === 'ogg' ? cue.audio : null;
}
