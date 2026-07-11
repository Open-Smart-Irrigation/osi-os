'use strict';
const RANK={none:0,mild:1,moderate:2,significant:3,severe:4,unknown:0};
const PHENO_MOD={"bud_break":0.8,"cell_division":0.7,"cell_expansion":0.8,"fruit_maturation":1.0,"post_harvest":1.3,"dormancy":1.5,"default":1.0};
const LEVELS=['none','mild','moderate','significant','severe'];
const MIN_SAMPLES_DAY=5;
const MIN_SAMPLES_WINDOW=2;
const LOW_SIGNAL_THRESHOLD_UM=10;
const JUMP_THRESHOLD_UM=200;
const N_TREES_FOR_EMERGENCY=2;
const DAYS_FOR_SOLO_EMERGENCY=2;
const CALIBRATIONS={
  "default":{key:"default",twd_method:"stepwise",thresholds:{mild:30,moderate:60,significant:100,severe:140}},
  "apple":{key:"apple",twd_method:"stepwise",thresholds:{mild:25,moderate:55,significant:90,severe:130}},
  "grapevine":{key:"grapevine",twd_method:"stepwise",thresholds:{mild:20,moderate:40,significant:70,severe:100}},
  "olive":{key:"olive",twd_method:"stepwise",thresholds:{mild:40,moderate:80,significant:130,severe:180}}
};
function round(v,d){if(v==null||!isFinite(v))return null;return Math.round(v*Math.pow(10,d||0))/Math.pow(10,d||0);}
function avg(a){const f=(a||[]).filter(v=>v!=null&&isFinite(v));return f.length?f.reduce((x,y)=>x+y,0)/f.length:null;}
function percentile(a,p){
  const s=[...(a||[])].filter(v=>v!=null&&isFinite(v)).sort((x,y)=>x-y);
  if(!s.length)return null;
  const idx=Math.min(Math.floor(p*s.length),s.length-1);
  return s[idx];
}
function localHour(utcTs,tz){
  try{
    const h=parseInt(new Intl.DateTimeFormat('en-US',{hour:'numeric',hour12:false,timeZone:tz}).format(new Date(utcTs)),10);
    return (isNaN(h)||h===24)?0:h;
  }catch(e){return null;}
}
function localTimeStr(utcTs,tz){
  try{return new Intl.DateTimeFormat('en-US',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:tz}).format(new Date(utcTs)).replace('24:','00:');}
  catch(e){return null;}
}
function localDateParts(ts,tz){
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts));
    const map={};
    for(const p of parts){if(p.type!=='literal')map[p.type]=p.value;}
    return {year:Number(map.year),month:Number(map.month),day:Number(map.day)};
  }catch(e){return null;}
}
function shiftDateIso(dateIso,days){
  const base=new Date(dateIso+'T00:00:00Z');
  base.setUTCDate(base.getUTCDate()+days);
  return base.toISOString().slice(0,10);
}
function tzOffsetMinutes(ts,tz){
  try{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz||'UTC',timeZoneName:'shortOffset'}).formatToParts(new Date(ts));
    const token=(parts.find(p=>p.type==='timeZoneName')||{}).value||'GMT';
    if(token==='GMT'||token==='UTC')return 0;
    const m=token.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if(!m)return 0;
    const sign=m[1]==='-'?-1:1;
    return sign*((Number(m[2])||0)*60+(Number(m[3])||0));
  }catch(e){return 0;}
}
function localMidnightUtcIso(dateIso,tz){
  const [y,m,d]=String(dateIso).split('-').map(Number);
  const guess=Date.UTC(y,m-1,d,0,0,0,0);
  const offsetMin=tzOffsetMinutes(guess,tz);
  return new Date(guess-offsetMin*60000).toISOString();
}
function computeZoneDayWindow(referenceTs,tz){
  const effectiveTz=tz||'UTC';
  const parts=localDateParts(referenceTs,effectiveTz);
  if(!parts){
    const fallbackDate=shiftDateIso(new Date(referenceTs).toISOString().slice(0,10),-1);
    return {date:fallbackDate,windowStartInclusive:fallbackDate+'T00:00:00.000Z',windowEndExclusive:shiftDateIso(fallbackDate,1)+'T00:00:00.000Z'};
  }
  const localToday=`${String(parts.year).padStart(4,'0')}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;
  const targetDate=shiftDateIso(localToday,-1);
  return {
    date:targetDate,
    windowStartInclusive:localMidnightUtcIso(targetDate,effectiveTz),
    windowEndExclusive:localMidnightUtcIso(shiftDateIso(targetDate,1),effectiveTz)
  };
}
function calibrationForKey(key){
  const k=String(key||'default').trim().toLowerCase();
  return CALIBRATIONS[k]||CALIBRATIONS.default;
}
function detectJumps(rows){
  for(let i=1;i<rows.length;i++){if(Math.abs(rows[i].p-rows[i-1].p)>JUMP_THRESHOLD_UM)return true;}
  return false;
}
function removeJumps(rows,thresh=JUMP_THRESHOLD_UM){
  if(!rows.length)return [];
  const copy=rows.map(r=>({p:r.p,t:r.t}));
  for(let i=1;i<copy.length;i++){
    const diff=copy[i].p-copy[i-1].p;
    if(Math.abs(diff)>thresh){
      for(let j=i;j<copy.length;j++)copy[j].p-=diff;
    }
  }
  return copy;
}
function median3(vals){
  return vals.map((_,i)=>{
    const w=vals.slice(Math.max(0,i-1),Math.min(vals.length,i+2)).filter(v=>v!=null&&isFinite(v)).sort((a,b)=>a-b);
    return w.length?w[Math.floor(w.length/2)]:null;
  });
}
function extractExtremes(rows,tz){
  let pdMax=-Infinity,afMin=Infinity,dMaxTime=null,dMinTime=null;
  let predawnSamples=0,afternoonSamples=0;
  for(const r of rows){
    if(r.p==null||!isFinite(r.p))continue;
    const h=localHour(r.t,tz);
    if(h===null)continue;
    if(h>=5&&h<7){
      predawnSamples++;
      if(r.p>pdMax){pdMax=r.p;dMaxTime=localTimeStr(r.t,tz);}
    }
    if(h>=13&&h<16){
      afternoonSamples++;
      if(r.p<afMin){afMin=r.p;dMinTime=localTimeStr(r.t,tz);}
    }
  }
  const all=rows.filter(r=>r.p!=null&&isFinite(r.p));
  const effectiveDMax=pdMax>-Infinity?pdMax:(all.length?Math.max(...all.map(r=>r.p)):null);
  const effectiveDMin=afMin<Infinity?afMin:(all.length?Math.min(...all.map(r=>r.p)):null);
  return {dMax:effectiveDMax!=null?round(effectiveDMax,0):null,dMin:effectiveDMin!=null?round(effectiveDMin,0):null,dMaxTime,dMinTime,predawnSamples,afternoonSamples};
}
function computeVPD(tC,rh){
  if(tC==null||rh==null)return null;
  return round(0.6108*Math.exp(17.27*tC/(tC+237.3))*(1-rh/100),3);
}
function buildQaFlags(totalValid,predawnSamples,afternoonSamples,suspectedStepArtifact,mdsUm){
  const enoughSamplesDay=totalValid>=MIN_SAMPLES_DAY;
  const enoughSamplesPredawn=predawnSamples>=MIN_SAMPLES_WINDOW;
  const enoughSamplesAfternoon=afternoonSamples>=MIN_SAMPLES_WINDOW;
  const usedFullDayFallback=!enoughSamplesPredawn||!enoughSamplesAfternoon;
  const lowSignalDay=(mdsUm!=null&&mdsUm<LOW_SIGNAL_THRESHOLD_UM);
  const lowConfidenceDay=!enoughSamplesDay||usedFullDayFallback||lowSignalDay;
  let confidenceScore=1.0;
  if(!enoughSamplesDay)confidenceScore=0.0;
  else if(lowSignalDay)confidenceScore=0.1;
  else if(usedFullDayFallback)confidenceScore=0.5;
  else if(suspectedStepArtifact)confidenceScore=0.7;
  return {
    enoughSamplesDay,
    enoughSamplesPredawn,
    enoughSamplesAfternoon,
    usedFullDayFallback,
    suspectedStepArtifact:!!suspectedStepArtifact,
    lowSignalDay,
    lowConfidenceDay,
    confidenceScore
  };
}
function computeEnvelope(sequence,method){
  if(!sequence.length)return [];
  const m=String(method||'stepwise');
  if(m==='linear'){
    const anchors=[];
    let runningMax=-Infinity;
    sequence.forEach((pt,idx)=>{
      if(pt.dMax!=null&&(pt.dMax>=runningMax||idx===0)){runningMax=pt.dMax;anchors.push({idx,dMax:pt.dMax});}
    });
    if(!anchors.length&&sequence[0].dMax!=null)anchors.push({idx:0,dMax:sequence[0].dMax});
    return sequence.map((pt,idx)=>{
      let prev=anchors[0],next=anchors[anchors.length-1];
      for(let i=0;i<anchors.length;i++){
        if(anchors[i].idx<=idx)prev=anchors[i];
        if(anchors[i].idx>=idx){next=anchors[i];break;}
      }
      let ref=prev&&prev.dMax!=null?prev.dMax:pt.dMax;
      if(prev&&next&&next.idx>prev.idx){
        const frac=(idx-prev.idx)/(next.idx-prev.idx);
        ref=prev.dMax+((next.dMax-prev.dMax)*frac);
      }
      ref=round(ref,0);
      return {
        envelopeRef:ref,
        twdNight:pt.dMax!=null?round(Math.max(0,ref-pt.dMax),0):null,
        twdDay:pt.dMin!=null?round(Math.max(0,ref-pt.dMin),0):null,
        mds:(pt.dMax!=null&&pt.dMin!=null)?round(pt.dMax-pt.dMin,0):null
      };
    });
  }
  let ref=null;
  return sequence.map(pt=>{
    if(ref==null||pt.dMax>=ref)ref=pt.dMax;
    ref=round(ref,0);
    return {
      envelopeRef:ref,
      twdNight:pt.dMax!=null?round(Math.max(0,ref-pt.dMax),0):null,
      twdDay:pt.dMin!=null?round(Math.max(0,ref-pt.dMin),0):null,
      mds:(pt.dMax!=null&&pt.dMin!=null)?round(pt.dMax-pt.dMin,0):null
    };
  });
}
function classifyAbsoluteTwd(twdDayUm,phenoMod,calibration){
  const t=(calibration&&calibration.thresholds)||CALIBRATIONS.default.thresholds;
  const m=(phenoMod&&phenoMod>0)?phenoMod:1.0;
  if(twdDayUm>=t.severe*m)return'severe';
  if(twdDayUm>=t.significant*m)return'significant';
  if(twdDayUm>=t.moderate*m)return'moderate';
  if(twdDayUm>=t.mild*m)return'mild';
  return'none';
}
function carryForwardState(yest){
  if(!yest)return'unknown';
  return yest.tree_state_v5||yest.stress_level||'unknown';
}
function computeAbsoluteDeltaTwdSmoothed(todayTwdNightUm,yesterdayTwdNightUm,priorDeltaTwdSmoothed){
  if(todayTwdNightUm==null||yesterdayTwdNightUm==null)return null;
  const vals=[todayTwdNightUm-yesterdayTwdNightUm,...(priorDeltaTwdSmoothed||[]).filter(v=>v!=null&&isFinite(v))];
  return vals.length?round(avg(vals),1):null;
}
function computeRDelta5day(drUm,mdsUm,hist){
  const drH=[drUm,...hist.slice(0,4).map(r=>r.dr_um)].filter(v=>v!=null&&isFinite(v));
  const mdsH=[mdsUm,...hist.slice(0,4).map(r=>r.mds_um)].filter(v=>v!=null&&isFinite(v));
  if(!drH.length||!mdsH.length)return null;
  return round(avg(drH)-avg(mdsH),0);
}
function adjustStress(lvl,d){
  const i=LEVELS.indexOf(lvl);
  return i<0?lvl:LEVELS[Math.max(0,Math.min(LEVELS.length-1,i+d))];
}
function computeR2(x,y){
  if(!Array.isArray(x)||!Array.isArray(y)||x.length<3||x.length!==y.length)return null;
  const mx=avg(x),my=avg(y);
  let sxy=0,sxx=0,ssTot=0;
  for(let i=0;i<x.length;i++){
    sxy+=(x[i]-mx)*(y[i]-my);
    sxx+=(x[i]-mx)*(x[i]-mx);
    ssTot+=(y[i]-my)*(y[i]-my);
  }
  if(sxx===0||ssTot===0)return null;
  const slope=sxy/sxx,intercept=my-slope*mx;
  let ssRes=0;
  for(let i=0;i<x.length;i++)ssRes+=Math.pow(y[i]-(slope*x[i]+intercept),2);
  return round(1-(ssRes/ssTot),3);
}
function aggregateZoneStress(allNonRef){
  const nonRef=(allNonRef||[]).filter(t=>!t.low_confidence_day);
  const lowConfidenceTreeCount=(allNonRef||[]).filter(t=>t.low_confidence_day).length;
  const zoneConfidenceScore=(allNonRef||[]).length?round(avg(allNonRef.map(t=>t.confidence_score||0)),3):0;
  if(!nonRef.length){
    return {zoneStress:'unknown',usableTrees:[],usableTreeCount:0,lowConfidenceTreeCount,outlierFilteredTreeCount:0,zoneConfidenceScore};
  }
  const twdTrees=nonRef.filter(t=>t.twd_day_um!=null&&isFinite(t.twd_day_um));
  if(!twdTrees.length){
    const stress=nonRef.reduce((w,t)=>(RANK[t.tree_state_v5]||0)>(RANK[w]||0)?t.tree_state_v5:w,'unknown');
    return {zoneStress:stress,usableTrees:nonRef,usableTreeCount:nonRef.length,lowConfidenceTreeCount,outlierFilteredTreeCount:0,zoneConfidenceScore};
  }
  const twdVals=twdTrees.map(t=>t.twd_day_um).sort((a,b)=>a-b);
  const median=percentile(twdVals,0.5);
  const absDevs=twdVals.map(v=>Math.abs(v-median)).sort((a,b)=>a-b);
  const mad=percentile(absDevs,0.5);
  const threshold=(mad&&mad>0)?3*mad:Number.MAX_VALUE;
  let filteredTrees=twdTrees.filter(t=>Math.abs(t.twd_day_um-median)<=threshold);
  const outlierFilteredTreeCount=filteredTrees.length?Math.max(0,twdTrees.length-filteredTrees.length):0;
  if(!filteredTrees.length)filteredTrees=twdTrees;
  const filteredVals=filteredTrees.map(t=>t.twd_day_um).sort((a,b)=>a-b);
  const p75=percentile(filteredVals,0.75);
  let stressFrom75='none';
  for(const t of filteredTrees){
    if(t.twd_day_um>=p75&&(RANK[t.tree_state_v5]||0)>(RANK[stressFrom75]||0))stressFrom75=t.tree_state_v5;
  }
  const severeCount=nonRef.filter(t=>t.tree_state_v5==='severe').length;
  if(severeCount>=N_TREES_FOR_EMERGENCY){
    return {zoneStress:'severe',usableTrees:nonRef,usableTreeCount:nonRef.length,lowConfidenceTreeCount,outlierFilteredTreeCount,zoneConfidenceScore};
  }
  const sigCount=nonRef.filter(t=>t.tree_state_v5==='significant'||t.tree_state_v5==='severe').length;
  if(sigCount>=N_TREES_FOR_EMERGENCY&&(RANK[stressFrom75]||0)<RANK.significant){
    return {zoneStress:'significant',usableTrees:nonRef,usableTreeCount:nonRef.length,lowConfidenceTreeCount,outlierFilteredTreeCount,zoneConfidenceScore};
  }
  return {zoneStress:stressFrom75,usableTrees:nonRef,usableTreeCount:nonRef.length,lowConfidenceTreeCount,outlierFilteredTreeCount,zoneConfidenceScore};
}
function irrDecision(hist3,rain,zs,nonRef,opts){
  opts=opts||{};
  const computedAt=opts.computedAt;
  const nowMs=opts.nowMs!=null?opts.nowMs:Date.now();
  const log=typeof opts.log==='function'?opts.log:function(){};
  const history=hist3||[];
  const today=history[0]||'none';
  const yest=history[1]||'none';
  const suppressionWasActiveAtStart=!!(zs.rain_suppression_active&&zs.rain_suppression_start);

  if(zs.recovery_verification_active)return{action:'maintain_recovery_hold',reasoning:'Recovery verification in progress'};

  if(zs.rain_suppression_active&&zs.rain_suppression_start){
    if(zs.pre_rain_twd_norm_avg!=null&&nonRef){
      const curTwds=(nonRef||[]).map(t=>t.twd_night_um).filter(v=>v!=null&&isFinite(v));
      const curAvg=curTwds.length?avg(curTwds):null;
      if(curAvg!=null&&curAvg<zs.pre_rain_twd_norm_avg-15){
        zs.rain_suppression_active=0;
        log('Zone: rain suppression exited — TWD responded');
      }
    }
    if(zs.rain_suppression_active){
      const elh=(nowMs-new Date(zs.rain_suppression_start).getTime())/3600000;
      if(elh>zs.rain_suppression_timeout_h){
        zs.rain_suppression_active=0;
      }else if(today!=='severe'){
        return{action:'maintain_rain_suppression',reasoning:'Rain suppression ('+Math.round(elh)+'h/'+zs.rain_suppression_timeout_h+'h)'};
      }
    }
  }

  if((rain?.daily_mm||0)>=5&&!suppressionWasActiveAtStart){
    zs.rain_suppression_active=1;
    zs.rain_suppression_start=computedAt;
    zs.rain_suppression_timeout_h=rain.daily_mm>=15?72:48;
    const preTwds=(nonRef||[]).map(t=>t.twd_night_um).filter(v=>v!=null&&isFinite(v));
    zs.pre_rain_twd_norm_avg=preTwds.length?round(avg(preTwds),1):null;
    return{action:'maintain_rain_suppression',reasoning:'New rain: '+round(rain.daily_mm,1)+'mm'};
  }

  if(today==='unknown')return{action:'maintain',reasoning:'No reliable dendrometer data — maintain current volume'};

  const severeCount=(nonRef||[]).filter(t=>t.tree_state_v5==='severe').length;
  const quorumSevere=severeCount>=N_TREES_FOR_EMERGENCY;
  const persistSevere=today==='severe'&&yest==='severe';
  if(today==='severe'&&(quorumSevere||persistSevere)){
    return{action:'emergency_irrigate',reasoning:quorumSevere?('Severe: '+N_TREES_FOR_EMERGENCY+'+ trees confirm'):('Severe stress persisted '+DAYS_FOR_SOLO_EMERGENCY+' days')};
  }
  if(today==='severe'){
    if(yest==='significant'||yest==='severe')return{action:'increase_20',reasoning:'Severe stress without emergency quorum — increase 20%'};
    return{action:'increase_10',reasoning:'Severe stress without emergency quorum — increase 10%'};
  }
  if(today==='significant'){
    if(yest==='significant'||yest==='severe')return{action:'increase_20',reasoning:'Significant stress 2 consecutive days'};
    return{action:'increase_10',reasoning:'Significant stress (first day)'};
  }
  const cnt={};for(const l of history)cnt[l]=(cnt[l]||0)+1;
  let d='none';
  for(const [l,c] of Object.entries(cnt)){if(c>=2&&(RANK[l]||0)>(RANK[d]||0))d=l;}
  if(d==='none'){
    if((rain?.rolling7d||0)>20)return{action:'decrease_20',reasoning:'No stress + heavy recent rain (>20mm/7d)'};
    return{action:'decrease_10',reasoning:'No stress ≥2 of 3 days'};
  }
  if(d==='mild')return{action:'maintain',reasoning:'Mild stress ≥2 of 3 days — maintain'};
  if(d==='moderate')return{action:'increase_10',reasoning:'Moderate stress ≥2 of 3 days'};
  return{action:'maintain',reasoning:'Default: maintain current volume'};
}
function dendroThresholdStressLevel(encodedThreshold){
  switch(Math.round(Number(encodedThreshold))){
    case 1: return 'mild';
    case 2: return 'moderate';
    case 3: return 'significant';
    case 4: return 'severe';
    default: return null;
  }
}
function decisionEscalationStress(action,hist3){
  switch(String(action||'')){
    case 'emergency_irrigate': return 'severe';
    case 'increase_20': return 'significant';
    case 'increase_10': {
      const todayStress=(hist3&&hist3.length)?hist3[0]:'none';
      return todayStress==='significant' ? 'significant' : 'moderate';
    }
    default: return null;
  }
}
function applyDendroSchedulePolicy(decision,hist3,schedule){
  if(!decision||!schedule||Number(schedule.enabled)!==1)return decision;
  if(String(schedule.trigger_metric||'').toUpperCase()!=='DENDRO')return decision;
  const requiredStress=dendroThresholdStressLevel(schedule.threshold_kpa);
  if(!requiredStress)return decision;
  const escalationStress=decisionEscalationStress(decision.action,hist3);
  if(!escalationStress|| (RANK[escalationStress]||0) >= (RANK[requiredStress]||0)) return decision;
  return {
    action:'maintain',
    reasoning:`${decision.reasoning} Blocked by DENDRO threshold: requires ${requiredStress} stress or higher.`
  };
}
const CONSTANTS = {
  RANK,
  PHENO_MOD,
  LEVELS,
  MIN_SAMPLES_DAY,
  MIN_SAMPLES_WINDOW,
  LOW_SIGNAL_THRESHOLD_UM,
  JUMP_THRESHOLD_UM,
  N_TREES_FOR_EMERGENCY,
  DAYS_FOR_SOLO_EMERGENCY,
  CALIBRATIONS,
};

module.exports = {
  round,
  avg,
  percentile,
  localHour,
  localTimeStr,
  localDateParts,
  shiftDateIso,
  tzOffsetMinutes,
  localMidnightUtcIso,
  computeZoneDayWindow,
  calibrationForKey,
  detectJumps,
  removeJumps,
  median3,
  extractExtremes,
  computeVPD,
  buildQaFlags,
  computeEnvelope,
  classifyAbsoluteTwd,
  carryForwardState,
  computeAbsoluteDeltaTwdSmoothed,
  computeRDelta5day,
  adjustStress,
  computeR2,
  aggregateZoneStress,
  irrDecision,
  dendroThresholdStressLevel,
  decisionEscalationStress,
  applyDendroSchedulePolicy,
  RANK,
  PHENO_MOD,
  LEVELS,
  MIN_SAMPLES_DAY,
  MIN_SAMPLES_WINDOW,
  LOW_SIGNAL_THRESHOLD_UM,
  JUMP_THRESHOLD_UM,
  N_TREES_FOR_EMERGENCY,
  DAYS_FOR_SOLO_EMERGENCY,
  CALIBRATIONS,
  CONSTANTS,
};
