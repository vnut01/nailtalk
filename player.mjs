import { audioFormat, audioPath } from "./media.mjs";
// Manifest-based timeline and transport shared by all lesson audio.
export const speakerIcon = `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>
<path d="M16 8q5 4 0 8m3-11q8 7 0 14" fill="none" stroke="currentColor" stroke-width="2"/>
</svg>`;
const playIcon = `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="m7 4 14 8-14 8z" fill="currentColor"/>
</svg>`;
const stopIcon = `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M5 5h14v14H5z" fill="currentColor"/>
</svg>`;
export function timeline(cues) {
    let total = 0;
    const offsets = cues.map(c => {
        const start = total;
        total += c.duration_ms || 0;
        return start;
    });
    return { offsets, total };
}
export const adjacent = (index, delta, length) => Math.max(0, Math.min(length - 1, index + delta));
// Only a new full listen consumes a turn; transport within it is free.
export function listenCount(count, action) {
    return action === "begin" ? Math.min(2, count + 1) : count;
}
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export class AudioPlayer {
    constructor(cues, options = {}) {
        this.cues = cues;
        this.options = options;
        this.track = timeline(cues);
        this.position = 0;
        this.index = 0;
        this.active = false;
        this.rate = 1;
        this.audio = new Audio();
        this.audio.preservesPitch = true;
        this.audio.setAttribute?.('playsinline', '');
        this.audio.preload = 'none';
        this.audio.autoplay = false;
        this.format = audioFormat(type => this.audio.canPlayType?.(type) || '');
        this.audio.ontimeupdate = () => {
            if (!this.active) return;
            this.position = Math.min(this.track.total, this.track.offsets[this.index] + this.audio.currentTime * 1000);
            this.update();
        };
        this.audio.onended = () => {
            if (!this.active) return;
            if (this.index < this.cues.length - 1)
                this.go(this.index + 1, 0, true);
            else {
                this.active = false;
                this.position = this.track.total;
                this.update();
                this.options.onFinish?.();
            }
        };
        this.audio.onerror = () => this.fail();
    }
    mount(root) {
        this.root = root;
        const compact = this.options.compact && this.cues.length === 1;
        root.innerHTML = compact ? `<button class="audio-toggle primary" type="button"></button>` : `<button class="audio-toggle primary" type="button">
</button>
      <p class="now-playing" aria-live="polite">
</p>
      <div class="progress-wrap">
<div class="audio-progress" role="progressbar" aria-label="Tiến độ nghe" aria-valuemin="0" aria-valuemax="${this.track.total}" aria-valuenow="0"><div class="progress-fill"></div></div>
<div class="ticks" aria-hidden="true">${this.track.offsets.slice(1).map(t => `<i style="left:${100 * t / this.track.total}%">
</i>`).join("")}</div>
</div>
      <p class="audio-time">
</p>
      ${this.cues.length > 1 ? `<div class="controls">
<button data-action="prev">${speakerIcon} ⟲ Câu trước</button>
<button data-action="next">${speakerIcon} Câu sau ⟳</button>
<button data-action="restart">${speakerIcon} Nghe lại câu này</button>
</div>` : ""}
      ${this.options.slower ? "<button data-action=\"speed\" aria-label=\"Tốc độ nghe\">1×</button>" : ""}`;
        root.querySelector(".audio-toggle").onclick = () => this.toggle();
        for (const action of ["prev", "next", "restart"]) {
            const el = root.querySelector(`[data-action="${action}"]`);
            if (el)
                el.onclick = () => {
                    if (!this.active)
                        return;
                    const index = adjacent(this.index, action === "prev" ? -1 : action === "next" ? 1 : 0, this.cues.length);
                    this.go(index, 0, true);
                };
        }
        const speed = root.querySelector("[data-action=\"speed\"]");
        if (speed)
            speed.onclick = () => {
                this.rate = this.rate === 1 ? 0.75 : 1;
                this.audio.playbackRate = this.rate;
                this.update();
            };
        this.update();
    }
    toggle() {
        if (this.options.blocked?.()) return;
        if (this.active) {
            this.stop();
            return;
        }
        if (this.options.allowed && !this.options.allowed())
            return;
        this.options.onBegin?.();
        this.options.activate?.(this);
        this.go(0, 0, true);
    }
    go(index, offset = 0, start = false) {
        this.audio.pause();
        this.index = index;
        this.position = this.track.offsets[index] + offset;
        const path = audioPath(this.cues[index], this.format);
        if (!path) { this.fail(); return; }
        const src = new URL(`./packs/L-S07/${path}`, location.href).href;
        if (this.audio.src !== src)
            this.audio.src = src;
        this.audio.currentTime = offset / 1000;
        this.audio.playbackRate = this.rate;
        this.active = start;
        if (start)
            this.audio.play().catch(error => { if(error.name !== "AbortError")this.fail(); });
        this.update();
    }
    stop() {
        this.active = false;
        this.audio.pause();
        this.audio.currentTime = 0;
        this.position = 0;
        this.index = 0;
        this.update();
    }
    destroy() {
        this.stop();
        this.audio.removeAttribute("src");
        this.audio.load();
        this.root = null;
    }
    fail() {
        this.stop();
        this.options.onError?.();
    }
    update() {
        if (!this.root?.isConnected)
            return;
        const toggle = this.root.querySelector(".audio-toggle");
        const label = this.active ? "Dừng" : "Nghe";
        const compact = this.options.compact && this.cues.length === 1;
        toggle.innerHTML = `${compact ? (this.active ? stopIcon : speakerIcon) : `${speakerIcon}${this.active ? stopIcon : playIcon}<span>${label}</span>`}
<span class="sound-waves" aria-hidden="true">▂▆▃</span>`;
        toggle.setAttribute("aria-pressed", String(this.active));
        toggle.setAttribute("aria-label", `${label} · ${this.options.label || "audio"}`);
        toggle.disabled = !this.active && this.options.allowed && !this.options.allowed();
        this.root.classList.toggle("is-playing", this.active);
        if (compact) {
            this.options.onUpdate?.(this);
            return;
        }
        const progress = this.root.querySelector(".audio-progress");
        progress.setAttribute("aria-valuenow", String(this.position));
        progress.setAttribute("aria-valuetext", `${clock(this.position)} / ${clock(this.track.total)}`);
        progress.querySelector(".progress-fill").style.width = `${100 * this.position / this.track.total}%`;
        this.root.querySelector(".audio-time").textContent = `${clock(this.position)} / ${clock(this.track.total)}`;
        this.root.querySelector(".now-playing").textContent = this.cues.length > 1 ? `Câu ${this.index + 1}/${this.cues.length} · ${this.cues[this.index].speaker}` : "";
        this.root.querySelectorAll("[data-action]").forEach(el => {
            if (el.dataset.action !== "speed")
                el.disabled = !this.active;
        });
        const speed = this.root.querySelector("[data-action=\"speed\"]");
        if (speed)
            speed.textContent = this.rate === 1 ? "1×" : "0,75×";
        this.options.onUpdate?.(this);
    }
}
