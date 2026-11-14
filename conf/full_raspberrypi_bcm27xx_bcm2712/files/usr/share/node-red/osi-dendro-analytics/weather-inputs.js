'use strict';
// Provider observations are stored for display. Control is an explicit per-gateway opt-in.
const PROVIDER_IRRIGATION_SETTING_KEY='dendro_provider_irrigation_enabled';
const PROVIDER_SOURCES=new Set(['open_meteo','openagri','provider']);
// Computation timestamps and the diagnostic reuse marker are not new advice.
// Keep the old row (including its freshness timestamp) when all content agrees.
const recommendationColumns=['zone_stress_summary','rainfall_mm','water_delivered_liters','irrigation_action','action_reasoning',
  'rain_suppression_active','recovery_verification_active','vpd_max_kpa','vpd_source','irrigation_window_json',
  'usable_tree_count','low_confidence_tree_count','outlier_filtered_tree_count','zone_confidence_score'];
const adviceJson=alias=>`CASE WHEN json_valid(${alias}.recommendation_json) THEN json_remove(${alias}.recommendation_json,'$.raw_decision.computed_at','$.raw_evidence.analysis.computed_at','$.weather_control.provider_reused_from_computed_at') ELSE ${alias}.recommendation_json END`;
const RECOMMENDATION_CHANGED_WHERE=' WHERE '+[...recommendationColumns.map(c=>`zone_daily_recommendations.${c} IS NOT excluded.${c}`),
  `(${adviceJson('zone_daily_recommendations')}) IS NOT (${adviceJson('excluded')})`].join(' OR ');

async function providerIrrigationEnabled(db,warn){
  try{
    const row=await db.get('SELECT value FROM app_settings WHERE key = ?',[PROVIDER_IRRIGATION_SETTING_KEY]);
    return row?.value === '1';
  }catch(error){
    warn('Dendro provider control setting unreadable: '+String(error&&error.message||error));
    return false;
  }
}

async function createWeatherInputs({db:_db,q,env,node,now:NOW,rain:R,analytics:DA}){
  const providerEnabled=await providerIrrigationEnabled(_db,message=>node.warn(message));
  function s(v){return(v===null||v===undefined)?'NULL':"'"+String(v).replace(/'/g,"''")+"'";}
  function trimToNull(value){
    const normalized=String(value==null?'':value).trim();
    return normalized?normalized:null;
  }
  function normalizeBaseUrl(value){
    const normalized=trimToNull(value);
    return normalized?normalized.replace(/\/+$/,''):null;
  }
  function buildFormBody(fields){
    return Object.entries(fields||{}).map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(value==null?'':String(value))).join('&');
  }
  const requestJson = DA.requestJson;
  async function fetchOpenAgriToken(baseUrl,bearerToken,username,password){
    const staticToken=trimToNull(bearerToken);
    if(staticToken)return staticToken;
    const user=trimToNull(username),pass=trimToNull(password);
    if(!baseUrl||!user||!pass)return null;
    const body=buildFormBody({username:user,password:pass});
    const tokenResp=await requestJson('POST',baseUrl+'/api/v1/auth/token',{
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)},
      body
    });
    return trimToNull(tokenResp&&tokenResp.jwt_token);
  }
  async function fetchOpenAgriWeather(baseUrl,bearerToken,username,password,lat,lon,day,radiusKm){
    if(!baseUrl)return null;
    const token=await fetchOpenAgriToken(baseUrl,bearerToken,username,password);
    if(!token)return null;
    const radius=Number(radiusKm);
    const body=JSON.stringify({
      lat:Number(lat),
      lon:Number(lon),
      start:day,
      end:day,
      variables:['temperature_2m','relative_humidity_2m','precipitation'],
      radius_km:isFinite(radius)&&radius>0?radius:10
    });
    const weatherResp=await requestJson('POST',baseUrl+'/api/v1/history/hourly/',{
      headers:{
        'Authorization':'Bearer '+token,
        'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(body)
      },
      body
    });
    if(!weatherResp||!Array.isArray(weatherResp.data)||!weatherResp.data.length)return null;
    // Rain is known only when at least one hour carries a precipitation value; a
    // temperature-only answer leaves rainfall_mm null (unknown), never 0.
    let precipitationMm=0,precipFound=false,precipHours=0,vpdMax=null,found=false;
    for(const row of weatherResp.data){
      const values=row&&row.values&&typeof row.values==='object'?row.values:{};
      const precip=values.precipitation==null||values.precipitation===''?NaN:Number(values.precipitation);
      if(isFinite(precip)&&precip>=0){
        precipitationMm+=precip;
        precipFound=true;
        precipHours++;
        found=true;
      }
      const v=DA.computeVPD(values.temperature_2m,values.relative_humidity_2m);
      if(v!=null){
        vpdMax=vpdMax==null?v:Math.max(vpdMax,v);
        found=true;
      }
    }
    if(!found)return null;
    return {
      rainfall_mm:precipFound?DA.round(precipitationMm,1):null,
      vpd_max_kpa:vpdMax!=null?DA.round(vpdMax,3):null,
      vpd_source:vpdMax!=null?'openagri':'unavailable',
      rain_source:precipFound?'openagri':null,
      rain_hours:precipHours
    };
  }
  async function fetchOpenMeteoWeather(lat,lon,timezone,day){
    const url='https://archive-api.open-meteo.com/v1/archive?latitude='+encodeURIComponent(lat)+'&longitude='+encodeURIComponent(lon)+'&hourly=temperature_2m,relative_humidity_2m,precipitation&timezone='+encodeURIComponent(timezone||'UTC')+'&start_date='+encodeURIComponent(day)+'&end_date='+encodeURIComponent(day);
    const weatherResp=await requestJson('GET',url);
    const hourly=weatherResp&&weatherResp.hourly;
    if(!hourly)return null;
    const temps=Array.isArray(hourly.temperature_2m)?hourly.temperature_2m:[];
    const rhs=Array.isArray(hourly.relative_humidity_2m)?hourly.relative_humidity_2m:[];
    const precs=Array.isArray(hourly.precipitation)?hourly.precipitation:[];
    const count=Math.max(temps.length,rhs.length,precs.length);
    // Rain is known only when at least one hour carries a precipitation value; a
    // temperature-only answer leaves rainfall_mm null (unknown), never 0.
    let precipitationMm=0,precipFound=false,precipHours=0,vpdMax=null,found=false;
    for(let i=0;i<count;i++){
      const precip=precs[i]==null||precs[i]===''?NaN:Number(precs[i]);
      if(isFinite(precip)&&precip>=0){
        precipitationMm+=precip;
        precipFound=true;
        precipHours++;
        found=true;
      }
      const v=DA.computeVPD(temps[i],rhs[i]);
      if(v!=null){
        vpdMax=vpdMax==null?v:Math.max(vpdMax,v);
        found=true;
      }
    }
    if(!found)return null;
    return {
      rainfall_mm:precipFound?DA.round(precipitationMm,1):null,
      vpd_max_kpa:vpdMax!=null?DA.round(vpdMax,3):null,
      vpd_source:vpdMax!=null?'open_meteo':'unavailable',
      rain_source:precipFound?'open_meteo':null,
      rain_hours:precipHours
    };
  }

  return {async forZone({zone,date:ANALYTICS_DATE,windowStart:WINDOW_START,windowEnd:WINDOW_END}){
    let vpd={available:false,vpd_max_kpa:null,vpd_source:'unavailable'};
    // Pass 1: S2120 weather station (priority over soil sensors)
    const s2120kd=await q(`SELECT MAX(ambient_temperature) AS tm,MIN(relative_humidity) AS rhm FROM device_data dd JOIN weather_station_zones wsz ON wsz.deveui=dd.deveui WHERE wsz.zone_id=${zone.zone_id} AND (SELECT type_id FROM devices WHERE deveui=dd.deveui)='SENSECAP_S2120' AND dd.recorded_at>=${s(WINDOW_START)} AND dd.recorded_at<${s(WINDOW_END)} AND dd.ambient_temperature IS NOT NULL AND dd.relative_humidity IS NOT NULL`);
    if(s2120kd[0]&&s2120kd[0].tm!=null&&s2120kd[0].rhm!=null){
      const v=DA.computeVPD(s2120kd[0].tm,s2120kd[0].rhm);
      if(v!=null)vpd={available:true,vpd_max_kpa:v,vpd_source:'local_sensor'};
    }
    // Pass 2: KIWI/TEKTELIC fallback (only if no S2120 data)
    if(!vpd.available){
      const kd=await q(`SELECT MAX(ambient_temperature) AS tm,MIN(relative_humidity) AS rhm FROM device_data dd JOIN devices dv ON dv.deveui=dd.deveui WHERE dv.irrigation_zone_id=${zone.zone_id} AND dv.type_id IN ('KIWI_SENSOR','TEKTELIC_CLOVER') AND dd.recorded_at>=${s(WINDOW_START)} AND dd.recorded_at<${s(WINDOW_END)} AND dd.ambient_temperature IS NOT NULL AND dd.relative_humidity IS NOT NULL`);
      if(kd[0]&&kd[0].tm!=null&&kd[0].rhm!=null){
        const v=DA.computeVPD(kd[0].tm,kd[0].rhm);
        if(v!=null)vpd={available:true,vpd_max_kpa:v,vpd_source:'local_sensor'};
      }
    }

    let weatherRain=null,weatherRainSource='none',weatherRainHours=null;
    let phenoMod=1.0,zoneTimezone='UTC';
    try{
      const zc=await q(`SELECT latitude,longitude,COALESCE(timezone,'UTC') AS timezone,COALESCE(phenological_stage,'default') AS phenological_stage FROM irrigation_zones WHERE id=${zone.zone_id}`);
      const lat=zc[0]?.latitude,lon=zc[0]?.longitude;
      const phenoStage=zc[0]?.phenological_stage||'default';
      phenoMod=DA.PHENO_MOD[phenoStage]||1.0;
      zoneTimezone=zc[0]?.timezone||'UTC';
      if(lat!=null&&lon!=null){
        const openAgriBaseUrl=normalizeBaseUrl(env.get('OPENAGRI_WEATHER_URL')||env.get('OPENAGRI_WEATHER_BASE_URL')||'');
        const openAgriUsername=env.get('OPENAGRI_WEATHER_USERNAME')||'';
        const openAgriPassword=env.get('OPENAGRI_WEATHER_PASSWORD')||'';
        const openAgriBearerToken=env.get('OPENAGRI_WEATHER_BEARER_TOKEN')||'';
        const openAgriRadiusKm=env.get('OPENAGRI_WEATHER_RADIUS_KM')||10;
        let weather=null;
        if(openAgriBaseUrl){
          try{
            weather=await fetchOpenAgriWeather(openAgriBaseUrl,openAgriBearerToken,openAgriUsername,openAgriPassword,lat,lon,ANALYTICS_DATE,openAgriRadiusKm);
          }catch(e){
            node.warn('OpenAgri weather failed zone '+zone.zone_name+': '+e.message);
          }
        }
        if(!weather){
          weather=await fetchOpenMeteoWeather(lat,lon,zoneTimezone,ANALYTICS_DATE);
        }else if(weather.rainfall_mm==null){
          try{
            const om=await fetchOpenMeteoWeather(lat,lon,zoneTimezone,ANALYTICS_DATE);
            if(om&&om.rainfall_mm!=null)weather={...weather,rainfall_mm:om.rainfall_mm,rain_source:om.rain_source,rain_hours:om.rain_hours};
          }catch(e){node.warn('Open-Meteo rain failed zone '+zone.zone_name+': '+e.message);}
        }
        if(weather){
          weatherRain=weather.rainfall_mm;
          weatherRainSource=weather.rain_source||'none';
          weatherRainHours=weather.rain_hours;
          if(!vpd.available&&weather.vpd_max_kpa!=null){
            vpd={available:true,vpd_max_kpa:weather.vpd_max_kpa,vpd_source:weather.vpd_source||'open_meteo'};
          }
        }
      }
    }catch(e){node.warn('Weather API failed zone '+zone.zone_name+': '+e.message);}
    // A restart reruns the same completed day. Keep its provider observation
    // when this attempt cannot fetch it; resolve control inputs afterward.
    const stored=(await q(`SELECT computed_at,rainfall_mm,vpd_max_kpa,vpd_source,CASE WHEN json_valid(recommendation_json) THEN json_extract(recommendation_json,'$.rain.source') END AS rain_source,CASE WHEN json_valid(recommendation_json) THEN json_extract(recommendation_json,'$.rain.covered_hours') END AS rain_hours FROM zone_daily_recommendations WHERE zone_id=${zone.zone_id} AND date=${s(ANALYTICS_DATE)}`))[0];
    let reusedFrom=null;
    if(weatherRain==null&&PROVIDER_SOURCES.has(stored?.rain_source)&&stored.rainfall_mm!=null){
      weatherRain=stored.rainfall_mm;weatherRainSource=stored.rain_source;weatherRainHours=stored.rain_hours;reusedFrom=stored.computed_at;
    }
    if(!vpd.available&&PROVIDER_SOURCES.has(stored?.vpd_source)&&stored.vpd_max_kpa!=null){
      vpd={available:true,vpd_max_kpa:stored.vpd_max_kpa,vpd_source:stored.vpd_source};reusedFrom=stored.computed_at;
    }
    const envRow=(await q(`SELECT flow_liters FROM zone_daily_environment WHERE zone_id=${zone.zone_id} AND date='${ANALYTICS_DATE}'`))[0];
    const localFlowLiters=envRow?.flow_liters||0;
    // Rolling rain = the seven calendar days ending on ANALYTICS_DATE (zone-local): six prior days
    // from stored recommendations plus today. A missing day (no row, NULL, or rain recorded as
    // unknown) adds nothing and is counted, so the sum is a lower bound and never invents a dry day.
    const ROLLING_FROM=DA.shiftDateIso(ANALYTICS_DATE,-6);
    const rainRecs=await q(`SELECT date,rainfall_mm,CASE WHEN json_valid(recommendation_json) THEN recommendation_json END AS recommendation_json,CASE WHEN json_valid(recommendation_json) THEN json_extract(recommendation_json,'$.rain.daily_status') END AS daily_status FROM zone_daily_recommendations WHERE zone_id=${zone.zone_id} AND date>='${ROLLING_FROM}' AND date<'${ANALYTICS_DATE}'`);
    // The day's rain under the rain-resolution policy (docs/contracts/rainfall/rain-resolution-policy.md):
    // the zone's certified gauge day (a certified 0 mm included), else the provider, else unknown (null,
    // stored as NULL). An uncertified day's received amount is only a lower bound: it may start rain
    // suppression (suppression_mm) but never fills daily_mm or the rolling sum. Plain reads, after the fetch.
    const dayHours=Math.round((Date.parse(WINDOW_END)-Date.parse(WINDOW_START))/3600000);
    const adv=await R.resolveAdviceRain(_db,zone.zone_id,ANALYTICS_DATE,weatherRain!=null?{amountMm:weatherRain,source:weatherRainSource,period:'farm_day',coveredHours:weatherRainHours??null,expectedHours:dayHours}:null,{nowMs:NOW.getTime()});
    function buildRain(adv,rows){
      const rainKnown=adv.amountMm!=null;
      const priorPresent=rows.filter(r=>r.rainfall_mm!=null&&isFinite(Number(r.rainfall_mm))&&r.daily_status!=='unknown');
      return {
        daily_mm:adv.amountMm,
        daily_status:rainKnown?'observed':'unknown',
        rolling7d:DA.round(priorPresent.reduce((sum,r)=>sum+Number(r.rainfall_mm),0)+(adv.amountMm||0),2),
        rolling7d_days_present:priorPresent.length+(rainKnown?1:0),
        rolling7d_window:{from:ROLLING_FROM,to:ANALYTICS_DATE},
        source:adv.source,
        coverage:adv.coverage,
        deveui:adv.deveui,
        lower_bound_mm:adv.lowerBoundMm,
        suppression_mm:R.adviceSuppressionMm(adv),
        reasons:adv.reasons,
        policy_version:adv.policyVersion,
        covered_hours:adv.coveredHours,
        expected_hours:adv.expectedHours,
        warnings:rainKnown?[]:['rain_unknown']
      };
    }
    const rain=buildRain(adv,rainRecs);
    const observedVpd=vpd;
    if(!providerEnabled&&vpd.vpd_source!=='local_sensor')vpd={available:false,vpd_max_kpa:null,vpd_source:'unavailable'};
    const controlRows=providerEnabled?rainRecs:rainRecs.map(row=>{
      const recorded=JSON.parse(row.recommendation_json||'null');
      const control=recorded?.weather_control?.decision_rain||recorded?.rain;
      if(PROVIDER_SOURCES.has(control?.source))return {...row,rainfall_mm:null,daily_status:'unknown'};
      return control&&Object.hasOwn(control,'daily_mm')?{...row,rainfall_mm:control.daily_mm,daily_status:control.daily_status}:row;
    });
    const controlAdvice=providerEnabled?adv:await R.resolveAdviceRain(_db,zone.zone_id,ANALYTICS_DATE,null,{nowMs:NOW.getTime()});
    const decisionRain=providerEnabled?rain:buildRain(controlAdvice,controlRows);
    // The cloud treats this legacy status as permission to count rainfall_mm.
    // Preserve main's decision-rain status while storing the provider observation.
    const observedRain={...rain};
    if(!providerEnabled)rain.daily_status=decisionRain.daily_status;
    const weatherControl={setting_key:PROVIDER_IRRIGATION_SETTING_KEY,provider_irrigation_enabled:providerEnabled,
      observed_rain:observedRain,observed_vpd:observedVpd,decision_vpd:vpd,decision_rain:decisionRain,provider_reused_from_computed_at:reusedFrom};
    return {vpd,observedVpd,rain,decisionRain,weatherControl,localFlowLiters,phenoMod,zoneTimezone};
  }};
}
module.exports={PROVIDER_IRRIGATION_SETTING_KEY,providerIrrigationEnabled,createWeatherInputs,RECOMMENDATION_CHANGED_WHERE};
