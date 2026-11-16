import { linhVisemeAt, visemeAt, markShape, nextBlink, characterBlink, gestureAt } from './lipsync.mjs';
export function motionEnabled(saved, reduced) {
    return saved === 'on' ? true : saved === 'off' ? false : !reduced;
}
export function characterForCue(pack, cue) {
    return pack.cinematic?.speakers[cue?.speaker] || null;
}
// Inserts follow the shown dialogue cue, including a paused cue and its gap.
export function insertForCue(pack, cueId) {
    return pack.inserts?.find(insert => insert.cues.includes(cueId)) || null;
}
// Legacy packs keep their exact sprite bindings and timing. New packs provide
// the same contract explicitly under characters, keyed by stable character ID.
export function charactersFor(pack) {
    const c = pack.cinematic || {};
    if (c.characters) return c.characters;
    const mouthMap = c.mouthMap || {};
    return Object.fromEntries(['mark','linh'].map(id => [id, {
        label: id === 'linh' ? 'Linh' : 'Mark',
        mouthMap: {...Object.fromEntries('XABCDEFGH'.split('').map(shape =>
            [shape, `S07_${id.toUpperCase()}_MOUTH_${id === 'mark' ? markShape(shape) : shape}_01`])), ...mouthMap[id]},
        eyeMap: c.eyeMap ? (c.eyeMap[id] || {}) : Object.fromEntries(['HALF','CLOSED'].map(phase => [phase, `S07_${id.toUpperCase()}_EYE_${phase}_01`])),
        restUsesOriginal: id === 'linh' && (c.restUsesOriginal ?? false),
        blinkMode: c.blinkMode || 'closed',
        blinkTiming: id,
        deferBlinkOnPlosive: id === 'linh'
    }]));
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
        this.characters = charactersFor(pack);
        // Retain the legacy rest-preview control used by existing review tools.
        if (!pack.cinematic?.characters && this.characters.linh)
            Object.defineProperty(this.characters.linh, 'restUsesOriginal', {get: () => this.restUsesOriginal});
        this.blinkStarts = Object.fromEntries(Object.entries(this.characters).map(([id, config]) => [id, nextBlink(performance.now(), Math.random, config.blinkTiming || id)]));
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
        this.player = null;
        this.insertImages = [];
        if (!root) return;
        for (const insert of this.pack.inserts || []) {
            const img = document.createElement('img');
            img.className = 'scene-insert'; img.alt = insert.alt;
            img.src = `packs/${this.pack.id}/${insert.image}`;
            img.setAttribute('aria-hidden', 'true');
            const entry = {insert, img, ready: false};
            this.insertImages.push(entry);
            root.querySelector('.scene-frame').append(img);
            img.decode().then(() => { if (this.root === root) { entry.ready = true; this.apply(); } }).catch(() => {});
        }
        if (!this.pack.cinematic) return;
        const c = this.pack.cinematic;
        root.querySelector('.scene-layers').innerHTML = c.layers.map(l =>
            `<span class="scene-layer ${l.character ? 'character' : ''}" data-character="${l.character || ''}" style="left:${100*l.x/c.width}%;top:${100*l.y/c.height}%;width:${100*l.width/c.width}%;height:${100*l.height/c.height}%"><img class="character-base" alt="" src="packs/${this.pack.id}/${l.path}">${l.character ? '<span class="character-overlay"></span>' : ''}</span>`).join('');
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
            rig.innerHTML = `<img class="gesture-body" alt="" src="packs/${this.pack.id}/${g.body}"><span class="head-rig"><img alt="" src="packs/${this.pack.id}/${g.head}"></span><img class="arm-rig" alt="" src="packs/${this.pack.id}/${g.arm}">`;
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
            img.src = `packs/${this.pack.id}/${sprite.path}`;
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
        // Entry follows the authored scene turn, independent of playback rate.
        // Keep the last scene turn through pauses/gaps; a new full listen resets it.
        const sceneIndex = this.pack.dialogue?.indexOf(this.player?.cues?.[this.player.index]?.id);
        if (sceneIndex >= 0) this.sceneTurn = sceneIndex + 1;
        for (const layer of this.pack.cinematic?.layers || []) {
            if (!layer.entryTurn) continue;
            const el = this.root?.querySelector(`[data-character="${layer.character}"]`);
            if (!el) continue;
            const visible = (this.sceneTurn || 0) >= layer.entryTurn ||
                characterForCue(this.pack, this.player?.cues?.[this.player.index]) === layer.character;
            el.style.transition = this.media.matches ? 'none' : `opacity ${layer.fadeMs || 450}ms ease`;
            el.style.opacity = visible ? '1' : '0';
            el.style.visibility = visible ? '' : 'hidden';
        }
        const lip = document.getElementById('lipsync-toggle');
        if (lip) {
            lip.disabled = !this.enabled || this.media.matches || this.spriteFailed;
            lip.setAttribute('aria-pressed', String(this.lipEnabled && !lip.disabled));
            const label = `Khẩu hình (thử nghiệm): ${this.lipEnabled && !lip.disabled ? 'Bật' : 'Tắt'}`;
            if (lip.textContent !== label) lip.textContent = label;
        }

        const currentCue = this.player?.cues?.[this.player.index]?.id;
        const insert = insertForCue(this.pack, currentCue);
        this.insertVisible = false;
        for (const entry of this.insertImages || []) {
            const shown = entry.ready && entry.insert === insert && !this.recording;
            entry.img.classList.toggle('is-visible', shown);
            entry.img.setAttribute('aria-hidden', String(!shown));
            this.insertVisible ||= shown;
        }
        if (this.root) this.root.dataset.insert = this.insertVisible ? currentCue : '';
        const facial = this.enabled && this.ready && !this.failed && this.spriteReady && !this.spriteFailed && !this.media.matches;
        const active = facial && this.lipEnabled && !this.insertVisible;
        const playing = active && !document.hidden && !this.recording && this.player?.active && !this.player.inGap;
        const cue = playing ? this.player.cues[this.player.index] : null;
        const speaker = characterForCue(this.pack, cue);
        const shape = playing ? visemeAt(this.pack.visemes?.[cue?.id], this.player.audio.currentTime) : 'X';
        const mouths = {}, blinks = {};
        for (const [id, config] of Object.entries(this.characters)) {
            mouths[id] = speaker === id ? (id === 'linh' ? linhVisemeAt(this.pack.visemes?.[cue?.id], this.player.audio.currentTime) : shape) : 'X';
            blinks[id] = null;
        }
        if (active && !document.hidden && !this.recording) {
            for (const [id, config] of Object.entries(this.characters)) if (Object.keys(config.eyeMap || {}).length)
                blinks[id] = characterBlink(now, this.blinkStarts, id, config.deferBlinkOnPlosive && mouths[id] === 'A', Math.random, config.blinkMode || 'closed');
        } else for (const [id, config] of Object.entries(this.characters)) this.blinkStarts[id] = nextBlink(now, Math.random, config.blinkTiming || id);
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
            const sprite = this.pack.cinematic.sprites[id];
            const config = this.characters[sprite.character];
            const mouth = active && config && id === config.mouthMap?.[mouths[sprite.character]] && !(config.restUsesOriginal && mouths[sprite.character] === 'X');
            const eye = config && blinks[sprite.character] && id === config.eyeMap?.[blinks[sprite.character]];
            img.hidden = !(mouth || eye);
        }
        if (this.root) {
            this.root.dataset.lipsync = active ? 'on' : 'off';
            for (const [id, config] of Object.entries(this.characters)) {
                const value = config.blinkTiming === 'mark' ? markShape(mouths[id]) : mouths[id];
                this.root.dataset[id+'Mouth'] = active && !(config.restUsesOriginal && mouths[id] === 'X') ? value : 'original';
                this.root.dataset[id+'Blink'] = blinks[id] || 'original';
            }
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
        this.speaker = player.active && !player.inGap ? characterForCue(this.pack, player.cues[player.index]) : null;
        this.apply();
    }
    apply() {
        const active = this.enabled && this.ready && !this.failed;
        // Cast entry is scene content, so it remains visible as a static layer
        // when motion is disabled. Legacy scenes keep their fallback behavior.
        const castEntry = this.pack.cinematic?.layers?.some(l => l.entryTurn) ?? false;
        this.root?.classList.toggle('layered', active || (castEntry && this.ready && !this.failed));
        if (this.root) {
            this.root.dataset.speaker = this.speaker || '';
            this.root.classList.toggle('scene-paused', document.hidden || this.recording || !this.enabled);

        }
        this.renderFaces();
        const toggle = document.getElementById('motion-toggle');
        if (toggle) { toggle.setAttribute('aria-pressed', String(this.enabled)); toggle.textContent = `Chuyển động nhân vật: ${this.enabled ? 'Bật' : 'Tắt'}`; }
    }
}
