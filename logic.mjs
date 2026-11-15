export const STEPS = ['1','2','3','4','5','6','summary'];
export function nextStep(step) { return STEPS[Math.min(STEPS.indexOf(step)+1, STEPS.length-1)]; }
export function cueState(cue) { return {missing: !cue?.audio, assisted: !cue?.audio, listeningScored: !!cue?.audio}; }
export function initialState() { return {schema:2, listened:{}, heard:{}, answers:{}, cards:{}, recognition:{}, positions:{}, pack:'APP_PROTO_v018-DRAFT-1', rubric:'lesson-set-v2.1', step:'1', visited:[], a:0, b:{}, c:[], d:{}, e:{}, f:false, g:{}, confidence:null}; }
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

// Speech check: compares what the browser's recognizer heard with the target words.
// It measures "did the phone catch these words", not accent quality.
const ONES=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS=['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
export function numberWords(n) {
  n=Number(n);
  if(n<20)return ONES[n];
  if(n<100)return TENS[Math.floor(n/10)]+(n%10?' '+ONES[n%10]:'');
  if(n<1000)return ONES[Math.floor(n/100)]+' hundred'+(n%100?' '+numberWords(n%100):'');
  return String(n).split('').map(d=>ONES[d]).join(' ');
}
export function speechWords(text) {
  return String(text??'').toLowerCase()
    .replace(/\$\s?(\d+)(?:\.00)?/g,(_,n)=>numberWords(n)+' dollars')
    .replace(/(\d{1,2}):(\d\d)/g,(_,h,m)=>numberWords(h)+(m==='00'?'':' '+(m[0]==='0'?'oh '+ONES[m[1]]:numberWords(m))))
    .replace(/\d+/g,d=>d.length>2||d[0]==='0'?d.split('').map(c=>ONES[c]).join(' '):numberWords(d))
    .replace(/[’']/g,'').replace(/\bok\b/g,'okay').replace(/[^a-z]+/g,' ').trim().split(' ').filter(Boolean);
}
export function speechScore(target, heard) {
  const shown=String(target).split(/\s+/).filter(Boolean), owner=[], want=[];
  shown.forEach((w,i)=>{for(const t of speechWords(w)){want.push(t);owner.push(i);}});
  const got=speechWords(heard), m=want.length, n=got.length;
  const table=Array.from({length:m+1},()=>new Array(n+1).fill(0));
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)table[i][j]=want[i]===got[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
  const hit=new Array(m).fill(false);
  for(let i=0,j=0;i<m&&j<n;){if(want[i]===got[j]){hit[i]=true;i++;j++;}else if(table[i+1][j]>=table[i][j+1])i++;else j++;}
  const words=shown.map((text,i)=>({text,ok:owner.some(o=>o===i)&&owner.every((o,k)=>o!==i||hit[k])}));
  return {score:m?Math.round(100*hit.filter(Boolean).length/m):0,words};
}
export function bestSpeechScore(target, candidates) {
  return candidates.filter(Boolean).map(heard=>({...speechScore(target,heard),heard})).sort((a,b)=>b.score-a.score)[0]||null;
}
