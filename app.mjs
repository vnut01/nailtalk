import { CinematicScene } from "./cinematic.mjs";
import { audioFormat } from "./media.mjs";
import { AudioPlayer, listenCount } from "./player.mjs";
import { STEPS, nextStep, cueState, initialState, completeStep, summarize, outcome } from "./logic.mjs";
import * as store from "./storage.mjs";
const $ = s => document.querySelector(s), pack = await (await fetch("./packs/L-S07/pack.json")).json();
export const scene = new CinematicScene(pack);
const format = audioFormat(type => document.createElement("audio").canPlayType(type));
let state = await store.load() || initialState(), index = 0, attempt = 1, gIndex = 0, recorder = null, stream = null, recordTimer = null, timerTick = null, take = null, takeURL = null, pending = null, showText = false, micError = "", busy = false, installPrompt = null, packAvailable = true;
// Cue identities/rubric are unchanged from v002–v004; retain existing evidence.
if (['APP_PROTO_v002_DRAFT', 'APP_PROTO_v003_DRAFT', 'APP_PROTO_v004_DRAFT', 'APP_PROTO_v005_DRAFT'].includes(state.pack)) state.pack = pack.pack_version;
if (state.pack !== pack.pack_version)
    state = initialState();
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
    await store.save(state);
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
    index = 0;
    attempt = 1;
    gIndex = 0;
    micError = "";
    location.hash = `L-S07/${step}`;
    render();
}
function cueHTML(id, reveal = false) {
    const c = pack.cues[id];
    return `${!c.audio ? "<p class=\"warning\">Audio sắp có · Luyện tập có hỗ trợ; không chấm nghe.</p>" : ""}${reveal || !c.audio ? `<p class="target">${escape(c.english)}</p>${c.vietnamese ? `<p>${escape(c.vietnamese)}</p>` : ""}` : ""}`;
}
// Retain transport position while support text/recap re-renders; dispose on navigation.
const players = new Map(), playerConfigs = new Map();
let recapOpen = false;
function playerHTML(key, ids, options = {}) {
    if (ids.some(id => !pack.cues[id].audio))
        return "<p class=\"warning\">Audio sắp có</p>";
    playerConfigs.set(key, { ids, options });
    return `<div class="${options.compact && ids.length === 1 ? "audio-cue" : "audio-player"}" data-player="${key}">
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
            const player = new AudioPlayer(ids.map(id => pack.cues[id]), {
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
function highlightTranscript(player) {
    document.querySelectorAll("[data-line]").forEach(el => {
        const current = Number(el.dataset.line) === player.index;
        el.classList.toggle("current-line", current && player.active);
        if (current && el.parentElement.classList.contains("transcript-lines"))
            el.parentElement.scrollTop = el.offsetTop;
        el.setAttribute("aria-current", String(current && player.active));
    });
}
function recapHTML() {
    const recap = pack.recap;
    const phrase = (item, key) => `<article>
<div class="cue-row"><p class="target">${escape(item.english)}</p>${playerHTML(key, [item.cue], { compact: true, label: item.english })}</div>${item.vietnamese ? `<p>${escape(item.vietnamese)}</p>` : ""}${item.aid ? `<p class="muted">Gợi ý phát âm: ${pronunciationHTML(item.aid)}</p>` : ""}</article>`;
    return `<section class="recap" aria-label="Tóm tắt nhanh">
<h2>Tóm tắt nhanh</h2>${state.step === "A" && state.aFull ? "<p>Bạn vừa nghe: các câu chính</p>" : ""}${recap.teaching.map((item, i) => phrase(item, `recap-${i}`)).join("")}<h3>Các con số về giá</h3>
<p>${escape(recap.stress)}</p><ul class="price-words">${recap.prices.map((item, i) => `<li class="cue-row">
<span>${escape(item.english)}</span>${playerHTML(`recap-price-${i}`, [item.cue], { compact: true, label: item.english })}</li>`).join("")}</ul><h3>Price List · giá minh họa</h3>
<ul class="price-board">${recap.board.map(line => `<li>${escape(line)}</li>`).join("")}</ul>
<h3>${escape(pack.transfer.unknown_card)}</h3>${phrase(recap.manager, "recap-manager")}</section>`;
}
function shell(content) {
    return `<p class="eyebrow">L-S07 · Nói giá · khoảng ${pack.estimated_minutes} phút</p>
<h1>${titles[state.step]}</h1>
<div class="steps" role="group" aria-label="Bước ${Math.min(7, STEPS.indexOf(state.step) + 1)}/7">${STEPS.slice(0, 7).map(s => `<span class="${s === state.step ? "current" : state.visited.includes(s) ? "done" : ""}" ${s === state.step ? "aria-current=\"step\"" : ""}>${s}${state.visited.includes(s) && s !== state.step ? " ✓" : ""}</span>`).join("")}</div>
<div class="player">
<aside>
<div class="scene">
<button id="scene-enlarge" aria-label="Phóng to toàn cảnh">
<span class="scene-layers" aria-hidden="true"></span>
<img src="packs/L-S07/scene-960.webp" alt="Linh và Mark tại quầy; bảng giá trên tường">
</button>
<span class="speaker-tag" aria-hidden="true">Linh và Mark</span>
<small>Chạm để xem toàn cảnh · Giá hư cấu để học</small>
</div>
<p class="muted">${state.step === "G" ? "Dùng thông tin trên thẻ để trả lời." : "Học từng bước, có thể thử lại hoặc bỏ qua."}</p>
</aside>
<section class="panel">${content}${recapOpen && state.step !== "summary" ? recapHTML() : ""}${micError ? `<p class="warning" role="status">${escape(micError)}</p>` : ""}${navigation()}</section>
</div>`;
}
function navigation() {
    const s = state.step;
    if (s === "summary")
        return button("home", "Về trang chủ");
    return `<div class="nav">${button("next", s === "G" ? "Xem kết quả" : "Tiếp tục →", "primary", !completeStep(state, s, pack))}${button("recap-toggle", "Tóm tắt")}${button("skip", "Bỏ qua bước")}${button("home", "Trang chủ")}</div>`;
}
function renderHome() {
    stopMedia();
    scene.mount(null);
    $("#app").innerHTML = `<section class="intro">
<p class="eyebrow">Bella Nails · Tiếng Anh dùng tại tiệm</p>
<h1>Từng câu nhỏ.<br>Tự tin hơn mỗi ngày.</h1>
<div class="hero-line">
</div>
<p>Luyện nghe, chọn câu và nói cùng Linh. Bắt đầu từ một tình huống quen thuộc.</p>
<span class="badge">Bản thử nghiệm · Chỉ L-S07 mở để học</span>
</section>
<div class="lessons">${homeTitles.map((title, i) => `<article class="lesson ${i === 6 ? "active" : ""}">
<span class="eyebrow">L-S0${i + 1} · ${i === 6 ? pack.estimated_minutes + " phút" : "Sắp có"}</span>
<h2>${title}</h2>
<p class="muted">${canDos[i]}</p>${i === 6 ? `<small>${!packAvailable ? "<p class=\"warning\">Bài chưa sẵn sàng offline. Chọn Tải lại bài bên dưới.</p>" : ""}${(pack.files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(2)} MiB nội dung · ${Object.values(pack.cues).filter(c => c.audio).length}/${Object.keys(pack.cues).length} audio</small>
<span class="badge">${state.visited.length ? `${state.visited.length}/7 bước đã ghé` : "Chưa bắt đầu"}</span>
<div class="controls">${button("start", state.visited.length ? "Học tiếp" : "Bắt đầu học", "primary", !packAvailable)}${state.visited.length ? button("restart", "Học lại") : ""}</div>` : "<span class=\"badge\">Sắp có</span>"}</article>`).join("")}</div>
<p class="warning">Bản DRAFT: audio bài học đã có. Kết quả nói là tự đánh giá; kết quả nghe có hỗ trợ được tách riêng.</p>${button("install", "Cài lên màn hình chính", "", !installPrompt)}<p class="muted">Cài đặt và ghi âm cần ngữ cảnh an toàn (HTTPS hoặc localhost). Trên điện thoại qua LAN HTTP vẫn xem và luyện tự báo cáo được.</p>`;
    bind("start", () => nav(state.step === "summary" ? "summary" : state.step));
    bind("restart", async () => {
        if (confirm("Học lại sẽ xóa tiến độ L-S07 trên thiết bị này.")) {
            state = { ...initialState(), volumeHintDismissed: state.volumeHintDismissed };
            await persist();
            nav("A");
        }
    });
    bind("install", async () => {
        await installPrompt?.prompt();
        installPrompt = null;
        renderHome();
    });
}
function render() {
    if (!location.hash || location.hash === "#home") {
        renderHome();
        return;
    }
    if (state.step !== "summary" && !state.visited.includes(state.step))
        state.visited.push(state.step);
    playerConfigs.clear();
    let content = "";
    switch (state.step) {
        case "A":
            content = `<h2>Ở quầy cùng Linh và Mark</h2>
<p>Nghe trọn tình huống một lần, rồi nghe lại thêm một lần nếu muốn.</p>
<p class="task-count">Đã mở ${state.a}/2 lượt</p>${!state.volumeHintDismissed ? `<div class="warning">Bật âm lượng điện thoại · Tắt chế độ im lặng · Nhấn ▶ để bắt đầu nghe ${button("dismiss-hint", "Đã hiểu")}</div>` : ""}${playerHTML("hear", pack.dialogue, { label: "Nghe tình huống", allowed: () => state.a < 2, onBegin: () => {
                    state.a = listenCount(state.a, "begin");
                    persist();
                    const count = $(".task-count");
                    if (count)
                        count.textContent = `Đã mở ${state.a}/2 lượt`;
                }, onFinish: () => {
                    state.aFull = true;
                    recapOpen = true;
                    persist();
                    render();
                }, onUpdate: highlightTranscript })}${pack.dialogue.some(id => !pack.cues[id].audio) || showText ? `<details open>
<summary>Văn bản hỗ trợ</summary>
<div class="transcript-lines">${pack.dialogue.map((id, i) => `<div class="transcript-line" data-line="${i}">
<strong>${escape(pack.cues[id].speaker)}</strong>${cueHTML(id, true)}</div>`).join("")}</div></details>` : button("captions", "Xem văn bản hỗ trợ")}`;
            break;
        case "B": {
            const item = pack.b[index], history = state.b[item.id] || [];
            content = `<p class="task-count">Câu ${index + 1}/${pack.b.length} · Nhận biết, không phải nói</p>
<h2>Bạn nghe thấy giá nào?</h2>${cueHTML(item.id, showText)}<div class="controls">${playerHTML("hear", [item.id], { onFinish: () => {
                    heardB.add(item.id);
                    render();
                } })}${pack.cues[item.id].audio ? button("captions", "Xem chữ hỗ trợ") : ""}</div>
<div class="options">${item.options.map((o, i) => button(`choice${i}`, `${o} dollars`, "", !!pack.cues[item.id].audio && !showText && !heardB.has(item.id))).join("")}</div>${history.length ? `<p role="status">${history.at(-1).answer === null ? "Đã bỏ qua câu này." : history.at(-1).correct ? "Đúng con số." : "Thử nghe lại và so sánh hai số nhé."} ${history.at(-1).assisted ? "Có hỗ trợ · không chấm nghe." : ""}</p>
<p class="muted">Giữ câu trả lời đầu và ${Math.max(0, history.length - 1)} lần thử lại.</p>` : ""}<div class="controls">${button("item-next", index === pack.b.length - 1 ? "Về câu đầu" : "Câu tiếp", "", !history.length)}${button("item-skip", "Bỏ qua câu này")}</div>`;
            break;
        }
        case "C":
            content = `<h2>Khách hỏi lại: “Thirteen?”</h2>
<p>Chọn câu giúp làm rõ con số.</p>
<div class="options">${pack.c.choices.map((c, i) => button(`choice${i}`, `${escape(c)}${pack.c.notes[i] ? "<small> (lặp lại như cũ, to hơn)</small>" : ""}`)).join("")}</div>${state.c.length ? `<p role="status">${escape(pack.c.explanations[state.c.at(-1).answer])}</p>
<p class="muted">Đây là kết quả chọn câu; chưa phải bằng chứng nói.</p>` : ""}`;
            break;
        case "D": {
            const id = pack.teaching[index], c = pack.cues[id], revealed = state.d[id];
            content = `<p class="task-count">Thẻ mẫu ${index + 1}/3 · Không chấm điểm</p>
<h2>Nghe trước, đọc sau</h2>
<div class="controls">${playerHTML("hear", [id], { slower: true, onFinish: () => {
                    state.d[id] = event({ played: true, assisted: false });
                    render();
                } })}</div>${revealed || !c.audio ? `${cueHTML(id, true)}<p class="muted">Gợi ý phát âm: ${pronunciationHTML(c.aid)}</p>` : "<p>Câu tiếng Anh và nghĩa sẽ mở sau lượt nghe đầu.</p>"}${button("card-next", "Thẻ mẫu tiếp", "", !revealed)}<hr>
<h3>Nghe để nhận ra trọng âm</h3>
<p>Âm nào nhấn ở cuối? Không chấm điểm.</p>${playerHTML("contrast", ["S07_B_01", "S07_LINH_01"], { label: "Nghe cặp tương phản", onFinish: () => {
                    showText = true;
                    render();
                } })}${showText ? `<p>${escape(pack.cues.S07_B_01.english)} / ${escape(pack.cues.S07_LINH_01.english)}</p>
<p>${escape(pack.feedback[1])}</p>` : ""}`;
            break;
        }
        case "E": {
            const id = pack.teaching[index];
            content = `<p class="task-count">Câu ${index + 1}/3 · Lượt ${attempt}/2 · tự đánh giá</p>
<h2>${attempt === 1 ? "Nói với câu mẫu hỗ trợ" : "Thử nói khi không nhìn câu mẫu"}</h2>${attempt === 1 || showText ? `<p>${escape(pack.cues[id].vietnamese)}</p>` : `<p>Bạn là Linh. Khách hỏi: ${escape(pack.cues[["S07_MARK_01", "S07_MARK_02", "S07_MARK_03"][index]].english)}</p>`}${attempt === 1 || showText ? `<p class="target">${escape(pack.cues[id].english)}</p>` : "<p class=\"badge\">Câu mẫu đã ẩn ở lượt 2</p>"}${speechUI(id, "E")}<div class="controls">${button("e-next", attempt === 1 ? "Lượt 2 · ẩn câu mẫu" : "Câu tiếp", "", !state.e[`${id}:${attempt}`]?.length)}</div>`;
            break;
        }
        case "F":
            content = `<h2>Ý nghĩa trước, rõ lời sau</h2>
<p class="badge">tự đánh giá</p>
<p>${escape(pack.feedback[0])} <small>— khi bạn tự kiểm tra và thấy khách hiểu đúng giá.</small>
</p>
<p>Bạn có nghe rõ con số trong bản ghi của mình không?</p>
<p>${escape(pack.feedback[1])}</p>
<p class="muted">Đọc từng chữ số là cách sửa hiểu nhầm trong tình huống này.</p>${button("feedback", "Đã xem phản hồi", "primary")}`;
            break;
        case "G": {
            const id = pack.transfer.models[gIndex], prompt = pack.transfer.prompts[gIndex];
            content = `<p class="task-count">Tình huống ${gIndex + 1}/2 · tự đánh giá</p>
<h2>${gIndex === 0 ? "Khách chọn dịch vụ khác" : "Khách hỏi thêm"}</h2>${cueHTML(prompt)}${playerHTML("prompt", [prompt], { label: "Nghe khách hỏi" })}<div class="price" aria-label="Thẻ thông tin tình huống">${escape(gIndex === 0 ? pack.transfer.price_card : pack.transfer.unknown_card)}</div>
<p>${gIndex === 0 ? "Nhìn thẻ, rồi nói giá cho khách." : "Bạn chưa biết giá vẽ móng. Nói để xin kiểm tra."}</p>${speechUI(id, "G")}${gIndex === 0 ? button("g-next", "Khách hỏi tiếp", "", !state.g[0]?.length) : "<p class=\"muted\">Không đoán giá vẽ móng.</p>"}`;
            break;
        }
        case "summary": {
            const s = summarize(state, pack);
            content = `${recapHTML()}<h2>${s.completed ? "Đã hoàn thành các bước" : "Bạn có thể quay lại luyện tiếp"}</h2>
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
<p class="muted">Lần đầu: ${s.G.firstOutcome}. Không gộp với E hay chọn đáp án.</p>` : ""}${Object.entries(s[k].attempts).map(([id, list]) => `<p>${escape(id)}: ${escape(list.at(-1).outcome)}<br>
<small>${escape(list.at(-1).evidence)} · ${list.at(-1).assisted ? "Có hỗ trợ" : "Không nhìn câu mẫu"} · ${list.length} lần thử</small>
</p>`).join("") || "<p>Không có bằng chứng · đã bỏ qua</p>"}</article>`).join("")}</div>
<label>Tự tin sau bài học <select id="confidence">
<option value="">Chưa chọn</option>${[1, 2, 3, 4, 5].map(n => `<option ${state.confidence === String(n) ? "selected" : ""}>${n}</option>`).join("")}</select>
</label>
<details>
<summary>Xem lịch sử và dữ liệu riêng trên máy</summary>
<pre>${escape(JSON.stringify(s, null, 2))}</pre>
</details>
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
function speechUI(id, type) {
    const done = type === "E" ? state.e[`${id}:${attempt}`] : state.g[gIndex];
    const captured = pending?.id === id;
    return `<p class="muted">Micro chỉ dùng để nghe lại trên máy; không tải lên. Bản ghi tự xóa khi rời bước, thử lại hoặc đóng bài. Có thể nói thành tiếng hoặc bỏ qua.</p>${!pack.cues[id].audio ? "<p class=\"warning\">Audio sắp có · Luyện có hỗ trợ.</p>" : ""}<div class="controls">${button("record", "Ghi âm", "primary", busy)}${button("stop", "Dừng", "", !busy)}${button("aloud", "Tôi đã nói thành tiếng (không ghi âm)", "", busy)}${button("speak-skip", "Bỏ qua lượt này", "", busy)}</div>
<p id="timer" class="recording" role="status">
</p>${takeURL ? `<p>Nghe bản của bạn:</p>
<audio playsinline controls src="${takeURL}">
</audio>${button("delete-take", "Xóa bản ghi và thử lại")}` : ""}${captured ? `${playerHTML("model", [id], { label: "Nghe mẫu để đối chiếu" })}<p class="target">${escape(pack.cues[id].english)}</p>
<p>${escape(pack.cues[id].vietnamese)}</p>
<form id="check">
<label>
<input type="checkbox" name="meaning">${type === "G" ? (gIndex === 0 ? "Tôi đã nói đúng $45." : "Tôi không bịa giá vẽ móng.") : "Tôi đã nói đủ ý chính của câu."}</label>
<label>
<input type="checkbox" name="clear">Tôi nghe hiểu lời mình nói (có thể nghe lại).</label>
<label>
<input type="checkbox" name="other">${type === "G" ? (gIndex === 0 ? "Tôi nói giá bằng câu lịch sự." : "Tôi đã xin kiểm tra và nói lịch sự.") : "Tôi nói đủ câu hỏi / lời xác nhận cần có."}</label>${type === "G" && gIndex === 1 ? "<label><input type=\"checkbox\" name=\"invented\">Tôi đã đoán một giá vẽ móng.</label>" : ""}<button class="primary" type="submit">Lưu tự đánh giá</button>
</form>` : ""}${done?.length ? `<p class="badge">${escape(done.at(-1).outcome)} · tự đánh giá</p>
<p class="muted">${escape(done.at(-1).evidence)} · ${done.at(-1).assisted ? "Có hỗ trợ" : "Không nhìn câu mẫu"}</p>` : ""}${!captured && !(type === "E" && attempt === 1) ? button("text-help", "Cần câu mẫu hỗ trợ") : ""}`;
}
function bindCommon() {
    scene.mount(document.querySelector('.scene'));
    scene.apply();
    bind("recap-toggle", () => {
        recapOpen = !recapOpen;
        render();
    });
    bind("dismiss-hint", () => {
        state.volumeHintDismissed = true;
        persist();
        render();
    });
    bind("scene-enlarge", () => {
        const image = $("#enlarge img");
        image.src = image.dataset.src;
        $("#enlarge").showModal();
    });
    bind("home", () => {
        stopMedia();
        location.hash = "home";
        renderHome();
    });
    bind("next", () => {
        if (completeStep(state, state.step, pack))
            nav(nextStep(state.step));
    });
    bind("skip", () => {
        state.skips ||= {};
        state.skips[state.step] = event({ evidence: "không có bằng chứng", explicitSkip: true });
        persist();
        nav(nextStep(state.step));
    });
}
function answerB(answer) {
    const i = pack.b[index];
    (state.b[i.id] ||= []).push(event({ answer, correct: answer === i.key, assisted: showText || cueState(pack.cues[i.id]).assisted || !!state.audioFailed, listening: !showText && !!pack.cues[i.id].audio && !state.audioFailed }));
    render();
}
function saveSpeech(id, type, flags) {
    const evidence = pending?.evidence || "không có bằng chứng";
    const assisted = pending?.assisted ?? (showText || (type === "E" && attempt === 1) || !pack.cues[id].audio);
    const result = event({ ...flags, outcome: outcome({ ...flags, evidence: evidence !== "không có bằng chứng" }, type), evidence, assisted, source: "tự đánh giá", attempt: type === "E" ? attempt : gIndex + 1 });
    const container = type === "E" ? state.e : state.g, key = type === "E" ? `${id}:${attempt}` : gIndex;
    (container[key] ||= []).push(result);
    pending = null;
    disposeTake();
    render();
}
function bindStep() {
    bind("captions", () => {
        showText = true;
        render();
    });
    switch (state.step) {
        case "B": {
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
                state.c.push(event({ answer: n, correct: n === pack.c.key }));
                render();
            }));
            break;
        case "D": {
            const id = pack.teaching[index];
            bind("card-next", () => {
                index = (index + 1) % 3;
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
                    index = (index + 1) % 3;
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
            bindSpeech(pack.transfer.models[gIndex], "G");
            bind("g-next", () => {
                stopMedia();
                gIndex = 1;
                render();
            });
            break;
        case "summary":
            bind("again", () => nav("A"));
            $("#confidence").onchange = e => {
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
