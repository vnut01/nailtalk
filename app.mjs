export const APP_VERSION = "v029-DRAFT-1";
import { subtitleCue } from "./parts.mjs";
import { CinematicScene } from "./cinematic.mjs";
import { audioFormat } from "./media.mjs";
import { AudioPlayer, speakerIcon } from "./player.mjs";
import { createAudioContext, openCapture } from "./capture.mjs";
import { scorerReady, loadScorer, transcribe, forgetScorer, SCORER_MB } from "./scorer.mjs";
import { STEPS, nextStep, initialState, completeStep, outcome, normalizeState, bestSpeechScore, scoreStars } from "./logic.mjs";
import { guideFor, LEGEND } from "./pronounce.mjs";
import * as store from "./storage.mjs";
const $ = s => document.querySelector(s);
import {LESSON_ORDER, AVAILABLE_LESSONS, migrateProgress, practiced, reachedPhrases, lessonStatus, continueLesson} from './path.mjs';
const content = await (await fetch('./lesson-content.json')).json();
const progress = Object.fromEntries(await Promise.all(LESSON_ORDER.map(async id=>[id,migrateProgress(await store.load(id),id)])));
const catalog = await (await fetch('./catalog.json')).json();
const onHome = !location.hash || location.hash === '#home' || location.hash === '#phrases';
// Give a newly opened lesson the network before fetching its manifest or art.
if (!onHome) navigator.serviceWorker?.controller?.postMessage({type:'PAUSE'});
const lessonId = catalog.some(p => p.id === location.hash.slice(1).split('/')[0]) ? location.hash.slice(1).split('/')[0] : 'L-S07';
// New text travels inside its pack; a first-time Lesson 1 loads only the original content.
await Promise.all(AVAILABLE_LESSONS.filter(id=>!content[id]&&(!onHome&&id===lessonId||progress[id]?.visited?.length)).map(async id=>{content[id]=await(await fetch(`./packs/${id}/lesson-content.json`)).json();}));
for(const p of catalog)content[p.id]||={homeCanDo:p.homeCanDo,cards:[]};
const pack = onHome ? {...catalog.find(p => p.id === lessonId), cues:{}} : await (await fetch(`./packs/${lessonId}/pack.json`)).json();
const lesson = content[lessonId];
const extraPacks = {};
for(const id of AVAILABLE_LESSONS.filter(id=>reachedPhrases(progress[id])||!onHome&&id===lesson.review?.lesson))extraPacks[id]=await (await fetch(`./packs/${id}/pack.json`)).json();
let reviewing=!onHome && !!lesson.review && (!progress[lessonId].reviewDone && progress[lessonId].step==='1' && (!location.hash.includes('/')||location.hash.endsWith('/1')) || location.hash.endsWith('/review'));
let meaningOn=localStorage.getItem('nailtalk-meaning')==='true', subtitleLast=null;
// Batch91 (NTE-DEC-085): the speaking score runs on the device (Whisper tiny.en in a worker). The browser's
// cloud recognizer is no longer used: it fought the recorder for the microphone on iPhone and sent speech away.
const asrAvailable=typeof Worker!=='undefined'&&typeof WebAssembly!=='undefined';
let micDiag=null;
let scoringOn=localStorage.getItem('nailtalk-scoring')!=='false', asrBroken=false;
const enabled = step => STEPS.includes(step);
const advance = step => { let next = nextStep(step); while(next !== 'summary' && !enabled(next)) next = nextStep(next); return next; };
export const scene = new CinematicScene(pack);
const format = audioFormat(type => document.createElement("audio").canPlayType(type));
let state = await store.load(lessonId) || initialState(), index = 0, attempt = 1, gIndex = 0, recorder = null, stream = null, recordTimer = null, timerTick = null, take = null, takeURL = null, pending = null, showText = false, micError = "", busy = false, installPrompt = null, packAvailable = true;
state = migrateProgress(state,lessonId);
state.pack = pack.pack_version;
const titles = {'1':'Nghe chuyện','2':'Nghe lại có phụ đề','3':'Nghe hiểu','4':'Câu và từ','5':'Nói lại','6':'Vận dụng',summary:'Tổng kết'};
const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const pronunciationHTML = s => escape(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
const button = (id, text, cls = "", disabled = false) => `<button id="${id}" class="${cls}" ${disabled ? "disabled" : ""}>${text}</button>`;
function bind(id, fn) {
    const el = document.getElementById(id);
    if (el)
        el.onclick = fn;
}
async function persist() {
    state.positions ||= {};
    state.positions[state.step] = {index, attempt, gIndex};
    state.updatedAt=new Date().toISOString();
    progress[lessonId]=state;
    await store.save(state, lessonId);
    $("#storage").textContent = `Lưu tiến độ: ${store.storageMode === 'Không lưu được' ? 'Chưa lưu được' : 'Trên thiết bị'}. Xóa dữ liệu trình duyệt có thể làm mất tiến độ.`;
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
// iPhone: asking for the microphone again after stopping it gives a silent stream (owner report, Batch 89),
// so one microphone stream is kept for the whole lesson and released only when leaving it or going to background.
function releaseMic() {
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
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
    reviewing=false;
    state.step = step;
    index = state.positions?.[step]?.index || 0;
    attempt = state.positions?.[step]?.attempt || 1;
    gIndex = state.positions?.[step]?.gIndex || 0;
    micError = "";
    location.hash = `${lessonId}/${step}`;
    render();
}
// A finished part reopens at its first item.
function finishPart(next) {
    (state.positions ||= {})[state.step] = {index:0, attempt:1, gIndex:0};
    nav(next);
}
function cueHTML(id, reveal = false) {
    const c = pack.cues[id];
    return `${!c.audio ? "<p class=\"warning\">Âm thanh sắp có · Luyện tập có hỗ trợ; không chấm nghe.</p>" : ""}${reveal || !c.audio ? `<p class="target">${escape(c.english)}</p>${reveal ? guideHTML(c.english) : ""}${c.vietnamese ? `<p>${escape(c.vietnamese)}</p>` : ""}` : ""}`;
}
// Retain transport position while support text/recap re-renders; dispose on navigation.
const players = new Map(), playerConfigs = new Map();
let recapOpen = false, scenePlayer = "";
function playerHTML(key, ids, options = {}) {
    ids=ids.filter(Boolean);
    if (!ids.length) return "";
    const source=options.sourcePack||pack;
    if (ids.some(id => !source.cues[id]?.audio))
        return "<p class=\"warning\">Âm thanh sắp có</p>";
    playerConfigs.set(key, { ids, options, source });
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
    for (const [key, { ids, options, source }] of playerConfigs) {
        if (!players.has(key)) {
            const player = new AudioPlayer(ids.map(id => ({...source.cues[id], gap_after_ms: options.gaps?.[id] || 0})), {
                ...options,
                blocked: () => busy,
                onUpdate: player => { options.onUpdate?.(player); scene.update(player); },
                activate: active => {
                    document.querySelectorAll('audio').forEach(audio=>audio.pause());
                    for (const other of players.values())
                        if (other !== active)
                            other.stop();
                },
                onError: () => {
                    micError = "Chưa phát được âm thanh. Bạn thử nghe lại nhé.";
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
function updateSubtitle(player) {
    const el=$('#subtitle');if(!el)return;
    const cue=subtitleCue(player.cues,player.position);
    const active=player.active&&!player.inGap?cue:null;
    if(active)subtitleLast=active;
    el.dataset.cue=active?.id||'';
    el.textContent=active?.english||'';
    $('#subtitle-meaning').textContent=meaningOn&&active?active.vietnamese:'';
    el.onclick=()=>{if(subtitleLast){const n=player.cues.findIndex(c=>c.id===subtitleLast.id);player.replayOnly=true;player.go(n,0,true);}};
}
function shell(content) {
    const crop = pack.scene.phone_crop;
    const sceneStyle = `--phone-scene-width:calc(100cqw * ${pack.geometry.width} / ${crop.width});--phone-scene-left:calc(-100cqw * ${crop.x} / ${crop.width});--phone-scene-top:calc(-100% * ${crop.y} / ${crop.height});--phone-scene-ratio:${crop.width} / ${crop.height}`;
    const hasScene = ['1','2'].includes(state.step);
    return `<section class="step-heading"><h1>Bài ${LESSON_ORDER.indexOf(lessonId)+1} · ${escape(pack.subtitle)}</h1>${state.step==='summary'?'':`<button id="part-menu" class="part-indicator">Phần ${state.step}/6 · ${titles[state.step]} ▾</button><div id="part-list" hidden>${STEPS.slice(0,6).map(n=>`<button data-step="${n}">${n} · ${titles[n]}</button>`).join('')}</div>`}</section>
<div class="player ${hasScene ? '' : 'task-only'} step-${state.step}">${hasScene ? `<aside><div data-lesson="${lessonId}" class="scene scene-main ${pack.ui?.contact_crop ? 'contact-crop' : ''}" style="${sceneStyle}"><div class="scene-frame"><div class="scene-canvas"><span class="scene-layers" aria-hidden="true"></span><img src="packs/${lessonId}/${pack.scene.small}" alt="Cảnh trong tiệm Bella Nails"></div></div>${scenePlayer}</div>${state.step==='1'?`<p class="scene-setter">${escape(lesson.sceneSetter)}</p>`:''}${state.step==='2'?`<button id="subtitle" class="subtitle" aria-label="Nghe lại câu phụ đề"></button><button id="meaning-toggle" aria-pressed="${meaningOn}">Nghĩa tiếng Việt: ${meaningOn?'Bật':'Tắt'}</button><p id="subtitle-meaning" class="subtitle-meaning"></p>`:''}</aside>` : ''}<section class="panel">${content}${micError ? `<p role="status" class="warning">${escape(micError)}</p>` : ''}</section></div>${navigation()}`;
}
function navigation() {
    return state.step==='summary'?'':`<nav class="nav" aria-label="Điều hướng bài học"><div class="nav-actions">${['1','2'].includes(state.step)?button('next','Tiếp tục','primary',!completeStep(state,state.step,lesson)):''}${button('skip',['1','2'].includes(state.step)?'Bỏ qua':'Bỏ qua phần này','text-link')}</div></nav>`;
}
function openLesson(id){if(!AVAILABLE_LESSONS.includes(id))return;const s=progress[id];location.hash=`${id}/${s?.step||'1'}`;if(id===lessonId&&onHome)location.reload();}
function renderHome() {
    stopMedia();releaseMic();playerConfigs.clear();document.body.classList.remove('in-lesson');scene.mount(null);
    const id=continueLesson(progress),total=AVAILABLE_LESSONS.reduce((n,id)=>n+practiced(progress[id],content[id]).length,0);
    const first=!LESSON_ORDER.some(id=>progress[id]?.visited?.length);
    $('#app').innerHTML=`<section class="intro"><h1>Mỗi bài, dùng được ngay</h1><article class="lesson"><h2>Học tiếp</h2><p>${total}/${AVAILABLE_LESSONS.length*4} câu đã luyện nói</p>${button('continue',first?'Bắt đầu Bài 1':`Học tiếp Bài ${LESSON_ORDER.indexOf(id)+1}`,'primary')}</article></section>${button('phrases','Sổ câu của tôi')}<div class="lessons">${LESSON_ORDER.map((id,n)=>{const p=catalog.find(p=>p.id===id);return `<article class="lesson"><span>Bài ${n+1}</span><h2>${escape(p.subtitle)}</h2><small>${escape(p.title)}</small><p>${escape(content[id].homeCanDo)}</p><p>${AVAILABLE_LESSONS.includes(id)?lessonStatus(progress[id],content[id]):'Sắp có'}</p>${button('start-'+id,AVAILABLE_LESSONS.includes(id)?'Mở bài':'Sắp có','',!AVAILABLE_LESSONS.includes(id))}</article>`;}).join('')}</div>${button('install','Cài lên màn hình chính','',!installPrompt)}`;
    bind('continue',()=>openLesson(id));bind('phrases',()=>{location.hash='phrases';});
    for(const id of LESSON_ORDER)bind('start-'+id,()=>openLesson(id));
    bind('install',async()=>{await installPrompt?.prompt();installPrompt=null;renderHome();});
}
async function renderPhrases() {
    stopMedia();releaseMic();playerConfigs.clear();scene.mount(null);document.body.classList.remove('in-lesson');
    const ids=AVAILABLE_LESSONS.filter(id=>reachedPhrases(progress[id]));
    await Promise.all(ids.map(async id=>{extraPacks[id]||=await (await fetch(`./packs/${id}/pack.json`)).json();}));
    $('#app').innerHTML=`<h1>Sổ câu của tôi</h1>${ids.length?ids.map(id=>`<section><h2>Bài ${LESSON_ORDER.indexOf(id)+1} · ${escape(catalog.find(p=>p.id===id).subtitle)}</h2>${content[id].cards.map(c=>`<article class="phrase"><div class="cue-row">${playerHTML('phrase-'+c.cue,[c.cue],{compact:true,sourcePack:extraPacks[id],label:'Nghe câu trong sổ'})}<p class="target">${escape(c.english)}</p></div><p>${escape(c.vietnamese)}</p><p>${escape(c.useWhen)}</p></article>`).join('')}</section>`).join(''):'<p>Học đến phần Câu và từ, câu của bạn sẽ ở đây.</p>'}`;
    mountPlayers();
}
function currentTurn() {
    return lesson.turns[gIndex];
}
function spoken(history) { return history?.some(a=>a.evidence !== 'không có bằng chứng'); }
function modelHTML(ids) { return ids.map(id=>cueHTML(id,true)).join('') + playerHTML('full-model',ids,{label:'Nghe mẫu sau lượt nói'}); }
function renderReview(){
 stopMedia();playerConfigs.clear();scene.mount(null);document.body.classList.add('in-lesson');
 const r=lesson.review,p=extraPacks[r.lesson];
 $('#app').innerHTML=`<section class="review"><h1>Ôn một phút</h1><p>Nghe, nói lại rồi vào bài mới.</p>${r.cues.map((id,n)=>`<article class="phrase">${playerHTML('review-'+n,[id],{compact:true,sourcePack:p,label:'Nghe câu bài trước'})}<p class="target">${escape(p.cues[id].english)}</p><p>${escape(p.cues[id].vietnamese)}</p></article>`).join('')}${button('review-next','Tiếp tục','primary')}${button('review-skip','Bỏ qua','text-link')}</section>`;
 const done=()=>{state.reviewDone=true;nav('1');};bind('review-next',done);bind('review-skip',done);mountPlayers();
}
function render() {
    if(location.hash==='#phrases'){renderPhrases();return;}
    if (!location.hash || location.hash === '#home') { renderHome(); return; }
    if(reviewing){renderReview();return;}
    if (!STEPS.includes(state.step)) state.step='1';
    if(state.step==='summary'&&!completeStep(state,'6',lesson))state.step='6';
    if (!state.visited.includes(state.step)) state.visited.push(state.step);
    playerConfigs.clear(); scenePlayer='';
    let content='';
    const card = lesson.cards[index % 4];
    if (['1','2'].includes(state.step)) {
        const part=state.step;
        scenePlayer=playerHTML('hear',pack.dialogue,{scene:true,slower:true,gaps:pack.scene_gaps,label:'Nghe toàn bộ câu chuyện',onUpdate:updateSubtitle,onFinish:()=>{state.listened[part]=true;persist();render();}});
    } else if (state.step==='3') {
        const q=lesson.comprehension[index % 3], h=state.answers[index] || [];
        content=`<p class="task-count">${index+1}/3</p>${playerHTML('hear',q.listen,{label:'Nghe đoạn câu chuyện',onFinish:()=>{state.heard[index]=true;persist();render();}})}<h2>${escape(q.question)}</h2>${!state.heard[index]?'<p role="status">Nghe xong rồi chọn</p>':''}<div class="options">${q.options.map((o,n)=>button('choice'+n,escape(o),'',!state.heard[index])).join('')}</div>${h.length?`<p role="status">${escape(h.at(-1).correct?q.correct:q.retry)}</p>`:''}${button('item-next',index<2?'Câu tiếp':'Xong · Sang phần 4','primary',!h.length)}`;
    } else if(state.step==='4') {
        content=`<p class="task-count">${"●".repeat(index+1)}${"○".repeat(3-index)}</p>${playerHTML('hear',[card.cue],{label:'Nghe câu mẫu',onFinish:()=>{state.cards[card.cue]=true;persist();render();}})}<p class="target">${escape(card.english)}</p>${guideHTML(card.english)}<p>${escape(card.vietnamese)}</p><p>${escape(card.vocabulary)}</p>${card.note.split(' <br> ').map(line=>`<p>${escape(line)}</p>`).join('')}${card.chunks?`<p>Nghe và nói từng cụm, rồi nói cả câu.</p>${card.chunks.map((id,n)=>`<p>${n+1}. ${escape(pack.cues[id].english)}</p>${playerHTML('chunk-'+n,[id],{compact:true,label:'Nghe từng cụm'})}`).join('')}`:''}`;
        lesson.recognition.forEach((q,n)=>{
            if(index !== q.afterCard)return;
            const h=state.recognition[n];
            content+=`<article><h3>Bạn vừa nghe từ nào?</h3>${playerHTML('mini-'+n,[q.cue],{label:'Nghe nhận biết',onFinish:()=>{(state.miniHeard||={})[n]=true;persist();render();}})}<div class="options">${q.options.map((o,j)=>`<button data-mini="${n}" data-answer="${j}" ${!state.miniHeard?.[n]?'disabled':''}>${escape(o)}</button>`).join('')}</div>${h?`<p role="status">${h.correct?'Đúng rồi, bạn nhận ra ý vừa nghe.':'Nghe lại rồi chọn ý phù hợp nhé.'}</p>`:''}</article>`;
        });
        content+=button('card-next',index<3?'Câu tiếp':'Xong · Sang phần 5','primary');
    } else if(state.step==='5') {
        const done=state.e[`${card.cue}:2`]?.length;
        content=`<p class="task-count">${"●".repeat(index+1)}${"○".repeat(3-index)} · ${attempt===1?'Cùng câu mẫu':'Tự nói'}</p><h2>${attempt===1?'Nói với câu mẫu':'Thử nói khi không nhìn câu mẫu'}</h2>${attempt===1||showText?`${playerHTML('hear',[card.cue],{label:'Nghe câu mẫu'})}<p class="target">${escape(card.english)}</p><p>${escape(card.vietnamese)}</p>${guideHTML(card.english)}`:`<p>${escape(card.focus.replace(/^\d+\. /,''))}</p>`}${speechUI(card.cue,'E')}${done?`<p>${escape(card.check)}</p>`:''}${button('e-next',attempt===1?'Thử tự nói':index<3?'Câu tiếp':lesson.safetyRequired&&!completeStep(state,'5',lesson)?'Ôn an toàn':'Xong · Sang phần 6','primary',!state.e[`${card.cue}:${attempt}`]?.length)}`;
        if(lessonId==='L-S06'&&lesson.cards.every(c=>[1,2].every(n=>state.e[c.cue+':'+n]?.length)))content+=safetyHTML();
    } else if(state.step==='6') {
        const t=currentTurn(), h=state.g[gIndex], said=spoken(h)||pending?.id===t.models[0]&&pending.evidence!=='không có bằng chứng';
        const gate=lessonId==='L-S08'&&!state.water?.correct;
        content=`<p class="task-count">${"●".repeat(gIndex+1)}${"○".repeat(lesson.turns.length-gIndex-1)}</p><h2>${escape(t.instruction)}</h2>${playerHTML('hear',t.prompts,{label:'Nghe yêu cầu mới',onFinish:()=>{(state.transferHeard||={})[gIndex]=true;persist();render();}})}`;
        if(lessonId==='L-S02') content+=`<p>Đang chỉ ô B.</p><div class="options">${['#f4e9d2','#b6dce8','#e8806a','#35678b','#c8acd7','#b9494b'].map((color,n)=>`<button data-color="${n}" aria-pressed="${state.color===n}"><span class="swatch-chip" style="background:${color}"></span>${'ABCDEF'[n]}</button>`).join('')}</div>`;
        if(lessonId==='L-S08')content+=`<h3>Bà đang xin gì?</h3>${['A drink of water','Move the plant','Take the plant back'].map((o,n)=>button('water'+n,o,'',!state.transferHeard?.[gIndex])).join('')}${state.water?`<p>${state.water.correct?'Bạn đã hiểu yêu cầu; hãy nói điều mình sẽ làm.':'Nghe lại yêu cầu mới nhé.'}</p>`:''}`;
        if(lessonId==='L-S08')content+=button('request-repeat','Tôi đã xin nhắc lại')+(state.repeatRequested?playerHTML('repeat-request',['V2_S08_LINH_04'],{label:'Nghe mẫu sau lời xin nhắc lại',onBegin:()=>{state.repeatHelp=true;persist();}}):'');
        if(!gate) content+=speechUI(t.models[0],'G');
        if(said) {
            content+=t.modelText?`<p class="target">${escape(t.modelText)}</p>${guideHTML(t.modelText)}${t.deferAudio?'':playerHTML('full-model',t.models,{label:'Nghe mẫu sau lượt nói'})}`:modelHTML(t.models);
            if(h?.length)content+=`<p>${escape(t.check)}</p><p>${escape(t.retry)}</p>`;
            const confirm=lessonId==='L-S02'?['V2_S02_LINDA_12']:lessonId==='L-S05'?['V2_S05_LINDA_12']:lessonId==='L-S04'?(gIndex===0?['V2_S04_JENNY_02']:gIndex===2?['V2_S04_JENNY_03']:[]):[];
            if(h?.at(-1)?.meaning&&h.at(-1).clear) content+=playerHTML('confirmation',confirm,{label:'Nghe khách xác nhận',onFinish:()=>{(state.confirmed||={})[gIndex]=true;persist();render();}});
            if(lessonId==='L-S08')content+=playerHTML('repair-model',['V2_S08_LINH_06'],{label:'Nghe mẫu xin nhắc lại và xác nhận sau nỗ lực'});
        }
        if(lessonId==='L-S04'&&gIndex===2&&state.confirmed?.[2])content+=button('book','Ghi lịch mô phỏng');
        const canAdvance=!!h?.length&& (lessonId!=='L-S03'||gIndex!==0||h?.some(a=>a.meaning&&a.clear&&a.evidence!=='không có bằng chứng'))&& (lessonId!=='L-S04'||gIndex!==2||!!state.confirmed?.[2]);
        content+=button('g-next',gIndex<lesson.turns.length-1?'Nói tiếp':'Xem kết quả','primary',!canAdvance);
    } else {
        const said=practiced(state,lesson), number=LESSON_ORDER.indexOf(lessonId)+1;
        const heardRight=lesson.comprehension.filter((_,n)=>state.answers[n]?.[0]?.correct).length;
        const best=cue=>Math.max(-1,...[1,2].flatMap(n=>(state.e[cue+':'+n]||[]).map(a=>a.score??-1)));
        const turnsDone=lesson.turns.filter((_,n)=>spoken(state.g[n])).length;
        const scores=[...lesson.cards.map(c=>best(c.cue)),...lesson.turns.map((_,n)=>Math.max(-1,...(state.g[n]||[]).map(a=>a.score??-1)))].filter(v=>v>=0);
        const average=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null;
        const skipped=['3','4','5','6'].filter(n=>state.skips?.[n]);
        const tile=(value,label)=>`<div class="result-tile"><strong>${value}</strong><span>${label}</span></div>`;
        content=`<h2>Bạn đã học xong Bài ${number} 🎉</h2><p>${escape(lesson.homeCanDo)}</p><div class="result-grid">${tile(`${heardRight}/3`,'câu nghe hiểu đúng ngay lần đầu')}${tile(`${said.length}/${lesson.cards.length}`,'câu đã luyện nói')}${tile(`${turnsDone}/${lesson.turns.length}`,'tình huống vận dụng đã nói')}${average===null?'':tile(starText(average),'sao nói trung bình (máy nghe)')}</div>${skipped.length?`<p class="warning">Bạn đã bỏ qua phần ${skipped.join(', ')}. Chọn Luyện lại để học các phần đó.</p>`:''}${said.length?`<h2>Các câu bạn đã nói</h2><div class="end-phrases">${said.map(c=>`<article class="phrase cue-row">${playerHTML('recap-'+c.cue,[c.cue],{compact:true,label:'Nghe câu đã luyện'})}<p class="target">${escape(c.english)}${best(c.cue)>=0?` <span class="score-chip">${starText(best(c.cue))}</span>`:''}</p></article>`).join('')}</div>`:''}<h2>Bạn đã tự nói được chưa?</h2><div class="confidence-choices">${['Tự nói được','Cần nghe mẫu','Muốn luyện lại'].map((o,n)=>button('confidence'+n,o,state.confidence===o?'primary':'')).join('')}</div><div class="end-actions">${button('next-lesson',AVAILABLE_LESSONS.indexOf(lessonId)<AVAILABLE_LESSONS.length-1?'Bài tiếp theo':'Về trang chính','primary')}${button('phrases','Sổ câu của tôi')}${button('again','Luyện lại')}</div>`;
    }
    $('#app').innerHTML=shell(content);
    bindCommon(); mountPlayers(); bindStep(); persist();
}
function speechTarget(id,type) {
    if(type==='E')return lesson.cards[index].english;
    const t=currentTurn();
    return t.modelText||t.models.map(m=>pack.cues[m].english).join(' ');
}
// Scores one take on the device. The first time, the learner chooses to download the model.
async function scoreTake(mine,target) {
    mine.asrPending=true;mine.asrOffer=false;mine.asrProgress=null;
    const refresh=()=>{if(pending===mine&&$('#score-slot'))$('#score-slot').innerHTML=scoreInner();};
    refresh();
    try {
        if(!scorerReady()||!mine.loaded){
            let shown='';
            await loadScorer(p=>{mine.asrProgress=p;const key=p.phase+Math.floor(100*p.loaded/(p.total||1));if(key!==shown){shown=key;refresh();}});
            mine.loaded=true;
        }
        // Whisper writes non-speech as (beep), [MUSIC], *sigh*: drop those before scoring.
        const text=String(await transcribe(mine.samples)).replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g,' ').replace(/\s+/g,' ').trim();
        mine.asr=text?bestSpeechScore(target,[text]):{note:'Máy chưa nghe được câu nào. Thử nói to và rõ hơn nhé.'};
    } catch {
        asrBroken=true; // stop retrying on this device until scoring is switched off and on again
        mine.asr={note:'Máy này chưa chấm điểm được. Bạn nghe lại bản ghi và so với câu mẫu nhé.'};
    }
    mine.asrPending=false;mine.samples=null;mine.asrProgress=null;
    refresh();
}
function scoreInner() {
    const a=pending?.asr;
    if(!a&&pending?.asrOffer)return `<p class="score-note">Chấm điểm nói chạy ngay trên máy, không gởi giọng nói đi đâu. Lần đầu cần tải khoảng ${SCORER_MB} MB (nên dùng Wi-Fi).</p><button id="scorer-download">Tải bộ chấm điểm</button>`;
    if(!a&&pending?.asrPending){
        const p=pending.asrProgress;
        if(p&&p.phase==='download'){const pct=p.total?Math.floor(100*p.loaded/p.total):0;return `<p class="score-note">Đang tải bộ chấm điểm… ${pct}% (${Math.round(p.loaded/1e6)}/${Math.round(p.total/1e6)} MB)</p><div class="dl" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div><p class="score-hint">Chỉ tải một lần. Bạn có thể nghe lại bản ghi trong lúc chờ.</p>`;}
        if(p&&p.phase==='prepare')return `<p class="score-note">Đang chuẩn bị bộ chấm điểm…</p><div class="dl"><i style="width:100%"></i></div>`;
        return '<p class="score-note">Đang chấm điểm…</p>';
    }
    if(!a)return '';
    if(a.note)return `<p class="score-note">${escape(a.note)}</p>`;
    const label=['Bạn đã dám nói, giỏi lắm! Nghe mẫu rồi thử lại nhé.','Khá rồi! Thử nói chậm lại các từ màu cam.','Tốt lắm! Máy nghe được gần đủ câu.','Rất tốt! Máy nghe rõ cả câu.'][scoreStars(a.score)];
    return `<p class="score-number"><span class="stars" aria-label="${scoreStars(a.score)} trên 3 sao">${starText(a.score)}</span> ${label}</p><p class="score-words">${a.words.map(w=>`<span class="${w.ok?'hit':'miss'}">${escape(w.text)}</span>`).join(' ')}</p><p class="score-heard">Máy nghe được: “${escape(a.heard)}”</p><p class="score-hint">Sao cho biết máy nghe được bao nhiêu từ; giọng Việt vẫn được tính. Chấm ngay trên máy.</p>`;
}
const scoreHTML=()=>`<div id="score-slot" class="score" role="status">${scoreInner()}</div>`;
// Batch94 (NTE-DEC-086): stars instead of a hundred-point number, and an "đọc bồi" guide under each sentence.
const starText=score=>'★'.repeat(scoreStars(score))+'☆'.repeat(3-scoreStars(score));
function guideHTML(english) {
    const g=guideFor(english);
    return g?`<div class="say-guide"><p class="say-label">Cách đọc gần đúng</p><p class="say">${escape(g.say)}</p><p class="say-tip">${escape(g.tip)}</p><p class="say-legend">${escape(LEGEND)}</p></div>`:'';
}
function speechUI(id,type) {
    const history=type==='E'?state.e[`${id}:${attempt}`]:state.g[gIndex];
    const captured=pending?.id===id&&pending.evidence!=='không có bằng chứng';
    const allowed=type==='E'||captured||(lessonId==='L-S04'&&gIndex===0?history?.some(a=>a.id===id&&a.evidence!=='không có bằng chứng'):spoken(history));
    if(type==='E')return `<div class="controls">${recordButton()}</div><p id="timer" class="recording" role="status"></p>${!captured?`<div class="controls">${button('aloud','Tôi nói không dùng micro','text-link',busy)}${button('speak-skip','Bỏ qua câu này','text-link',busy)}</div>`:''}${takeURL?`<audio id="take-audio" playsinline src="${takeURL}"></audio>${button('play-take','Nghe lại bản ghi')}`:''}${captured?`${scoreHTML()}${playerHTML('compare',[id],{label:'Nghe mẫu để so sánh'})}<p>${escape(lesson.cards[index].check)}</p>${button('accept-take','Được rồi','primary')}${button('delete-take','Luyện lại')}`:''}${history?.length?'<p>Đã lưu lần luyện nói.</p>':''}${attempt===2&&!showText&&!captured?button('text-help','Cần câu mẫu'):''}`;
    return `<div class="controls">${recordButton()}</div><div class="controls">${button('aloud','Tôi nói không dùng micro','text-link',busy)}${button('speak-skip','Bỏ qua câu này','text-link',busy)}</div><p id="timer" class="recording" role="status"></p>${takeURL?`<audio id="take-audio" playsinline src="${takeURL}"></audio><button id="play-take" aria-label="Nghe bản ghi của bạn">${speakerIcon}</button>${button('delete-take','Luyện lại')}`:''}${allowed&&(captured||showText)?`${type==='E'&&attempt===2&&!showText?`<p class="target">${escape(lesson.cards[index].english)}</p><p>${escape(lesson.cards[index].vietnamese)}</p>${guideHTML(lesson.cards[index].english)}`:''}${captured?`${scoreHTML()}<form id="check"><label><input type="checkbox" name="meaning">Tôi đã nói đủ ý chính của câu.</label><label><input type="checkbox" name="clear">Tôi nghe hiểu lời mình nói (có thể nghe lại).</label><label><input type="checkbox" name="other">Tôi nói đủ câu hỏi / lời xác nhận cần có.</label>${lessonId==='L-S06'?'<label><input type="checkbox" name="invented">Tôi đã tiếp tục, chẩn đoán, khuyên chữa trị hoặc trì hoãn giúp khẩn cấp.</label>':''}<button type="submit">Được rồi</button></form>`:''}`:''}${history?.length?`<p>${escape(history.at(-1).outcome)} · ${history.at(-1).assisted?'Có hỗ trợ':'Không nhìn câu mẫu'}</p>`:''}${type==='E'&&attempt===2&&!showText&&!captured?button('text-help','Cần câu mẫu hỗ trợ'):''}`;
}
function bindCommon() {
    bind('part-menu',()=>{$('#part-list').hidden=!$('#part-list').hidden;});
    bind('meaning-toggle',()=>{meaningOn=!meaningOn;localStorage.setItem('nailtalk-meaning',String(meaningOn));$('#meaning-toggle').textContent='Nghĩa tiếng Việt: '+(meaningOn?'Bật':'Tắt');$('#meaning-toggle').setAttribute('aria-pressed',String(meaningOn));updateSubtitle(players.get('hear'));});
    document.querySelectorAll('[data-step]').forEach(el=>el.onclick=()=>{if(el.dataset.step==='summary'&&!completeStep(state,'6',lesson))return;nav(el.dataset.step);});
    scene.mount($('.scene'));scene.apply();document.body.classList.add('in-lesson');
    bind('privacy-link',e=>{e.preventDefault();$('#settings').showModal();$('#privacy').open=true;});
    bind('next',()=>{if(completeStep(state,state.step,lesson))nav(advance(state.step));});
    bind('skip',()=>{(state.skips||={})[state.step]=event({evidence:'không có bằng chứng',explicitSkip:true});persist();nav(advance(state.step));});
}
function saveSpeech(id,type,flags) {
    const evidence=pending?.evidence||'không có bằng chứng';
    if(type==='G'&&lessonId==='L-S02')flags.meaning &&= state.color===3;
    if(type==='G'&&lessonId==='L-S08')flags.meaning &&= !!state.water?.correct;
    const result=event({id,...flags,outcome:outcome({...flags,evidence:evidence!=='không có bằng chứng'},type),evidence,score:pending?.asr?.score??null,assisted:pending?.assisted||false,source:'tự đánh giá',attempt:type==='E'?attempt:gIndex+1});
    const container=type==='E'?state.e:state.g,key=type==='E'?`${id}:${attempt}`:gIndex;
    (container[key]||=[]).push(result);pending=null;disposeTake();render();
}
function bindStep() {
    bind('item-next',()=>{stopMedia();if(index<2){index++;render();}else finishPart('4');});
    if(state.step==='3')lesson.comprehension[index].options.forEach((_,n)=>bind('choice'+n,()=>{if(!state.heard[index])return;(state.answers[index]||=[]).push(event({answer:n,correct:n===lesson.comprehension[index].key}));render();}));
    document.querySelectorAll('[data-mini]').forEach(el=>el.onclick=()=>{const n=Number(el.dataset.mini);state.recognition[n]=event({answer:Number(el.dataset.answer),correct:Number(el.dataset.answer)===lesson.recognition[n].key});render();});
    bind('card-next',()=>{state.cards[lesson.cards[index].cue]=true;stopMedia();if(index<3){index++;render();}else finishPart('5');});
    if(state.step==='5') {
        bindSpeech(lesson.cards[index].cue,'E');
        bind('e-next',()=>{stopMedia();if(attempt===1)attempt=2;else if(index<3){attempt=1;index++;}else if(completeStep(state,'5',lesson)){finishPart('6');return;}render();});
        bindSafety();
    }
    if(state.step==='6') {
        bindSpeech(currentTurn().models[0],'G');
        bind('request-repeat',()=>{state.repeatRequested=event({evidence:'tự báo cáo, không ghi âm',source:'lời xin nhắc lại'});render();});
        document.querySelectorAll('[data-color]').forEach(el=>el.onclick=()=>{state.color=Number(el.dataset.color);render();});
        [0,1,2].forEach(n=>bind('water'+n,()=>{state.water=event({answer:n,correct:n===0});render();}));
        bind('g-next',()=>{stopMedia();if(gIndex<lesson.turns.length-1)gIndex++;else if(completeStep(state,'6',lesson)){finishPart('summary');return;}render();});
        bind('book',()=>{state.booked=true;persist();$('#book').textContent='Đã ghi lịch mô phỏng';});
    }
    [0,1,2].forEach(n=>bind('confidence'+n,()=>{state.confidence=['Tự nói được','Cần nghe mẫu','Muốn luyện lại'][n];render();}));
    bind('again',()=>nav('1'));
    bind('phrases',()=>{location.hash='phrases';});
    bind('next-lesson',()=>{const next=AVAILABLE_LESSONS[AVAILABLE_LESSONS.indexOf(lessonId)+1];if(next)openLesson(next);else location.hash='home';});
}
const safety = [
 {text:'Khách báo rát',models:['V2_S06_LINH_25'],reply:'V2_S06_LINDA_01',note:'Dừng trước, chỉ hỏi vị trí khi cần, rồi báo quản lý.'},
 {text:'Thấy vết thương/dấu hiệu bất thường hoặc nghi phản ứng',models:['V2_S06_LINH_26','V2_S06_SUSAN_03'],note:'Tạm hoãn vùng bị ảnh hưởng, quản lý tiếp nhận, hướng tới bác sĩ theo nội dung đã duyệt; không chẩn đoán, khuyên thuốc hoặc hứa đổi sản phẩm an toàn.'},
 {text:'Thấy chảy máu',models:['V2_S06_LINH_28','V2_S06_SUSAN_03'],note:'Dừng, không dùng tiếp đồ nhiễm bẩn; Susan tiếp nhận việc xử lý chảy máu.'},
 {text:'khó thở hoặc choáng là tín hiệu khẩn cấp ',prompt:'V2_S06_LINDA_02',models:['V2_S06_LINH_28','V2_S06_LINH_27'],note:'Dừng, báo Susan, gọi 911 ngay; không trì hoãn bằng hỏi thường.'}
];
function safetyHTML() {
    const n=state.safetyIndex||0,t=safety[n], round=state.safetyRound||1, h=state.safety?.[n];
    return `<section><h2>Ôn cách xử lý an toàn</h2><p>${escape(t.text)} · ${round===1?'Nghe và nói':'Tự nói'}</p>${round===1?playerHTML('safety-model',t.models,{label:'Nghe mẫu ôn an toàn',format:'mp3'}):playerHTML('safety-prompt',[t.prompt],{label:'Nghe tình huống ôn an toàn',format:'mp3'})}${button('safety-said','Tôi đã nói thành tiếng')}${h?.[round]?`<p>${escape(t.note)}</p>${t.reply?playerHTML('safety-reply',[t.reply],{label:'Nghe khách trả lời vị trí',format:'mp3'}):''}${button('safety-next','Tiếp tục ôn')}`:''}</section>`;
}
function bindSafety() {
    bind('safety-said',()=>{const n=state.safetyIndex||0;((state.safety||={})[n]||={})[state.safetyRound||1]=event({evidence:'tự báo cáo, không ghi âm',source:'tự kiểm tra hành động'});render();});
    bind('safety-next',()=>{stopMedia();if((state.safetyRound||1)===1)state.safetyRound=2;else{state.safetyRound=1;state.safetyIndex=((state.safetyIndex||0)+1)%4;if(completeStep(state,'5',lesson)){finishPart('6');return;}}render();});
}
function bindSpeech(id, type) {
    bind('accept-take',()=>saveSpeech(id,type,{meaning:true,clear:true,other:true,invented:false}));
    bind("play-take",()=>{const audio=$("#take-audio");if(type==='E')audio.onended=()=>players.get('compare')?.toggle();if(audio.paused){for(const player of players.values())player.stop();audio.play();}else audio.pause();});
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
        pending = { id, evidence: "tự báo cáo, không ghi âm", assisted: showText || (type === "G" && !!state.repeatHelp) || (type === "E" && attempt === 1) || !pack.cues[id].audio };
        render();
    });
    bind("speak-skip", () => {
        pending = { id, evidence: "không có bằng chứng", assisted: true };
        saveSpeech(id, type, { meaning: false, clear: false, other: false, invented: false });
    });
    bind("record", () => (busy && recorder?.state === "recording") ? recorder.stop() : startRecording(id, type));
    $("#score-slot")?.addEventListener("click", e => { if (e.target.id === "scorer-download" && pending?.samples) scoreTake(pending, speechTarget(id, type)); });
    const form = $("#check");
    if (form)
        form.onsubmit = e => {
            e.preventDefault();
            const f = new FormData(form);
            saveSpeech(id, type, { meaning: f.has("meaning"), clear: f.has("clear"), other: f.has("other"), invented: f.has("invented") });
        };
}
function recordButton() {
    return `<button id="record" class="primary microphone" data-state="idle">${takeURL?'🎤 Ghi lại':'🎤 Nói thử'}</button><span class="meter" aria-hidden="true"><i id="meter-fill"></i></span>`;
}
function showRecording(on) {
    const b=$("#record");
    if(!b)return;
    b.dataset.state=on?"recording":"idle";
    b.textContent=on?"■ Ghi âm xong":(takeURL?"🎤 Ghi lại":"🎤 Nói thử");
    b.classList.toggle("is-recording",on);
    b.setAttribute("aria-pressed",String(on));
    const fill=$("#meter-fill");if(fill&&!on)fill.style.width="0";
}
function micDiagText() {
    if(!micDiag)return "Chưa có lần ghi nào.";
    const d=micDiag;
    return `Lần ghi gần nhất: ${d.seconds} giây · âm lớn nhất ${d.peak} · ${d.sampleRate} Hz · micro ${d.trackMuted?'bị tắt tiếng':'mở'} (${d.trackState}) · âm thanh ${d.contextState} · phiên ${d.session}${d.retried?' · đã thử lại':''}`;
}
async function startRecording(id, type, retry=false) {
    if (busy)
        return;
    // Created inside the tap, before any await, so iPhone lets audio run.
    const ctx = createAudioContext();
    for (const player of players.values())
        player.stop();
    disposeTake();
    pending = null;
    micError = "";
    busy = true;
    try {
        const cap = recorder = await openCapture(ctx);
        cap.onstop = () => {
            clearTimeout(recordTimer);
            clearTimeout(deadTimer);
            clearInterval(timerTick);
            busy = false;
            recorder = null;
            scene.recording = false; scene.apply();
            micDiag = {...cap.diag, retried: retry};
            take = cap.blob;
            if (!take.size) {
                take = null;
                micError = `Micro chưa thu được tiếng. Bạn thử lại; nếu vẫn vậy, mở Cài đặt và chụp dòng "Micro" gởi nhóm phát triển.`;
            }
            else {
                takeURL = URL.createObjectURL(take);
                if (cap.peak === 0) micError = "Bản ghi không có tiếng. Bạn nói gần micro hơn rồi ghi lại nhé.";
                const mine = pending = { id, evidence: "đã ghi âm trên máy", assisted: showText || (type === "G" && !!state.repeatHelp) || (type === "E" && attempt === 1) || !pack.cues[id].audio };
                if(scoringOn&&asrAvailable&&!asrBroken){
                    mine.samples=cap.samples;
                    // Too quiet to hold words: say so instead of letting the model guess.
                    if(cap.peak<0.02)mine.asr={note:'Máy chưa nghe được câu nào. Thử nói to và rõ hơn nhé.'};
                    else if(scorerReady())queueMicrotask(()=>scoreTake(mine,speechTarget(id,type)));
                    else mine.asrOffer=true;
                }
            }
            const diagEl=$("#mic-diag");if(diagEl)diagEl.textContent=micDiagText();
            render();
            if(type==='E'&&takeURL){const audio=$('#take-audio');audio.onended=()=>players.get('compare')?.toggle();audio.play().catch(()=>{micError='Chạm Nghe lại bản ghi để nghe bạn rồi nghe mẫu.';});}
        };
        // A microphone that delivers nothing, or only exact zeros, is dead: start once more with a fresh one.
        const deadTimer = setTimeout(() => {
            if (recorder !== cap || cap.state !== "recording" || cap.peak > 0) return;
            cap.onstop = null;
            cap.stop();
            recorder = null;
            micDiag = {...cap.diag, retried: retry};
            clearInterval(timerTick); clearTimeout(recordTimer);
            busy = false;
            scene.recording = false; scene.apply();
            if (!retry) { startRecording(id, type, true); return; }
            micError = `Micro chưa thu được tiếng. Bạn đóng hẳn ứng dụng rồi mở lại, hoặc nói không dùng micro.`;
            render();
        }, 2000);
        scene.recording = true; scene.apply();
        showRecording(true);
        $("#aloud") && ($("#aloud").disabled = true);
        $("#speak-skip") && ($("#speak-skip").disabled = true);
        const started = Date.now();
        timerTick = setInterval(() => {
            $("#timer").textContent = `Đang ghi · ${Math.floor((Date.now() - started) / 1000)} giây · Bấm Ghi âm xong khi nói xong (tự dừng ở 60 giây).`;
            const fill=$("#meter-fill");if(fill)fill.style.width=`${Math.min(100,Math.round(cap.level*250))}%`;
        }, 100);
        recordTimer = setTimeout(() => {
            if (recorder === cap && cap.state === "recording")
                cap.stop();
        }, 60000);
    }
    catch {
        busy = false;
        recorder = null;
        micError = "Không mở được micro. Bạn kiểm tra quyền micro của trình duyệt, hoặc nói không dùng micro, hoặc bỏ qua.";
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
        releaseMic();
        if (was) {
            micError = "Đã dừng khi ứng dụng ra nền. Hãy bắt đầu lượt mới.";
            render();
        }
    }
});
window.addEventListener("pagehide", () => { stopMedia(); releaseMic(); });
window.addEventListener("hashchange", () => {
    const requested = location.hash.slice(1).split("/")[0];
    if (catalog.some(p => p.id === requested) && (requested !== lessonId || onHome)) { stopMedia(); location.reload(); return; }
    const route = location.hash.split("/")[1];
    if (STEPS.includes(route)) {
        if (state.step !== route) {
            stopMedia();
            state.step = route;
            index = state.positions?.[route]?.index || 0;
            attempt = state.positions?.[route]?.attempt || 1;
            gIndex = state.positions?.[route]?.gIndex || 0;
        }
        render();
    }
    else
        render();
});
bind("settings-open", () => $("#settings").showModal());
bind("settings-close", () => $("#settings").close());
bind("lipsync-toggle", () => scene.setLipEnabled(!scene.lipEnabled));
bind("motion-toggle", () => scene.setEnabled(!scene.enabled));
function scoringLabel() {
    const el=$("#scoring-toggle");if(!el)return;
    el.disabled=!asrAvailable;
    el.setAttribute("aria-pressed",String(asrAvailable&&scoringOn));
    el.textContent=asrAvailable?`Chấm điểm nói (thử nghiệm, trên máy): ${scoringOn?"Bật":"Tắt"}`:"Chấm điểm nói: trình duyệt này chưa hỗ trợ";
}
bind("scoring-toggle", () => {scoringOn=!scoringOn;asrBroken=false;localStorage.setItem("nailtalk-scoring",String(scoringOn));scoringLabel();});
scoringLabel();
{const el=$("#mic-diag");if(el)el.textContent=micDiagText();}
scene.apply();

bind("erase", async () => {
    if (confirm("Xóa toàn bộ tiến độ, tự đánh giá, bản ghi và dữ liệu ngoại tuyến của NailTalk trên thiết bị này?")) {
        stopMedia();
        await store.clear();
        scene.reset();
        await workerMessage("CLEAR");
        forgetScorer();
        state = initialState();
        for(const id of LESSON_ORDER)progress[id]=migrateProgress(null,id);
        packAvailable = false;
        location.hash = "home";
        renderHome();
        $("#offline").textContent = "Đã xóa dữ liệu. Tải lại bài để dùng ngoại tuyến.";
    }
});
bind("remove-pack", async () => {
    await workerMessage("REMOVE_PACK");
    packAvailable = false;
    location.hash = "home";
    renderHome();
    $("#offline").textContent = "Đã gỡ bài ngoại tuyến; tiến độ được giữ.";
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
                            reject(Error("Cài ngoại tuyến chưa xong"));
                    });
                });
        }
        await workerMessage("INSTALL_PACK", {id:lessonId});
        packAvailable = true;
        if (!location.hash || location.hash === "#home") renderHome();
        await checkOffline();
    }
    catch (error) {
        console.info("NailTalk offline retry: " + error.message);
        $("#offline").textContent = "Chưa tải xong. Thử lại khi máy chủ cục bộ đang chạy.";
    }
});
async function workerMessage(type, extra = {}) {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg?.active)
        throw Error("No service worker");
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel(), timeout = setTimeout(() => reject(Error("timeout")), 15000);
        channel.port1.onmessage = e => {
            clearTimeout(timeout);
            e.data.error ? reject(Error(e.data.error)) : resolve(e.data);
        };
        reg.active.postMessage({ type, format, ...extra }, [channel.port2]);
    });
}
function offlineStatus(data) {
    if (!data || data.type !== 'OFFLINE_PROGRESS') return;
    $('#offline').textContent = data.ready ? `Sẵn sàng ngoại tuyến · ${AVAILABLE_LESSONS.length}/${AVAILABLE_LESSONS.length} bài` : data.error ? 'Chưa tải xong. Chọn Tải lại bài để thử lại.' : !data.downloading ? 'Mở bài học để tải nội dung ngoại tuyến.' : `Đang tải bài cho dùng offline… ${data.completed}/${AVAILABLE_LESSONS.length}`;
    $('#offline-progress').textContent = data.ready || data.error || !data.downloading ? '' : `Đang tải bài cho dùng offline… ${data.completed}/${AVAILABLE_LESSONS.length}`;
}
async function checkOffline() {
    try {
        await workerMessage('SELECT_FORMAT');
        offlineStatus({type:'OFFLINE_PROGRESS', ...await workerMessage('STATUS')});
        // Home stays light; download only after an opened scene has decoded.
        if (!onHome) {
            const waitForScene = () => new Promise(resolve => {
                const poll = () => scene.failed || scene.spriteFailed || !scene.root || (scene.ready && scene.spriteReady) ? resolve() : setTimeout(poll, 50);
                poll();
            });
            await waitForScene();
            await workerMessage('START', {id:lessonId});
        }
    } catch { $('#offline').textContent = 'Chưa kiểm tra được ngoại tuyến.'; }
}
navigator.serviceWorker?.addEventListener('message', event => offlineStatus(event.data));
navigator.serviceWorker?.addEventListener('controllerchange', () => checkOffline());
window.addEventListener('online', () => checkOffline());
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { type: "module" }).then(async () => {
        await navigator.serviceWorker.ready;
        await checkOffline();
        console.info("NailTalk: service worker registered; manifest linked");
    }).catch(() => {
        $("#offline").textContent = "Chưa dùng được ngoại tuyến. Hãy mở bằng địa chỉ cài đặt được cung cấp.";
    });
}
else
    $("#offline").textContent = "Cần mở bằng địa chỉ cài đặt được cung cấp để tải bài.";
const route = location.hash.split("/")[1];
if (STEPS.includes(route))
    state.step = route;
index = state.positions?.[state.step]?.index || 0;
attempt = state.positions?.[state.step]?.attempt || 1;
gIndex = state.positions?.[state.step]?.gIndex || 0;
render();
if(!onHome)persist();
