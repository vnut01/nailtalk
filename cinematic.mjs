import { visemeAt, markShape, nextBlink, characterBlink, gestureAt } from './lipsync.mjs';
export function motionEnabled(saved, reduced) {
    return saved === 'on' ? true : saved === 'off' ? false : !reduced;
}
export function characterForCue(pack, cue) {
    return pack.cinematic?.speakers[cue?.speaker] || null;
}
// CSS owns idle motion; the lightweight frame loop samples audio source time and blink state.
export class CinematicScene {
    constructor(pack) {
        this.pack = pack;
        this.media = matchMedia('(prefers-reduced-motion: reduce)');
        try { this.saved = localStorage.getItem('nailtalk-motion'); } catch {}
        this.enabled = motionEnabled(this.saved, this.media.matches);
        this.speaker = null;
        try { this.lipSaved = localStorage.getItem('nailtalk-lipsync'); } catch {}
        this.lipEnabled = this.lipSaved !== 'off';
        this.restUsesOriginal = pack.cinematic?.restUsesOriginal ?? false;
        this.blinkStarts = {mark:nextBlink(performance.now()),linh:nextBlink(performance.now())};
        this.media.addEventListener('change', () => {
            this.enabled = motionEnabled(this.saved, this.media.matches);
            this.apply();
        });
        document.addEventListener('visibilitychange', () => this.apply());
    }
    mount(root) {
        cancelAnimationFrame(this.frame);
        this.root = root;
        this.ready = false;
        this.failed = false;
        if (!root || !this.pack.cinematic) return;
        const c = this.pack.cinematic;
        root.querySelector('.scene-layers').innerHTML = c.layers.map(l =>
            `<span class="scene-layer ${l.character ? 'character' : ''}" data-character="${l.character || ''}" style="left:${100*l.x/c.width}%;top:${100*l.y/c.height}%;width:${100*l.width/c.width}%;height:${100*l.height/c.height}%"><img class="character-base" alt="" src="packs/L-S07/${l.path}">${l.character ? '<span class="character-overlay"></span>' : ''}</span>`).join('');
        const images = [...root.querySelectorAll('.scene-layer img')];
        Promise.all(images.map(img => img.decode())).then(() => {
            if (this.root !== root) return;
            this.ready = true;
            this.apply();
        }).catch(() => { if (this.root === root) { this.failed = true; this.apply(); } });
        const g = c.gestures;
        const linhLayer = root.querySelector('[data-character="linh"]');
        if (g && linhLayer) {
            const rig = document.createElement('span'); rig.className = 'gesture-rig'; rig.hidden = true;
            rig.innerHTML = `<img class="gesture-body" alt="" src="packs/L-S07/${g.body}"><span class="head-rig"><img alt="" src="packs/L-S07/${g.head}"></span><img class="arm-rig" alt="" src="packs/L-S07/${g.arm}">`;
            linhLayer.append(rig);
            rig.querySelector('.head-rig').append(linhLayer.querySelector('.character-overlay'));
            const geometry = c.layers.find(l => l.character === 'linh');
            for (const [selector,pivot] of [['.head-rig',g.headPivot],['.arm-rig',g.armPivot]])
                rig.querySelector(selector).style.transformOrigin = `${100*pivot[0]/geometry.width}% ${100*pivot[1]/geometry.height}%`;
        }
        this.spriteReady = false;
        this.spriteFailed = false;
        for (const [id, sprite] of Object.entries(c.sprites || {})) {
            const layer = root.querySelector(`[data-character="${sprite.character}"]`);
            if (!layer) continue;
            const geometry = c.layers.find(l => l.character === sprite.character);
            const img = document.createElement('img');
            img.className = 'face-sprite'; img.alt = ''; img.dataset.sprite = id;
            img.onerror = () => { if (this.root === root) { this.spriteFailed = true; this.apply(); } };
            img.style.cssText = `left:${100*sprite.x/geometry.width}%;top:${100*sprite.y/geometry.height}%;width:${100*sprite.width/geometry.width}%;height:${100*sprite.height/geometry.height}%`;
            img.src = `packs/L-S07/${sprite.path}`;
            layer.querySelector('.character-overlay').append(img);
        }
        for (const img of root.querySelectorAll('.gesture-rig img'))
            img.onerror = () => { if (this.root === root) { this.spriteFailed = true; this.apply(); } };
        this.spriteImages = [...root.querySelectorAll('.face-sprite')];
        Promise.all([...this.spriteImages,...root.querySelectorAll('.gesture-rig img')].map(img => img.decode())).then(() => {
            if (this.root === root) { this.spriteReady = this.spriteImages.length > 0; this.apply(); }
        }).catch(() => { if (this.root === root) { this.spriteFailed = true; this.apply(); } });
        this.apply();
        const tick = now => {
            if (this.root !== root || !root.isConnected) return;
            this.renderFaces(now);
            this.frame = requestAnimationFrame(tick);
        };
        this.frame = requestAnimationFrame(tick);
    }
    setLipEnabled(enabled) {
        this.lipEnabled = enabled;
        try { localStorage.setItem('nailtalk-lipsync', enabled ? 'on' : 'off'); } catch {}
        this.apply();
    }
    renderFaces(now = performance.now()) {
        const lip = document.getElementById('lipsync-toggle');
        if (lip) {
            lip.disabled = !this.enabled || this.media.matches || this.spriteFailed;
            lip.setAttribute('aria-pressed', String(this.lipEnabled && !lip.disabled));
            const label = `Khẩu hình (thử nghiệm): ${this.lipEnabled && !lip.disabled ? 'Bật' : 'Tắt'}`;
            if (lip.textContent !== label) lip.textContent = label;
        }

        const facial = this.enabled && this.ready && !this.failed && this.spriteReady && !this.spriteFailed && !this.media.matches;
        const active = facial && this.lipEnabled;
        const playing = active && !document.hidden && !this.recording && this.player?.active;
        const cue = playing ? this.player.cues[this.player.index] : null;
        const speaker = characterForCue(this.pack, cue);
        const shape = playing ? visemeAt(this.pack.visemes?.[cue?.id], this.player.audio.currentTime) : 'X';
        const linh = speaker === 'linh' ? shape : 'X';
        const mark = speaker === 'mark' ? markShape(shape) : 'CLOSED';
        const blinks = {linh:null,mark:null};
        if (active && !document.hidden && !this.recording) {
            for (const char of ['mark','linh']) blinks[char] = characterBlink(now,this.blinkStarts,char,char === 'linh' && linh === 'A');
        } else for (const char of ['mark','linh']) this.blinkStarts[char] = nextBlink(now);
        const motion = gestureAt(speaker,cue,this.player?.audio.currentTime,playing,this.pack.cinematic?.gestures?.nodCues);
        const rig = this.root?.querySelector('.gesture-rig');
        if (rig) {
            rig.hidden = !active;
            this.root.querySelector('[data-character="linh"] > .character-base').style.visibility = active ? 'hidden' : '';
            rig.querySelector('.head-rig').style.transform = `rotate(${motion.head}deg)`;
            rig.querySelector('.arm-rig').style.transform = `rotate(${motion.arm}deg)`;
        }
        for (const img of this.spriteImages || []) {
            const id = img.dataset.sprite;
            const mouth = active && (id === (this.pack.cinematic?.mouthMap?.linh?.[linh] || `S07_LINH_MOUTH_${linh}_01`) && !(this.restUsesOriginal && linh === 'X') || id === `S07_MARK_MOUTH_${mark}_01`);
            const eye = (blinks.mark && id === `S07_MARK_EYE_${blinks.mark}_01`) || (blinks.linh && id === `S07_LINH_EYE_${blinks.linh}_01`);
            img.hidden = !(mouth || eye);
        }
        if (this.root) {
            this.root.dataset.lipsync = active ? 'on' : 'off';
            this.root.dataset.linhMouth = active && !(this.restUsesOriginal && linh === 'X') ? linh : 'original';
            this.root.dataset.markMouth = active ? mark : 'original';
            this.root.dataset.markBlink = blinks.mark || 'original';
            this.root.dataset.linhBlink = blinks.linh || 'original';
            this.root.dataset.headDegrees = String(motion.head);
            this.root.dataset.armDegrees = String(motion.arm);
            this.root.dataset.gestures = active ? 'on' : 'off';
        }
    }
    setEnabled(enabled) {
        this.saved = enabled ? 'on' : 'off';
        this.enabled = enabled;
        try { localStorage.setItem('nailtalk-motion', this.saved); } catch {}
        this.apply();
    }
    reset() {
        try { localStorage.removeItem('nailtalk-motion'); localStorage.removeItem('nailtalk-lipsync'); } catch {}
        this.saved = null;
        this.lipEnabled = true;
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
        this.renderFaces();
        const toggle = document.getElementById('motion-toggle');
        if (toggle) { toggle.setAttribute('aria-pressed', String(this.enabled)); toggle.textContent = `Chuyển động nhân vật: ${this.enabled ? 'Bật' : 'Tắt'}`; }
    }
}
