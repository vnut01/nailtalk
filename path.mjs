import {normalizeState, completeStep} from './logic.mjs';
export const LESSON_ORDER=['L-S01','L-S08','L-S02','L-S05','L-S07','L-S06','L-S03','L-S04','L-S09','L-S14','L-S13','L-S10','L-S11','L-S12','L-S15','L-S16'];
export const AVAILABLE_LESSONS=LESSON_ORDER.filter(id=>id!=='L-S10');
export function migrateProgress(saved,id) {
 const s=normalizeState(saved);
 if(saved && !saved.contentVersion) {
  // Comprehension questions changed; retain speaking evidence and the current part.
  s.answers={};s.heard={};s.recognition={};
  s.positions={...s.positions};
  if(s.positions['3'])s.positions['3']={...s.positions['3'],index:Math.min(2,s.positions['3'].index||0)};
  const g={...s.g};
  if(id==='L-S06')s.g={0:g[0],1:g[0],2:g[1]};
  if(id==='L-S03'||id==='L-S04')s.g={0:g[0],1:g[1],2:g[1]};
  if(s.positions['6'] && id==='L-S06' && s.positions['6'].gIndex===1)s.positions['6']={...s.positions['6'],gIndex:2};
 }
 s.contentVersion='v019';return s;
}
export const finished=s=>!!s?.visited?.includes('summary');
export function practiced(s,lesson){return lesson.cards.filter(c=>[1,2].some(n=>s?.e?.[c.cue+':'+n]?.some(a=>a.evidence&&a.evidence!=='không có bằng chứng')));}
export const reachedPhrases=s=>!!s&&(s.visited?.includes('4')||['4','5','6','summary'].includes(s.step));
export function lessonStatus(s,lesson){if(finished(s))return 'Đã xong';if(!s?.visited?.length)return 'Chưa học';return `Đang học ${['1','2','3','4','5','6'].filter(n=>completeStep(s,n,lesson)).length}/6`;}
export function continueLesson(progress){return AVAILABLE_LESSONS.filter(id=>progress[id]?.visited?.length&&!finished(progress[id])).sort((a,b)=>(progress[b].updatedAt||'').localeCompare(progress[a].updatedAt||''))[0]||AVAILABLE_LESSONS.find(id=>!finished(progress[id]))||LESSON_ORDER[0];}
