export const STEPS = ['1','2','3','4','5','6','summary'];
export function nextStep(step) { return STEPS[Math.min(STEPS.indexOf(step)+1, STEPS.length-1)]; }
export function cueState(cue) { return {missing: !cue?.audio, assisted: !cue?.audio, listeningScored: !!cue?.audio}; }
export function initialState() { return {schema:2, listened:{}, heard:{}, answers:{}, cards:{}, recognition:{}, positions:{}, pack:'APP_PROTO_v017-DRAFT-1', rubric:'lesson-set-v2.1', step:'1', visited:[], a:0, b:{}, c:[], d:{}, e:{}, f:false, g:{}, confidence:null}; }
export function outcome(flags, type='E') {
  if (!flags.evidence || !flags.meaning || !flags.clear || (type==='G' && flags.invented)) return 'Cần thử lại';
  return flags.other ? 'Đạt' : 'Gần đạt';
}
export function completeStep(s, step, pack) {
  if (s.schema===2 && pack.cards) {
    if(s.skips?.[step])return true;
    switch(step) {
      case '1': case '2': return !!s.listened[step];
      case '3': return pack.comprehension.every((_,n)=>s.answers[n]?.length);
      case '4': return pack.cards.every(c=>s.cards[c.cue]);
      case '5': return (!pack.safetyRequired||[0,1,2,3].every(i=>s.safety?.[i]?.[1]&&s.safety?.[i]?.[2])) && pack.cards.every(c=>[1,2].every(n=>s.e[c.cue+':'+n]?.length));
      case '6': return pack.turns.every((_,n)=>s.g[n]?.length);
      default:return false;
    }
  }
  if (pack.enabled_steps && !pack.enabled_steps.includes(step) && step !== 'summary') return true;
  if (s.skips?.[step]) return true;
  switch(step) {
    case 'A': return s.a>0;
    case 'B': return pack.b.every(i=>s.b[i.id]?.length);
    case 'C': return s.c.length>0;
    case 'D': return pack.teaching.every(id=>s.d[id]);
    case 'E': return pack.teaching.every(id=>[1,2].every(n=>s.e[`${id}:${n}`]?.length));
    case 'F': return s.f;
    case 'G': if(pack.transfer.activity==='native') return [...(pack.drills||[]),...pack.transfer.turns].every((_,i)=>s.g[i]?.length) && (!pack.cases || pack.cases.every((_,i)=>s.cases?.[i])); return pack.transfer.activity === 'swatch' ? !!s.gSwatch?.at(-1)?.correct && !!s.g[0]?.length : [0,1].every(i=>s.g[i]?.length);
    default: return false;
  }
}
export function transferResult(attempts) {
  const price=attempts[0], checking=attempts[1];
  if (!price || !checking || [price,checking].some(a=>a.evidence==='không có bằng chứng') || !price.meaning || !price.clear || !checking.meaning || !checking.clear || checking.invented) return 'Cần thử lại';
  return price.other && checking.other ? 'Đạt' : 'Gần đạt';
}
export function summarize(s, pack) {
  const LEGACY_STEPS=['A','B','C','D','E','F','G'];
  const b = pack.b.map(i=>s.b[i.id]?.[0]).filter(Boolean);
  const scored = b.filter(a=>!a.assisted && a.answer!==null);
  return {B:{correct:scored.filter(a=>a.correct).length, scored:scored.length, assisted:b.filter(a=>a.assisted).length, attempts:s.b}, C:{first:s.c[0]??null, attempts:s.c}, E:{source:'tự đánh giá', attempts:s.e}, G:{source:'tự đánh giá', firstOutcome:transferResult([s.g[0]?.[0],s.g[1]?.[0]]), latestOutcome:transferResult([s.g[0]?.at(-1),s.g[1]?.at(-1)]), attempts:s.g}, completed:(pack.enabled_steps || LEGACY_STEPS).every(step=>s.visited.includes(step)&&completeStep(s,step,pack))};
}

export function normalizeState(saved) {
  if(!saved || saved.schema!==2 || !STEPS.includes(saved.step))return initialState();
  const fresh=initialState();
  return {...fresh,...saved,...Object.fromEntries(['listened','heard','answers','cards','recognition','positions','e','g'].map(k=>[k,saved[k]&&typeof saved[k]==='object'?saved[k]:{}]))};
}
