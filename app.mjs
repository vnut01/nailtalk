import { CinematicScene } from "./cinematic.mjs";
import { audioFormat } from "./media.mjs";
import { AudioPlayer } from "./player.mjs";
import { STEPS, nextStep, cueState, initialState, completeStep, summarize, outcome } from "./logic.mjs";
import * as store from "./storage.mjs";
const $ = s => document.querySelector(s);
const catalog = await Promise.all(['L-S01','L-S02','L-S03','L-S04','L-S05','L-S06','L-S07','L-S08'].map(async id => (await fetch(`./packs/${id}/pack.json`)).json()));
const lessonId = catalog.some(p => p.id === location.hash.slice(1).split('/')[0]) ? location.hash.slice(1).split('/')[0] : 'L-S07';
const pack = catalog.find(p => p.id === lessonId);
const native = pack.ui?.kind === 'native';
const pilot = native || pack.ui?.kind === 'clarification';
const enabled = step => !pack.enabled_steps || pack.enabled_steps.includes(step);
const advance = step => { let next = nextStep(step); while(next !== 'summary' && !enabled(next)) next = nextStep(next); return next; };
export const scene = new CinematicScene(pack);
const format = audioFormat(type => document.createElement("audio").canPlayType(type));
let state = await store.load(lessonId) || initialState(), index = 0, attempt = 1, gIndex = 0, recorder = null, stream = null, recordTimer = null, timerTick = null, take = null, takeURL = null, pending = null, showText = false, micError = "", busy = false, installPrompt = null, packAvailable = true;
// Cue identities/rubric are unchanged from v002–v004; retain existing evidence.
if (['APP_PROTO_v002_DRAFT', 'APP_PROTO_v003_DRAFT', 'APP_PROTO_v004_DRAFT', 'APP_PROTO_v005_DRAFT', 'APP_PROTO_v006_DRAFT', 'APP_PROTO_v006b_DRAFT'].includes(state.pack)) state.pack = pack.pack_version;
if (state.pack !== pack.pack_version)
    state = initialState();
state.pack = pack.pack_version;
const titles = { A: "Nghe tình huống", B: "Nghe và nhận biết số", C: "Chọn câu trả lời", D: "Nghe mẫu và khám phá", E: "Luyện nói", F: "Phản hồi", G: "Thử trong tình huống mới", summary: "Nhìn lại bài học" };
const homeTitles = ["Chào khách và mời chờ", "Xác nhận màu khách muốn", "Hỏi cách viết tên", "Kiểm tra và hẹn giờ", "Xin khách nhắc lại qua điện thoại", "Hỏi sự thoải mái và báo quản lý", "Nói giá và làm rõ con số", "Hiểu lời khách nói nhỏ"];
const canDos = ["Trả lời khách ghé tiệm và mời ngồi chờ.", "Hỏi lại đúng màu trước khi bắt đầu.", "Hỏi cách viết và đọc lại tên đặt hẹn.", "Xin khách đợi trong khi kiểm tra giờ.", "Xin nhắc lại chi tiết và xác nhận qua điện thoại.", "Sắp xếp tay; dừng và báo quản lý khi có vấn đề.", "Nói rõ giá, sửa hiểu nhầm và xác nhận lựa chọn.", "Hiểu yêu cầu trước khi đáp và nói việc sẽ làm."];
const heardB = new Set();
const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const pronunciationHTML = s => escape(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
const button = (id, text, cls = "", disabled = false) => `<button id="${id}" class="${cls}" ${disabled ? "disabled" : ""}>${text}</button>`;
function bind(id, fn) {
    const el = document.getElementById(id);
    if (el)
        el.onclick = fn;
}
async function persist() {
    await store.save(state, lessonId);
    $("#storage").textContent = `Lưu tiến độ: ${store.storageMode}. Xóa dữ liệu trình duyệt có thể làm mất tiến độ.`;
}
function event(data) {
    return { ...data, at: new Date().toISOString(), pack: pack.pack_version, rubric: pack.rubric_version };
}
function disposeTake() {
    if (takeURL)
        URL.revokeObjectURL(takeURL);
    takeURL = null;
    take = null;
}
function stopMedia() {
    document.querySelectorAll("audio").forEach(audio => audio.pause());
    for (const player of players.values())
        player.destroy();
    players.clear();
    if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
    }
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    clearTimeout(recordTimer);
    clearInterval(timerTick);
    recorder = null;
    busy = false;
    scene.recording = false; scene.apply();
    disposeTake();
    pending = null;
    showText = false;
    recapOpen = false;
}
function nav(step) {
    stopMedia();
    state.step = step;
    repairMode=false; repairSaid=false; repairReplays=0; letters=[];
    index = 0;
    attempt = 1;
    gIndex = 0;
    micError = "";
    location.hash = `${lessonId}/${step}`;
    render();
}
function cueHTML(id, reveal = false) {
    const c = pack.cues[id];
    return `${!c.audio ? "<p class=\"warning\">Audio sắp có · Luyện tập có hỗ trợ; không chấm nghe.</p>" : ""}${reveal || !c.audio ? `<p class="target">${escape(c.english)}</p>${c.vietnamese ? `<p>${escape(c.vietnamese)}</p>` : ""}` : ""}`;
}
// Retain transport position while support text/recap re-renders; dispose on navigation.
const players = new Map(), playerConfigs = new Map();
let recapOpen = false, scenePlayer = "";
function playerHTML(key, ids, options = {}) {
    ids=ids.filter(Boolean);
    if (!ids.length) return "";
    if (ids.some(id => !pack.cues[id]?.audio))
        return "<p class=\"warning\">Audio sắp có</p>";
    playerConfigs.set(key, { ids, options });
    return `<div class="${options.scene ? "scene-player" : options.compact && ids.length === 1 ? "audio-cue" : "audio-player"}" data-player="${key}">
</div>`;
}
function mountPlayers() {
    for (const [key, player] of players) {
        const config = playerConfigs.get(key);
        if (!config || config.ids.join() !== player.ids.join()) {
            player.destroy();
            players.delete(key);
        }
    }
    for (const [key, { ids, options }] of playerConfigs) {
        if (!players.has(key)) {
            const player = new AudioPlayer(ids.map(id => ({...pack.cues[id], gap_after_ms: options.gaps?.[id] || 0})), {
                ...options,
                blocked: () => busy,
                onUpdate: player => { options.onUpdate?.(player); scene.update(player); },
                activate: active => {
                    for (const other of players.values())
                        if (other !== active)
                            other.stop();
                },
                onError: () => {
                    micError = "Không phát được audio trên thiết bị này. Dùng văn bản hỗ trợ; không chấm nghe.";
                    state.audioFailed = true;
                    showText = true;
                    if(state.step === "D")state.d[pack.teaching[index]]=event({played:false,assisted:true});
                    render();
                }
            });
            player.ids = ids;
            players.set(key, player);
        }
        players.get(key).mount(document.querySelector(`[data-player="${key}"]`));
    }
}
function updateListenStatus(player) {
    highlightTranscript(player);
    const status = $("#listen-status");
    if (status) status.textContent = player.active
        ? `${player.cues[player.index].speaker} · Câu ${player.index + 1}/${player.cues.length}`
        : state.a === 0 ? (pack.ui?.listen || "") : "";
    // A replay shows only the line indicator; restore the open recap at stop/end.
    const recap = $(".step-A .recap");
    if (recap) recap.hidden = player.active;
    const fallback = $(".step-A .transcript-lines")?.closest("details");
    if (fallback) fallback.hidden = player.active;
}
function highlightTranscript(player) {
    document.querySelectorAll("[data-line]").forEach(el => {
        const current = Number(el.dataset.line) === player.index;
        el.classList.toggle("current-line", current && player.active);
        if (current && el.parentElement.classList.contains("transcript-lines"))
            el.parentElement.scrollTop = el.offsetTop;
        el.setAttribute("aria-current", String(current && player.active));
    });
}
function questionHTML(id) {
    const c = pack.cues[id];
    if (!c) return "";
    return `<p class="question"><strong>${escape(c.speaker)}:</strong> ${escape(c.english)}</p>`;
}
function swatchHTML(item, selected) {
    return `<div class="swatches" role="group" aria-label="Chọn ô màu">${item.options.map((o, i) => `<button id="swatch${i}" class="swatch" style="--swatch:${o.color}" aria-label="${escape(o.label)}" aria-pressed="${selected === o.value}"><span aria-hidden="true"></span></button>`).join("")}</div>`;
}
function swatchTask(item, history, transfer = false) {
    const choice = history?.at(-1);
    const selected = choice?.answer;
    const revealed = selected != null;
    return `${questionHTML(item.question)}<h2>${escape(item.prompt)}</h2>${revealed ? item.answer.map(id => cueHTML(id, true)).join('') : ''}${swatchHTML(item, selected)}${revealed ? `<p role="status">${escape(choice.correct ? item.feedback.correct : item.feedback.retry)}</p>${playerHTML('answer', item.answer, {label:'Nghe câu trả lời'})}` : ''}${transfer && revealed ? speechUI(pack.transfer.models[0], 'G') : ''}`;
}
function recapHTML() {
    if (native && pack.repair_unlock && !state.repaired) return "";
    if (native && state.step === "G" && !(pack.transfer.require_spoken ? state.g[gIndex]?.some(a=>a.evidence !== "không có bằng chứng") : state.g[gIndex]?.length)) return "";
    if (pilot) return `<section class="recap"><h2>Tóm tắt nhanh</h2>${pack.teaching.map(id => `<article>${questionHTML(pack.questions[id])}${cueHTML(id,true)}${playerHTML('recap-'+id,[pack.questions[id],id])}</article>`).join('')}</section>`;
    const recap = pack.recap;
    const phrase = (item, key) => `<article>
<div class="exchange">${questionHTML(pack.questions[item.cue])}<div class="cue-row"><p class="target">Linh: ${escape(item.english)}</p>${playerHTML(key, [pack.questions[item.cue], item.cue], { compact: true, label: item.english })}</div>${item.vietnamese ? `<p>${escape(item.vietnamese)}</p>` : ""}${item.aid ? `<p class="muted">Gợi ý phát âm: ${pronunciationHTML(item.aid)}</p>` : ""}</div></article>`;
    return `<section class="recap" aria-label="Tóm tắt nhanh">
<h2>Tóm tắt nhanh</h2>${state.step === "A" && state.aFull ? "<p>Bạn vừa nghe: các câu chính</p>" : ""}${recap.teaching.map((item, i) => phrase(item, `recap-${i}`)).join("")}<h3>Các con số về giá</h3>
<p>${escape(recap.stress)}</p><ul class="price-words">${recap.prices.map((item, i) => `<li class="cue-row">
<span>${escape(pack.cues[item.question].english)} → ${escape(item.english)}</span>${playerHTML(`recap-price-${i}`, [item.question, item.cue], { compact: true, label: item.english })}</li>`).join("")}</ul><h3>Price List · giá minh họa</h3>
<ul class="price-board">${recap.board.map(line => `<li>${escape(line)}</li>`).join("")}</ul>
<h3>${escape(pack.transfer.unknown_card)}</h3>${phrase(recap.manager, "recap-manager")}</section>`;
}
function shell(content) {
    const crop = pack.scene.phone_crop;
    const stepCrop = pack.scene.step_crop || crop;
    const stepStyle = `--step-scene-width:calc(100cqw * ${pack.geometry.width} / ${stepCrop.width});--step-scene-left:calc(-100cqw * ${stepCrop.x} / ${stepCrop.width});--step-scene-top:calc(-100% * ${stepCrop.y} / ${stepCrop.height});--step-scene-ratio:${stepCrop.width} / ${stepCrop.height};`;
    const cropStyle = stepStyle + `--phone-scene-width:calc(100cqw * ${pack.geometry.width} / ${crop.width});--phone-scene-left:calc(-100cqw * ${crop.x} / ${crop.width});--phone-scene-top:calc(-100% * ${crop.y} / ${crop.height});--phone-scene-ratio:${crop.width} / ${crop.height}`;
    const hasScene = ["A", "B", "C", "D", "E", "G"].includes(state.step);
    const step = pack.steps[state.step];
    return `<section class="step-heading">${pack.title ? `<p class="eyebrow">${escape(pack.title)} · ${escape(pack.subtitle)}</p>` : ""}<h1>${escape(step ? `${state.step} · ${step.topic}` : titles[state.step])}</h1>${step ? `<p>${escape(step.goal)}</p>` : ""}</section>
<div class="player ${hasScene ? "" : "task-only"} step-${state.step}">
${hasScene ? `<aside><div role="group" aria-label="${escape(pack.ui?.scene_label || "Linh và Mark tại quầy Bella Nails")}" class="scene scene-main ${pack.ui?.contact_crop ? 'contact-crop' : ''} ${pack.scene.step_crop ? 'step-crop' : ''}" style="${cropStyle}">
<div class="scene-frame"><div class="scene-canvas"><span class="scene-layers" aria-hidden="true"></span>
<img src="packs/${lessonId}/${pack.scene.small}" alt="${escape(pack.ui?.scene_label || "Linh và Mark tại quầy; bảng giá trên tường")}"></div></div>
<span class="speaker-tag" aria-hidden="true">${escape(pack.ui?.scene_label || "Linh và Mark")}</span>
<button id="scene-enlarge" aria-label="Phóng to toàn cảnh">⤢</button>${scenePlayer}</div>
</aside>` : ""}
<section class="panel">${state.step === "A" ? `<p id="listen-status" role="status">${state.a === 0 ? (pack.ui?.listen || "") : ""}</p>${!state.volumeHintDismissed ? '<p id="volume-hint" class="muted">Bật âm lượng · Tắt chế độ im lặng</p>' : ""}` : ""}${content}${recapOpen && state.step !== "summary" ? recapHTML() : ""}${micError ? `<p class="warning" role="status">${escape(micError)}</p>` : ""}</section>
</div>${navigation()}`;
}
function navigation() {
    if (state.step === "summary") return "";
    return `<nav class="nav" aria-label="Điều hướng bài học"><div class="steps" role="group" aria-label="Các bước">${STEPS.slice(0,7).map(s => `<button data-step="${s}" class="${s === state.step ? "current" : state.visited.includes(s) ? "done" : ""}" ${s === state.step ? 'aria-current="step"' : ""} ${!enabled(s) ? 'disabled' : ""}>${s}</button>`).join("")}</div><div class="nav-actions">${button("next", "Tiếp tục", "primary", !completeStep(state, state.step, pack))}<button id="recap-toggle" aria-label="Tóm tắt" aria-expanded="${recapOpen}">≡</button>${button("skip", "Bỏ qua bước", "text-link")}</div></nav>`;
}

function renderHome() {
    stopMedia();
    document.body.classList.remove("in-lesson");
    scene.mount(null);
    $("#app").innerHTML = `<section class="intro"><p class="eyebrow">Bella Nails · Tiếng Anh dùng tại tiệm</p><h1>Từng câu nhỏ.<br>Tự tin hơn mỗi ngày.</h1><p>Luyện nghe, chọn câu và nói cùng Linh.</p><span class="badge">DRAFT</span></section><div class="lessons">${catalog.map(p => `<article class="lesson active"><span class="eyebrow">${p.id} · ${p.estimated_minutes} phút</span><h2>${escape(p.title || homeTitles[Number(p.id.slice(-2))-1])}</h2><p>${escape(p.subtitle || canDos[Number(p.id.slice(-2))-1])}</p><span class="badge">DRAFT</span><div class="controls">${button(p.id === 'L-S07' ? 'start' : 'start-'+p.id,'Bắt đầu học','primary',!packAvailable)}</div></article>`).join('')}</div>${button("install", "Cài lên màn hình chính", "", !installPrompt)}`;
    for (const p of catalog) bind(p.id === 'L-S07' ? 'start' : 'start-'+p.id, () => { if(p.id === lessonId) nav('A'); else location.hash = `${p.id}/A`; });
    bind("install", async () => {
        await installPrompt?.prompt();
        installPrompt = null;
        renderHome();
    });
}
function aSequence() {
    if (lessonId==='L-S08' && state.b.S08_CHEN_01?.at(-1)?.correct && state.e['S08_LINH_01:1']?.length) return pack.dialogue;
    return pack.a_dialogue || pack.dialogue;
}
function render() {
    if (!location.hash || location.hash === "#home") {
        renderHome();
        return;
    }
    if (!enabled(state.step) && state.step !== 'summary') state.step = 'A';
    if (state.step !== "summary" && !state.visited.includes(state.step))
        state.visited.push(state.step);
    playerConfigs.clear();
    scenePlayer = "";
    let content = "";
    switch (state.step) {
        case "A":
            scenePlayer = playerHTML("hear", aSequence(), { scene: true, gaps: pack.scene_gaps, label: "Nghe tình huống", onBegin: () => {
                    state.a = 1; // Persistent started marker for progression; playback is unlimited.
                    state.volumeHintDismissed = true;
                    persist();
                    $("#volume-hint")?.remove();
                }, onFinish: () => {
                    state.aFull = true;
                    recapOpen = true;
                    persist();
                    render();
                }, onUpdate: updateListenStatus });
            content = `${aSequence().some(id => !pack.cues[id].audio) || showText ? `<details open>
<summary>Văn bản hỗ trợ</summary>
<div class="transcript-lines">${aSequence().map((id, i) => `<div class="transcript-line" data-line="${i}">
<strong>${escape(pack.cues[id].speaker)}</strong>${cueHTML(id, true)}</div>`).join("")}</div></details>` : ""}`;
            break;
        case "B": {
            if (native) { content = nativeB(); break; }
            if (pack.b[index].activity === 'swatch') {
                const item = pack.b[index];
                scenePlayer = playerHTML('hear', item.listen, {scene:true, label:'Nghe hỏi và đáp về màu', onFinish:()=>{heardB.add(item.id);}});
                content = swatchTask(item, state.b[item.id]);
                break;
            }
            const item = pack.b[index], history = state.b[item.id] || [];
            scenePlayer = playerHTML("hear", [item.question, item.id], { scene: true, label: "Nghe hỏi và đáp về giá", onFinish: () => { heardB.add(item.id); render(); } });
            content = `<p class="task-count">Câu ${index + 1}/${pack.b.length}</p>
${questionHTML(item.question)}<h2>Bạn nghe thấy giá nào?</h2>${cueHTML(item.id, showText || history.some(h => h.answer !== null))}
<div class="options">${item.options.map((o, i) => button(`choice${i}`, `${o} dollars`, "", !!pack.cues[item.id].audio && !showText && !heardB.has(item.id))).join("")}</div>${history.length ? `<p role="status">${history.at(-1).answer === null ? "Đã bỏ qua câu này." : history.at(-1).correct ? "Đúng con số." : "Thử nghe lại và so sánh hai số nhé."} ${history.at(-1).assisted ? "Có hỗ trợ · không chấm nghe." : ""}</p>
` : ""}<div class="controls">${button("item-next", index === pack.b.length - 1 ? "Về câu đầu" : "Câu tiếp", "", !history.length)}${button("item-skip", "Bỏ qua câu này")}</div>`;
            break;
        }
        case "C":
            scenePlayer = playerHTML("hear", pack.c.lead_in, { scene: true, label: pilot ? "Nghe khách chọn màu" : "Nghe khách hiểu nhầm giá" });
            content = `${pack.c.lead_in.map(questionHTML).join("")}<p>${escape(pack.c.prompt || "Chọn câu giúp làm rõ con số.")}</p>
<div class="options">${pack.c.choices.map((c, i) => button(`choice${i}`, `${escape(c)}${pack.c.notes[i] ? "<small> (lặp lại như cũ, to hơn)</small>" : ""}`)).join("")}</div>${state.c.length ? `<p role="status">${escape(pack.c.explanations[state.c.at(-1).answer])}</p>${playerHTML("reply", pack.c.responses[state.c.at(-1).answer], { label: "Nghe câu đã chọn" })}<p class="muted">Đây là kết quả chọn câu; chưa phải bằng chứng nói.</p>` : ""}`;
            break;
        case "D": {
            const id = pack.teaching[index], c = pack.cues[id], revealed = state.d[id];
            scenePlayer = playerHTML("hear", [pack.questions[id], id].filter(Boolean), { scene: true, slower: true, onFinish: () => { state.d[id] = event({ played: true, assisted: false }); render(); } });
            content = `<p class="task-count">Thẻ mẫu ${index + 1}/${pack.teaching.length} · Không chấm điểm</p>

${pack.instructions?.[id] ? `<p>${escape(pack.instructions[id])}</p>` : ""}${questionHTML(pack.questions[id])}${revealed || !c.audio ? `${cueHTML(id, true)}<p class="muted">Gợi ý phát âm: ${pronunciationHTML(c.aid)}</p>` : ""}${button("card-next", "Thẻ mẫu tiếp", "", !revealed)}${pack.chunks ? `<h3>Từ ngắn để luyện nghe</h3>${playerHTML("chunks",pack.chunks,{label:"Nghe từ ngắn"})}` : ""}${native && pack.listen_for ? `<h3>Nghe để nhận ra</h3><p>Nghe mẫu ở tốc độ thường rồi chậm hơn. ${escape(pack.ui.recognition_hint || "Bạn nghe thấy cách nối âm / tên chữ cái nào?")}</p>${playerHTML("contrast",pack.listen_for,{slower:true,label:"Nghe để nhận ra · không chấm điểm"})}` : ""}${pilot ? "" : `<hr>
<h3>Nghe để nhận ra trọng âm</h3>
<p>Âm nào nhấn ở cuối? Không chấm điểm.</p>${playerHTML("contrast", ["S07_B_01", "S07_LINH_01"], { label: "Nghe cặp tương phản", onFinish: () => {
                    showText = true;
                    render();
                } })}${showText ? `<p>${escape(pack.cues.S07_B_01.english)} / ${escape(pack.cues.S07_LINH_01.english)}</p>
<p>${escape(pack.feedback[1])}</p>` : ""}`}`;
            break;
        }
        case "E": {
            const id = pack.teaching[index];
            scenePlayer = playerHTML("hear", attempt === 1 || showText ? [pack.questions[id], id].filter(Boolean) : [pack.questions[id]].filter(Boolean), { scene: true, label: "Nghe khách hỏi" });
            content = `<p class="task-count">Câu ${index + 1}/${pack.teaching.length} · Lượt ${attempt}/2 · tự đánh giá</p>
<h2>${attempt === 1 ? "Nói với câu mẫu" : "Thử nói khi không nhìn câu mẫu"}</h2>${pack.instructions?.[id] ? `<p>${escape(pack.instructions[id])}</p>` : ""}${attempt === 1 || showText ? `${questionHTML(pack.questions[id])}<p>${escape(pack.cues[id].vietnamese)}</p>` : `<p>${escape(pack.ui.speaking_prompt || 'Bạn là Linh. Nghe khách hỏi, rồi trả lời.')}</p>`}${attempt === 1 || showText ? `<p class="target">${escape(pack.cues[id].english)}</p>` : ""}${speechUI(id, "E")}<div class="controls">${button("e-next", attempt === 1 ? "Lượt 2 · ẩn câu mẫu" : "Câu tiếp", "", !state.e[`${id}:${attempt}`]?.length)}</div>`;
            break;
        }
        case "F":
            content = pilot ? `<h2>${native ? "Xem lại ý nghĩa và hành động" : "Hỏi lại trước khi bắt đầu"}</h2><span class="badge">tự đánh giá</span>${pack.teaching.map(id => `<article class="exchange">${questionHTML(pack.questions[id])}${cueHTML(id,true)}</article>`).join('')}<p>${escape(pack.feedback[0])}</p><p>${pronunciationHTML(pack.feedback[1])}</p>${native && pack.drills ? "<p>Tiếp sang G để luyện dừng, báo quản lý và xử lý tình huống khẩn cấp.</p>" : ""}${button('feedback','Đã xem phản hồi','primary')}` : `<h2>Ý nghĩa trước, rõ lời sau</h2>
<p class="badge">tự đánh giá</p>${pack.teaching.map(id => `<article class="exchange">${questionHTML(pack.questions[id])}<p>Câu trả lời bạn luyện: ${escape(pack.cues[id].english)}</p><p>Mẫu Linh: ${escape(pack.cues[id].english)}</p><p class="muted">${state.e[`${id}:2`]?.length ? 'Đã có tự đánh giá lượt 2.' : 'Chưa có bằng chứng lượt 2.'} Câu mục tiêu để bạn đối chiếu.</p></article>`).join("")}
<p>${escape(pack.feedback[0])} <small>— khi bạn tự kiểm tra và thấy khách hiểu đúng giá.</small>
</p>
<p>Bạn có nghe rõ con số trong bản ghi của mình không?</p>
<p>${escape(pack.feedback[1])}</p>
<p class="muted">Đọc từng chữ số là cách sửa hiểu nhầm trong tình huống này.</p>${button("feedback", "Đã xem phản hồi", "primary")}`;
            break;
        case "G": {
            if (native) { content = nativeG(); break; }
            if (pack.transfer.activity === 'swatch') {
                const item = pack.transfer;
                scenePlayer = playerHTML('hear', [item.question], {scene:true, label:'Nghe khách muốn màu nhạt hơn'});
                content = swatchTask(item, state.gSwatch, true);
                break;
            }
            const id = pack.transfer.models[gIndex], prompt = pack.transfer.prompts[gIndex];
            scenePlayer = playerHTML("hear", [prompt], { scene: true, label: "Nghe khách hỏi (ngoài khung hình)" });
            content = `<p class="task-count">Tình huống ${gIndex + 1}/2 · tự đánh giá</p>
<h2>${gIndex === 0 ? "Khách chọn dịch vụ khác" : "Khách hỏi thêm"}</h2>${questionHTML(prompt)}<p class="muted">Giọng khách ngoài khung hình.</p><div class="price" aria-label="Thẻ thông tin tình huống">${gIndex === 0 ? "<small>Giá minh họa</small>" : ""}${escape(gIndex === 0 ? pack.transfer.price_card : pack.transfer.unknown_card)}</div>
<p>${gIndex === 0 ? "Nhìn thẻ, rồi nói giá cho khách." : "Bạn chưa biết giá vẽ móng. Nói để xin kiểm tra."}</p>${speechUI(id, "G")}${gIndex === 0 ? button("g-next", "Khách hỏi tiếp", "", !state.g[0]?.length) : "<p class=\"muted\">Không đoán giá vẽ móng.</p>"}`;
            break;
        }
        case "summary": {
            const s = summarize(state, pack);
            content = pilot ? `${recapHTML()}${native ? Object.entries(state.g).map(([i,list])=>`<p>Tình huống ${Number(i)+1}: ${escape(list.at(-1)?.outcome || 'Chưa có bằng chứng')} · tự đánh giá</p>`).join('') : ''}<h2>${s.completed ? "Đã hoàn thành các bước" : "Bạn có thể quay lại luyện tiếp"}</h2><p>Hoàn thành không có nghĩa là đã thành thạo.</p>${pack.teaching.map(id => `<article><p>${escape(pack.cues[id].english)}</p><p>${escape(state.e[`${id}:2`]?.at(-1)?.outcome || 'Chưa có bằng chứng lượt 2')} · tự đánh giá</p></article>`).join('')}${button('again','Luyện lại từ A')}` : `${recapHTML()}<h2>${s.completed ? "Đã hoàn thành các bước" : "Bạn có thể quay lại luyện tiếp"}</h2>
<p>Hoàn thành là đã ghé các bước và thử hoặc chọn bỏ qua; không có nghĩa là đã thành thạo.</p>
<div class="summary-grid">
<article class="summary-card">
<h3>B · Nhận biết số</h3>
<p>${s.B.correct}/${s.B.scored} câu đầu không hỗ trợ đúng.</p>
<p>${s.B.assisted} câu có hỗ trợ, không chấm nghe.</p>
</article>
<article class="summary-card">
<h3>C · Chọn câu</h3>
<p>${s.C.first ? s.C.first.correct ? "Câu đầu phù hợp" : "Câu đầu cần xem lại" : "Đã bỏ qua"}</p>
<p>${s.C.attempts.length} lần chọn · Không chứng minh đã nói.</p>
</article>${["E", "G"].map(k => `<article class="summary-card">
<h3>${k} · ${k === "E" ? "Luyện nói" : "Vận dụng"}</h3>
<span class="badge">tự đánh giá</span>${k === "G" ? `<p>Toàn tình huống: ${s.G.latestOutcome}</p>
<p class="muted">Lần đầu: ${s.G.firstOutcome}. Không gộp với E hay chọn đáp án.</p>` : ""}${Object.entries(s[k].attempts).map(([id, list]) => `<p>${escape(pack.cues[id.split(":")[0]]?.english || "Lượt luyện nói")}: ${escape(list.at(-1).outcome)}<br>
<small>${escape(list.at(-1).evidence)} · ${list.at(-1).assisted ? "Có hỗ trợ" : "Không nhìn câu mẫu"} · ${list.length} lần thử</small>
</p>`).join("") || "<p>Không có bằng chứng · đã bỏ qua</p>"}</article>`).join("")}</div>
<label>Tự tin sau bài học <select id="confidence">
<option value="">Chưa chọn</option>${[1, 2, 3, 4, 5].map(n => `<option ${state.confidence === String(n) ? "selected" : ""}>${n}</option>`).join("")}</select>
</label>
<div class="controls">${button("again", "Luyện lại từ A")}</div>`;
            break;
        }
    }
    $("#app").innerHTML = shell(content);
    bindCommon();
    mountPlayers();
    bindStep();
    persist();
}
// Lesson-native recognition and transfer stay inside the shared A–G transport.
let letters = [], repairMode = false, repairSaid = false, repairReplays = 0, caseIndex = 0;
function nativeB() {
    const i=pack.b[index], h=state.b[i.id]||[], last=h.at(-1);
    if(i.requires_repair && !state.repaired) {
        scenePlayer=playerHTML('hear',['S05_LINDA_01'],{scene:true});
        return `<h2>Hỏi lại trước khi nghe chi tiết mới</h2><p>Hãy nói câu xin nhắc lại. Ngày và giờ mới chưa nghe được vì mất tiếng.</p>${speechUI('S05_LINH_01','E')}`;
    }
    scenePlayer=playerHTML('hear',repairMode&&repairSaid&&i.repeat?[i.repeat] : i.replay&&repairReplays>0?[i.replay]:i.listen,{scene:true,label:'Nghe tình huống',onFinish:()=>{heardB.add(i.id);render();}});
    const repaired=repairMode && !repairSaid;
    const opts=i.activity_type==='letters' ? i.options.map((o,n)=>button('letter'+n,escape(o),'',letters.includes(n)||!heardB.has(i.id))).join('') : i.options.map((o,n)=>button('native-choice'+n,(i.activity_type==='nail_shape'?`<span class="nail-option ${n===1?'long':''} ${n===2?'square':''}" aria-hidden="true"></span>`:'')+escape(o),'',!heardB.has(i.id))).join('');
    return `<h2>${escape(i.prompt)}</h2>${repaired?`<p>Hỏi lại bằng lời trước khi nghe mẫu chậm hơn.</p>${button('repair-said','Tôi đã nói câu xin nhắc lại')}`:i.activity_type==='letters'?`<p aria-live="polite">${letters.map(n=>escape(i.options[n])).join(' – ')}</p><div class="options">${opts}</div>${button('letters-check','Kiểm tra', '',letters.length!==i.options.length)}${button('letters-reset','Xếp lại')}`:`<div class="options">${opts}</div>`}${last?`<p role="status">${i.formative?'Phần ngày và giờ bị mất tiếng; hỏi lại là cách chắc chắn nhất.':last.correct?(i.feedback?.correct || 'Đúng rồi.'): (i.feedback?.retry || 'Chưa đúng — nghe lại hoặc hỏi lại nhé.')}</p>${(!i.repeat || last.correct || repairReplays>=2)?cueHTML(i.id,true):''}${i.option_cues?playerHTML('options',i.option_cues,{label:'Nghe các lựa chọn sau khi chọn'}):''}`:''}${i.repair && last?.correct ? `${speechUI(i.ack[0],'E')}${state.e[i.ack[0]+':1']?.length ? playerHTML('ack',i.ack,{label:'Nghe sau khi đã hiểu'}) : ''}`:''}${repairReplays>=2&&!last?.correct?`<p>Văn bản hỗ trợ: ${escape(pack.cues[i.repeat]?.english)}</p>`:''}${button('native-next','Câu tiếp','',!h.length)}${pack.repair_unlock&&state.repaired?playerHTML('repaired',pack.repair_unlock,{label:'Nghe đoạn sau khi hỏi lại'}):''}`;
}
function bindNativeB() {
    const i=pack.b[index];
    if(i.requires_repair&&!state.repaired) {bindSpeech('S05_LINH_01','E');return;}
    if(i.repair&&state.b[i.id]?.at(-1)?.correct)bindSpeech(i.ack[0],'E');
    const answer=value=>{
        if(i.replay&&value===i.options.at(-1)){
            repairReplays=Math.min(2,repairReplays+1);
            (state.replays||={})[i.id]=event({count:repairReplays,source:'recognition support',penalty:false});
            if(repairReplays===2)(state.b[i.id]||=[]).push(event({answer:null,correct:false,assisted:true,listening:false}));
            render();players.get('hear')?.toggle();return;
        }
        const correct=value===i.key;
        (state.b[i.id]||=[]).push(event({answer:value,correct,assisted:!!i.formative||repairReplays>=2||!heardB.has(i.id),listening:!i.formative&&repairReplays<2&&heardB.has(i.id)}));
        if(i.repair&&!correct){repairMode=true;repairSaid=false;}
        render();
    };
    if(i.activity_type==='letters') {
        i.options.forEach((_,n)=>bind('letter'+n,()=>{letters.push(n);render();}));
        bind('letters-check',()=>answer(letters.map(n=>i.options[n]).join('')));bind('letters-reset',()=>{letters=[];render();});
    } else i.options.forEach((o,n)=>bind('native-choice'+n,()=>answer(o)));
    bind('repair-said',()=>{repairSaid=true;repairReplays++;(state.repairs||=[]).push(event({step:state.step,evidence:'tự báo cáo, không ghi âm',source:'speaking repair'}));render();});
    bind('native-next',()=>{index=(index+1)%pack.b.length;letters=[];repairMode=false;repairSaid=false;repairReplays=0;render();});
}
function nativeTurns() {return [...(pack.drills||[]),...pack.transfer.turns];}
function currentTurn() {return nativeTurns()[gIndex];}
function nativeG() {
    const t=currentTurn(), gate=state.nativeGates?.[gIndex], h=state.g[gIndex];
    scenePlayer=playerHTML('hear',repairMode&&repairSaid&&t.repeat?[t.repeat]:t.prompts,{scene:true,label:'Nghe tình huống mới'});
    const spoken = pending?.evidence && pending.evidence !== 'không có bằng chứng' || h?.some(a=>a.evidence !== 'không có bằng chứng');
    const blocked=t.gate&&!gate?.correct&&repairReplays<2;
    const gateUI=blocked?`<h2>${escape(t.gate.prompt)}</h2><div class="options">${t.gate.options.map((o,n)=>button('gate'+n,escape(o),'',repairMode&&!repairSaid)).join('')}</div>`:'';
    const repair=repairMode&&!repairSaid?`<p>Hãy nói câu xin nhắc lại trước khi nghe lại.</p>${button('repair-said','Tôi đã nói câu xin nhắc lại')}`:'';
    return `<p class="task-count">Tình huống ${gIndex+1}/${nativeTurns().length} · tự đánh giá</p><h2>${escape(t.situation)}</h2>${t.instruction ? `<p>${escape(t.instruction)}</p>` : ""}${state.audioFailed && pack.transfer.require_spoken ? t.prompts.map(questionHTML).join("") : ""}${t.card?`<div class="price">${escape(t.card)}</div>`:''}${gateUI}${repair}${!blocked&&!repair?`${speechUI(t.models[0],'G')}${(pack.transfer.require_spoken ? spoken : pending||h?.length)?playerHTML('full-model',[...t.models,...(t.confirmation||[])],{label:'Nghe đủ lời mẫu sau khi nói'}):''}`:''}${h?.length&&t.feedback?`<p role="status">${escape(h.at(-1).outcome==='Đạt'?t.feedback.correct:t.feedback.retry)}</p>`:''}${t.safety&&pending?'<label><input type="checkbox" id="unsafe">Tôi đã tiếp tục, chẩn đoán, khuyên chữa trị hoặc trì hoãn giúp khẩn cấp.</label>':''}${t.repair&&!repairMode?button('need-repair','Chưa rõ · xin nhắc lại'):''}${t.alternative&&repairMode?playerHTML('repair-alt',[t.alternative],{label:'Cách xin nói chậm hơn'}):''}${repairReplays>=2?`<p>Văn bản hỗ trợ: ${escape(pack.cues[t.repeat]?.english)}</p>`:''}${h?.length&&gIndex<nativeTurns().length-1?button('native-g-next','Tình huống tiếp'):''}${t.followup&&h?.at(-1)?.outcome==='Cần thử lại'?`<p>${escape(t.followup.prompt)} · chỉ ghi nhận nghe hiểu</p>${t.followup.options.map((o,n)=>button('follow'+n,o)).join('')}`:''}${pack.cases&&gIndex===nativeTurns().length-1&&h?.length?nativeCase():''}`;
}
function nativeCase(){const c=pack.cases[caseIndex];return `<h3>Sau khi quản lý kiểm tra</h3><p>${escape(c.text)}</p>${playerHTML('case',c.listen,{label:'Nghe cách xử lý'})}<p>Bây giờ làm gì?</p>${[c.key,'Linh tiếp tục sau khi nghỉ một chút'].map((o,n)=>button('case'+n,escape(o))).join('')}${state.cases?.[caseIndex]?`<p>${state.cases[caseIndex].correct?'Đúng: dừng dịch vụ và xử lý theo mẫu.':'Không tiếp tục dịch vụ.'}</p>${button('case-next','Trường hợp tiếp')}`:''}`;}
function bindNativeG() {
    const t=currentTurn();
    bindSpeech(t.models[0],'G');
    t.gate?.options.forEach((o,n)=>bind('gate'+n,()=>{
        const correct=o===t.gate.key;
        (state.nativeGates||={})[gIndex]=event({answer:o,correct});
        if(!correct&&t.repair){repairMode=true;repairSaid=false;}
        render();
    }));
    bind('need-repair',()=>{repairMode=true;repairSaid=false;render();});
    bind('repair-said',()=>{repairSaid=true;repairReplays++;(state.repairs||=[]).push(event({step:state.step,evidence:'tự báo cáo, không ghi âm',source:'speaking repair'}));render();});
    bind('native-g-next',()=>{stopMedia();gIndex++;repairMode=false;repairSaid=false;repairReplays=0;render();});
    t.followup?.options.forEach((o,n)=>bind('follow'+n,()=>{(state.followups||={})[gIndex]=event({answer:o,correct:o===t.followup.key,source:'recognition'});persist();}));
    [0,1].forEach(n=>bind('case'+n,()=>{(state.cases||={})[caseIndex]=event({correct:n===0,source:'recognition'});render();}));
    bind('case-next',()=>{caseIndex=(caseIndex+1)%pack.cases.length;render();});
}

function speechUI(id, type) {
    const done = type === "E" ? state.e[`${id}:${attempt}`] : state.g[gIndex];
    const captured = pending?.id === id;
    const modelAllowed = type !== 'G' || !pack.transfer.require_spoken || captured || done?.some(a=>a.evidence !== 'không có bằng chứng');
    return `<p class="muted mic-privacy">Ghi âm chỉ trên máy. <a href="#" id="privacy-link">Riêng tư</a></p>${!pack.cues[id].audio ? "<p class=\"warning\">Audio sắp có · Luyện có hỗ trợ.</p>" : ""}<div class="controls">${button("record", "Ghi âm", "primary", busy)}${button("stop", "Dừng", "", !busy)}${button("aloud", "Tôi đã nói thành tiếng", "", busy)}${button("speak-skip", "Bỏ qua lượt này", "", busy)}</div>
<p id="timer" class="recording" role="status">
</p>${takeURL ? `<p>Nghe bản của bạn:</p>
<audio playsinline controls src="${takeURL}">
</audio>${button("delete-take", "Xóa bản ghi và thử lại")}` : ""}${(captured || showText) && modelAllowed ? `${playerHTML("model", [id], { label: "Nghe mẫu để đối chiếu" })}<p class="target">${escape(pack.cues[id].english)}</p>
<p>${escape(pack.cues[id].vietnamese)}</p>
${captured ? `<form id="check">
<label>
<input type="checkbox" name="meaning">${type === "G" ? (native ? escape(currentTurn().meaning) : pilot ? "Tôi đã chọn màu nhạt hơn và hỏi lại khách." : gIndex === 0 ? "Tôi đã nói đúng $45." : "Tôi không bịa giá vẽ móng.") : "Tôi đã nói đủ ý chính của câu."}</label>
<label>
<input type="checkbox" name="clear">Tôi nghe hiểu lời mình nói (có thể nghe lại).</label>
<label>
<input type="checkbox" name="other">${type === "G" ? (native ? escape(currentTurn().other) : pilot ? "Tôi dùng câu hỏi và chờ khách xác nhận." : gIndex === 0 ? "Tôi nói giá bằng câu lịch sự." : "Tôi đã xin kiểm tra và nói lịch sự.") : "Tôi nói đủ câu hỏi / lời xác nhận cần có."}</label>${type === "G" && !native && gIndex === 1 ? "<label><input type=\"checkbox\" name=\"invented\">Tôi đã đoán một giá vẽ móng.</label>" : ""}<button class="primary" type="submit">Lưu tự đánh giá</button>
</form>` : ""}` : ""}${done?.length ? `<p class="badge">${escape(done.at(-1).outcome)} · tự đánh giá</p>
<p class="muted">${escape(done.at(-1).evidence)} · ${done.at(-1).assisted ? "Có hỗ trợ" : "Không nhìn câu mẫu"}</p>` : ""}${!captured && !(type === "G" && pack.transfer.require_spoken && !done?.some(a=>a.evidence !== "không có bằng chứng")) && !(type === "E" && attempt === 1) ? button("text-help", "Cần câu mẫu hỗ trợ") : ""}`;
}
function bindCommon() {
    document.querySelectorAll("[data-step]").forEach(el => el.onclick = () => nav(el.dataset.step));
    scene.mount(document.querySelector('.scene'));
    scene.apply();
    document.body.classList.add("in-lesson");
    bind("privacy-link", e => { e.preventDefault(); $("#settings").showModal(); $("#privacy").open = true; });
    bind("recap-toggle", () => {
        if ((state.step === "B" && !(state.b[pack.b[index].id] || []).some(h => h.answer !== null)) || (state.step === "G" && pack.transfer.activity === 'swatch' && !state.gSwatch?.length) || (state.step === "E" && attempt === 2 && !pending && !showText)) return;
        recapOpen = !recapOpen;
        render();
    });
    bind("scene-enlarge", () => {
        const image = $("#enlarge img");
        image.src = `packs/${lessonId}/${pack.scene.full}`;
        image.style.clipPath = pack.ui?.contact_crop ? "inset(0 18.75% 0 0)" : "";
        $("#enlarge").showModal();
    });
    bind("next", () => {
        if (completeStep(state, state.step, pack))
            nav(advance(state.step));
    });
    bind("skip", () => {
        state.skips ||= {};
        state.skips[state.step] = event({ evidence: "không có bằng chứng", explicitSkip: true });
        persist();
        nav(advance(state.step));
    });
}
function answerB(answer) {
    const i = pack.b[index];
    (state.b[i.id] ||= []).push(event({ answer, correct: answer === i.key, assisted: showText || (i.activity === 'swatch' && !heardB.has(i.id)) || cueState(pack.cues[i.id]).assisted || !!state.audioFailed, listening: !showText && (i.activity !== 'swatch' || heardB.has(i.id)) && !!pack.cues[i.id].audio && !state.audioFailed }));
    render();
}
function saveSpeech(id, type, flags) {
    const evidence = pending?.evidence || "không có bằng chứng";
    const assisted = (native && type==='G' && repairReplays>=2) || (type === 'G' && pack.transfer.activity === 'swatch') || (pending?.assisted ?? (showText || (type === "E" && attempt === 1) || !pack.cues[id].audio));
    if (type === 'G' && pack.transfer.activity === 'swatch') {
        flags.meaning = flags.meaning && !!state.gSwatch?.at(-1)?.correct;
    }
    if (native && type==='G') { flags.invented = flags.invented || !!document.querySelector('#unsafe:checked'); if(currentTurn().gate) flags.meaning &&= !!state.nativeGates?.[gIndex]?.correct; }
    if (native && lessonId==='L-S05' && type==='E' && id==='S05_LINH_01' && evidence!=='không có bằng chứng') state.repaired=true;
    const result = event({ ...flags, outcome: outcome({ ...flags, evidence: evidence !== "không có bằng chứng" }, type), evidence, assisted, source: "tự đánh giá", attempt: type === "E" ? attempt : gIndex + 1 });
    const container = type === "E" ? state.e : state.g, key = type === "E" ? `${id}:${attempt}` : gIndex;
    (container[key] ||= []).push(result);
    pending = null;
    disposeTake();
    render();
}
function bindStep() {
    switch (state.step) {
        case "B": {
            if (native) { bindNativeB(); break; }
            if (pack.b[index].activity === 'swatch') {
                pack.b[index].options.forEach((o,n) => bind(`swatch${n}`, () => answerB(o.value)));
                break;
            }
            const i = pack.b[index];
            i.options.forEach((o, n) => bind(`choice${n}`, () => answerB(o)));
            bind("item-skip", () => {
                answerB(null);
                index = (index + 1) % pack.b.length;
                showText = false;
                render();
            });
            bind("item-next", () => {
                index = (index + 1) % pack.b.length;
                showText = false;
                render();
            });
            break;
        }
        case "C":
            pack.c.choices.forEach((_, n) => bind(`choice${n}`, () => {
                state.c.push(event({ answer: n, correct: (pack.c.keys || [pack.c.key]).includes(n) }));
                render();
                players.get("reply")?.toggle();
            }));
            break;
        case "D": {
            const id = pack.teaching[index];
            bind("card-next", () => {
                index = (index + 1) % pack.teaching.length;
                showText = false;
                render();
            });
            break;
        }
        case "E":
            bindSpeech(pack.teaching[index], "E");
            bind("e-next", () => {
                stopMedia();
                if (attempt === 1)
                    attempt = 2;
                else {
                    attempt = 1;
                    index = (index + 1) % pack.teaching.length;
                }
                render();
            });
            break;
        case "F":
            bind("feedback", () => {
                state.f = true;
                render();
            });
            break;
        case "G":
            if (native) { bindNativeG(); break; }
            if (pack.transfer.activity === 'swatch') {
                pack.transfer.options.forEach((o,n) => bind(`swatch${n}`, () => {
                    stopMedia();
                    state.g[0] = [];
                    (state.gSwatch ||= []).push(event({answer:o.value, correct:pack.transfer.keys.includes(o.value)}));
                    pending = null; disposeTake(); render();
                }));
            }
            bindSpeech(pack.transfer.models[gIndex], "G");
            bind("g-next", () => {
                stopMedia();
                gIndex = 1;
                render();
            });
            break;
        case "summary":
            bind("again", () => nav("A"));
            if ($("#confidence")) $("#confidence").onchange = e => {
                state.confidence = e.target.value;
                persist();
            };
            break;
    }
}
function bindSpeech(id, type) {
    bind("text-help", () => {
        showText = true;
        render();
    });
    bind("delete-take", () => {
        disposeTake();
        pending = null;
        render();
    });
    bind("aloud", () => {
        disposeTake();
        pending = { id, evidence: "tự báo cáo, không ghi âm", assisted: showText || (type === "E" && attempt === 1) || !pack.cues[id].audio };
        render();
    });
    bind("speak-skip", () => {
        pending = { id, evidence: "không có bằng chứng", assisted: true };
        saveSpeech(id, type, { meaning: false, clear: false, other: false, invented: false });
    });
    bind("record", () => startRecording(id, type));
    bind("stop", () => recorder?.state === "recording" && recorder.stop());
    const form = $("#check");
    if (form)
        form.onsubmit = e => {
            e.preventDefault();
            const f = new FormData(form);
            saveSpeech(id, type, { meaning: f.has("meaning"), clear: f.has("clear"), other: f.has("other"), invented: f.has("invented") });
        };
}
async function startRecording(id, type) {
    if (busy)
        return;
    for (const player of players.values())
        player.stop();
    disposeTake();
    pending = null;
    micError = "";
    try {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
            throw Error("unavailable");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = e => {
            if (e.data.size)
                chunks.push(e.data);
        };
        recorder.onstop = () => {
            stream?.getTracks().forEach(t => t.stop());
            stream = null;
            clearTimeout(recordTimer);
            clearInterval(timerTick);
            busy = false;
            scene.recording = false; scene.apply();
            take = new Blob(chunks, { type: recorder.mimeType });
            if (!take.size) {
                micError = "Bản ghi trống: không có bằng chứng. Hãy thử lại hoặc tự báo cáo.";
            }
            else {
                takeURL = URL.createObjectURL(take);
                pending = { id, evidence: "đã ghi âm trên máy", assisted: showText || (type === "E" && attempt === 1) || !pack.cues[id].audio };
            }
            render();
        };
        recorder.onerror = () => {
            stopMedia();
            micError = "Ghi âm bị gián đoạn: không có bằng chứng. Bạn có thể thử lại hoặc nói thành tiếng.";
            render();
        };
        recorder.start();
        busy = true;
        scene.recording = true; scene.apply();
        $("#record").disabled = true;
        $("#stop").disabled = false;
        $("#aloud").disabled = true;
        $("#speak-skip").disabled = true;
        const started = Date.now();
        timerTick = setInterval(() => {
            $("#timer").textContent = `Đang ghi · ${Math.floor((Date.now() - started) / 1000)} giây · Tự dừng ở 60 giây, có thể thử lại.`;
        }, 250);
        recordTimer = setTimeout(() => {
            if (recorder?.state === "recording")
                recorder.stop();
        }, 60000);
    }
    catch {
        stream?.getTracks().forEach(t => t.stop());
        busy = false;
        micError = "Không mở được micro hoặc bạn chưa cho phép. Hãy nói thành tiếng rồi tự báo cáo, hoặc bỏ qua — không có bằng chứng ghi âm.";
        render();
    }
}
window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    installPrompt = e;
    if (location.hash === "#home" || !location.hash)
        renderHome();
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        for (const player of players.values())
            player.stop();
        const was = busy;
        if (was)
            stopMedia();
        if (was) {
            micError = "Đã dừng khi ứng dụng ra nền. Hãy bắt đầu lượt mới.";
            render();
        }
    }
});
window.addEventListener("pagehide", stopMedia);
window.addEventListener("hashchange", () => {
    const requested = location.hash.slice(1).split("/")[0];
    if (catalog.some(p => p.id === requested) && requested !== lessonId) { stopMedia(); location.reload(); return; }
    const route = location.hash.split("/")[1];
    if (STEPS.includes(route)) {
        if (state.step !== route) {
            stopMedia();
            state.step = route;
            index = 0;
            attempt = 1;
            gIndex = 0;
        }
        render();
    }
    else
        renderHome();
});
bind("settings-open", () => $("#settings").showModal());
bind("settings-close", () => $("#settings").close());
bind("lipsync-toggle", () => scene.setLipEnabled(!scene.lipEnabled));
bind("motion-toggle", () => scene.setEnabled(!scene.enabled));
scene.apply();
bind("close-scene", () => $("#enlarge").close());
bind("erase", async () => {
    if (confirm("Xóa toàn bộ tiến độ, tự đánh giá, bản ghi và dữ liệu offline của NailTalk trên thiết bị này?")) {
        stopMedia();
        await store.clear();
        scene.reset();
        await workerMessage("CLEAR");
        state = initialState();
        packAvailable = false;
        location.hash = "home";
        renderHome();
        $("#offline").textContent = "Đã xóa dữ liệu. Tải lại bài để dùng offline.";
    }
});
bind("remove-pack", async () => {
    await workerMessage("REMOVE_PACK");
    packAvailable = false;
    location.hash = "home";
    renderHome();
    $("#offline").textContent = "Đã gỡ bài offline; tiến độ được giữ.";
});
bind("download", async () => {
    try {
        $("#offline").textContent = "Đang tải lại nội dung…";
        if (!await navigator.serviceWorker?.getRegistration()) {
            const reg = await navigator.serviceWorker.register("./sw.js", { type: "module" });
            const installing = reg.installing || reg.waiting;
            if (installing && installing.state !== "activated")
                await new Promise((resolve, reject) => {
                    installing.addEventListener("statechange", () => {
                        if (installing.state === "activated")
                            resolve();
                        if (installing.state === "redundant")
                            reject(Error("Cài offline chưa xong"));
                    });
                });
        }
        await workerMessage("INSTALL_PACK");
        await checkOffline();
    }
    catch (error) {
        console.info("NailTalk offline retry: " + error.message);
        $("#offline").textContent = "Chưa tải xong. Thử lại khi máy chủ cục bộ đang chạy.";
    }
});
async function workerMessage(type) {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg?.active)
        throw Error("No service worker");
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel(), timeout = setTimeout(() => reject(Error("timeout")), 15000);
        channel.port1.onmessage = e => {
            clearTimeout(timeout);
            e.data.error ? reject(Error(e.data.error)) : resolve(e.data);
        };
        reg.active.postMessage({ type, format }, [channel.port2]);
    });
}
async function checkOffline() {
    try {
        await workerMessage("SELECT_FORMAT");
        const ready = await workerMessage("CHECK");
        packAvailable = ready.ready;
        if (location.hash === "#home" || !location.hash)
            renderHome();
        $("#offline").textContent = ready.ready ? `Sẵn sàng offline · ${Object.values(pack.cues).filter(c => c.audio).length}/${Object.keys(pack.cues).length} audio` : "Chưa sẵn sàng offline · Tải lại bài";
    }
    catch {
        $("#offline").textContent = "Chưa kiểm tra được offline.";
    }
}
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { type: "module" }).then(async () => {
        await navigator.serviceWorker.ready;
        await checkOffline();
        console.info("NailTalk: service worker registered; manifest linked");
    }).catch(() => {
        $("#offline").textContent = "Offline chưa khả dụng. Cần HTTPS hoặc localhost.";
    });
}
else
    $("#offline").textContent = "Offline cần HTTPS hoặc localhost.";
const route = location.hash.split("/")[1];
if (STEPS.includes(route))
    state.step = route;
render();
persist();
