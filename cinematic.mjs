export function motionEnabled(saved, reduced) {
    return saved === 'on' ? true : saved === 'off' ? false : !reduced;
}
export function characterForCue(pack, cue) {
    return pack.cinematic?.speakers[cue?.speaker] || null;
}
// CSS owns the compositor animation; no JS frame loop or frame allocations.
export class CinematicScene {
    constructor(pack) {
        this.pack = pack;
        this.media = matchMedia('(prefers-reduced-motion: reduce)');
        try { this.saved = localStorage.getItem('nailtalk-motion'); } catch {}
        this.enabled = motionEnabled(this.saved, this.media.matches);
        this.speaker = null;
        this.media.addEventListener('change', () => {
            this.enabled = motionEnabled(this.saved, this.media.matches);
            this.apply();
        });
        document.addEventListener('visibilitychange', () => this.apply());
    }
    mount(root) {
        this.root = root;
        this.ready = false;
        this.failed = false;
        if (!root || !this.pack.cinematic) return;
        const c = this.pack.cinematic;
        root.querySelector('.scene-layers').innerHTML = c.layers.map(l =>
            `<span class="scene-layer ${l.character ? 'character' : ''}" data-character="${l.character || ''}" style="left:${100*l.x/c.width}%;top:${100*l.y/c.height}%;width:${100*l.width/c.width}%;height:${100*l.height/c.height}%"><img alt="" src="packs/L-S07/${l.path}">${l.character ? '<span class="character-overlay"></span>' : ''}</span>`).join('');
        const images = [...root.querySelectorAll('.scene-layer img')];
        Promise.all(images.map(img => img.decode())).then(() => {
            if (this.root !== root) return;
            this.ready = true;
            this.apply();
        }).catch(() => { if (this.root === root) { this.failed = true; this.apply(); } });
        this.apply();
    }
    setEnabled(enabled) {
        this.saved = enabled ? 'on' : 'off';
        this.enabled = enabled;
        try { localStorage.setItem('nailtalk-motion', this.saved); } catch {}
        this.apply();
    }
    reset() {
        try { localStorage.removeItem('nailtalk-motion'); } catch {}
        this.saved = null;
        this.enabled = motionEnabled(null, this.media.matches);
        this.apply();
    }
    update(player) {
        if (!player.active && this.player?.active && this.player !== player) return;
        this.player = player;
        this.speaker = player.active ? characterForCue(this.pack, player.cues[player.index]) : null;
        this.apply();
    }
    apply() {
        const active = this.enabled && this.ready && !this.failed;
        this.root?.classList.toggle('layered', active);
        if (this.root) {
            this.root.dataset.speaker = this.speaker || '';
            this.root.classList.toggle('scene-paused', document.hidden || this.recording);
            const tag = this.root.querySelector('.speaker-tag');
            tag.textContent = this.speaker ? `${this.speaker === 'linh' ? 'Linh' : 'Mark'} đang nói` : 'Linh và Mark';
        }
        const toggle = document.getElementById('motion-toggle');
        if (toggle) { toggle.setAttribute('aria-pressed', String(this.enabled)); toggle.textContent = `Chuyển động nhân vật: ${this.enabled ? 'Bật' : 'Tắt'}`; }
    }
}
