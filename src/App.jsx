// ─── RouteOpt App — Full Rewrite ───────────────────────────────
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import CUSTOMERS from "./customers.js";
import {
  Clock, MapPin, Navigation, Building2, RefreshCw, ArrowUp, ArrowDown,
  Search, CheckCircle2, Circle, ChevronRight, Coffee, UtensilsCrossed,
  Zap, Database, Plus, Pencil, Trash2, Download, Upload, X, Save,
  AlertTriangle, Check, Route, Loader2, TrendingDown, Settings
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════
// SECTION 1: UTILS
// ═══════════════════════════════════════════════════════════════

const t2m = (t) => { const [h,m]=t.split(":").map(Number); return h*60+m; };
const m2t = (m) => `${String(Math.floor(m/60)%24).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;

// ハバーサイン直線距離 km（係数1.4で実走行近似）
const haversineKm = (a, b) => {
  const R=6371, dLat=((b.lat-a.lat)*Math.PI)/180, dLng=((b.lng-a.lng)*Math.PI)/180;
  const s=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
};
// フォールバック移動時間 = 直線距離 × 1.4 ÷ 40km/h
const fallbackMins = (a, b) => Math.max(1, Math.round((haversineKm(a,b)*1.4/40)*60));

// スペース区切りのかな/名前で分割してAND検索
const matchQuery = (c, q) => {
  if (!q.trim()) return true;
  const tokens = q.trim().split(/\s+/);
  const target = (c.name + " " + (c.kana||"") + " " + (c.area||"")).toLowerCase();
  return tokens.every(tok => target.includes(tok.toLowerCase()));
};

const defer = (fn) => new Promise(res => setTimeout(() => res(fn()), 0));

// ─── 定数 ───
const DEFAULT_DEPART     = "10:30";
const DEFAULT_STAY       = 20;
const DEFAULT_LUNCH_STAY = 40;
const LS_KEY_MASTER      = "routeopt_master";
const LS_KEY_CACHE       = "routeopt_dist_cache";
const LS_KEY_OFFICE      = "routeopt_office";

// 旧バージョンキーを削除
["routeopt_master_v1","routeopt_master_v2","routeopt_master_v3","routeopt_master_v4","routeopt_master_v5",
 "routeopt_dist_cache_v1","routeopt_dist_cache_v2","routeopt_office_v1"]
  .forEach(k=>{ try{localStorage.removeItem(k);}catch{} });
const VISIT_S = t2m("12:00");
const VISIT_E = t2m("13:00");
const LUNCH_S = t2m("11:45");
const LUNCH_E = t2m("14:00");
const OSRM_BASE = "https://router.project-osrm.org";
const TRAFFIC_BUFFER = 1.5;

const DEPART_OPTIONS = (() => {
  const o=[]; for(let m=t2m("09:00");m<=t2m("16:00");m+=15) o.push(m2t(m)); return o;
})();

// ─── デフォルトオフィス（〒460-0012 愛知県名古屋市中区千代田５丁目１９－５）───
const DEFAULT_OFFICE = {
  id:"office", name:"自社オフィス",
  address:"愛知県名古屋市中区千代田5丁目19-5",
  lat:35.1565, lng:136.9208,
};
const LUNCH_TMPL = { id:"lunch_break", name:"昼食休憩", type:"lunch", stay:DEFAULT_LUNCH_STAY };

const SAMPLE_CUSTOMERS = CUSTOMERS;

// ═══════════════════════════════════════════════════════════════
// SECTION 2: STORAGE
// ═══════════════════════════════════════════════════════════════

const ls = {
  get: (k, def) => { try { const v=localStorage.getItem(k); return v?JSON.parse(v):def; } catch{ return def; } },
  set: (k,v) => { try { localStorage.setItem(k,JSON.stringify(v)); } catch{} },
  del: (k)   => { try { localStorage.removeItem(k); } catch{} },
};

const loadMaster  = () => { const d=ls.get(LS_KEY_MASTER,null); return (d&&d.length>0)?d:SAMPLE_CUSTOMERS; };
const saveMaster  = (d) => ls.set(LS_KEY_MASTER, d);
const loadCache   = () => ls.get(LS_KEY_CACHE, {});
const saveCache   = (c) => ls.set(LS_KEY_CACHE, c);
const loadOffice  = () => ls.get(LS_KEY_OFFICE, DEFAULT_OFFICE);
const saveOffice  = (o) => ls.set(LS_KEY_OFFICE, o);

// 特定顧客IDを含むキャッシュエントリを破棄
const purgeCacheFor = (customerId) => {
  const cache = loadCache();
  const purged = {};
  Object.entries(cache).forEach(([k, v]) => {
    if (!k.includes(customerId)) purged[k] = v;
  });
  saveCache(purged);
};

// ═══════════════════════════════════════════════════════════════
// SECTION 3: GEOCODING
// ═══════════════════════════════════════════════════════════════

// 国土地理院 API: [lng, lat] 順で返るので正しく抽出
const geocodeAddress = async (address) => {
  try {
    const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(address)}`);
    const d = await r.json();
    if (!d?.length) return null;
    const [lng, lat] = d[0].geometry.coordinates; // GeoJSON: [lng, lat]
    return { lat: +lat.toFixed(7), lng: +lng.toFixed(7) };
  } catch { return null; }
};

// ═══════════════════════════════════════════════════════════════
// SECTION 4: OSRM API
// ═══════════════════════════════════════════════════════════════

let _cache = loadCache();

// Table API: N×N 移動時間行列（分）
const fetchOsrmTable = async (nodes) => {
  const key = "t|" + nodes.map(n=>`${n.lng.toFixed(4)},${n.lat.toFixed(4)}`).join("|");
  if (_cache[key]) return _cache[key];
  try {
    const coords = nodes.map(n=>`${n.lng},${n.lat}`).join(";");
    const r = await fetch(`${OSRM_BASE}/table/v1/driving/${coords}?annotations=duration`);
    const d = await r.json();
    if (d.code !== "Ok" || !d.durations) throw 0;
    const mat = d.durations.map((row,i) =>
      row.map((s,j) => s==null
        ? fallbackMins(nodes[i],nodes[j])
        : Math.max(1, Math.round((s / 60) * TRAFFIC_BUFFER))
      )
    );
    // Bug 1 fixed: was saveCache(*cache)
    _cache[key] = mat; saveCache(_cache);
    return mat;
  } catch {
    // Bug 2 fixed: was nodes.map((*,i)=>...)
    return nodes.map((_,i)=>nodes.map((_2,j)=>i===j?0:fallbackMins(nodes[i],nodes[j])));
  }
};

// Route API: GeoJSON ポリライン [[lng,lat],…]
const fetchOsrmGeom = async (a, b) => {
  const key = `g|${a.lng.toFixed(4)},${a.lat.toFixed(4)}|${b.lng.toFixed(4)},${b.lat.toFixed(4)}`;
  if (_cache[key]) return _cache[key];
  try {
    const r = await fetch(`${OSRM_BASE}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
    const d = await r.json();
    if (d.code !== "Ok") throw 0;
    const g = d.routes[0].geometry.coordinates;
    _cache[key] = g; saveCache(_cache);
    return g;
  } catch { return [[a.lng,a.lat],[b.lng,b.lat]]; }
};

// ═══════════════════════════════════════════════════════════════
// SECTION 5: ROUTE OPTIMIZATION
// ═══════════════════════════════════════════════════════════════

// ビットDP（≤9件）— ボトムアップループ実装
const optimizeDP = (custs, priorityId, durMat) => {
  const n = custs.length;
  if (n === 0) return [];
  if (n === 1) return custs;

  let fixed = null, rest = custs;
  if (priorityId) {
    const pi = custs.findIndex(c=>c.id===priorityId);
    if (pi>=0) { fixed=custs[pi]; rest=custs.filter((_,i)=>i!==pi); }
  }

  const m = rest.length;
  const startIdx = fixed ? custs.indexOf(fixed)+1 : 0;
  const remIdx   = rest.map(c=>custs.indexOf(c)+1);
  const INF = 1e9;

  const dp   = Array.from({length:1<<m},()=>new Float64Array(m).fill(INF));
  const prev = Array.from({length:1<<m},()=>new Int8Array(m).fill(-1));

  for (let j=0;j<m;j++) dp[1<<j][j] = durMat[startIdx]?.[remIdx[j]] ?? INF;

  for (let S=1;S<(1<<m);S++) {
    for (let i=0;i<m;i++) {
      if (!(S&(1<<i))||dp[S][i]>=INF) continue;
      for (let j=0;j<m;j++) {
        if (S&(1<<j)) continue;
        const ns=S|(1<<j), c=dp[S][i]+(durMat[remIdx[i]]?.[remIdx[j]]??INF);
        if (c<dp[ns][j]) { dp[ns][j]=c; prev[ns][j]=i; }
      }
    }
  }

  const full=(1<<m)-1;
  let best=INF, lastJ=0;
  for (let j=0;j<m;j++) if(dp[full][j]<best){best=dp[full][j];lastJ=j;}

  const order=[];
  let mask=full, cur=lastJ;
  while(mask>0){ order.push(rest[cur]); const p=prev[mask][cur]; mask^=(1<<cur); cur=p; }
  order.reverse();
  // Bug 4 fixed: was [fixed,…order] (Unicode ellipsis U+2026)
  return fixed?[fixed,...order]:order;
};

// 2-opt（≥10件）
const optimize2opt = (custs, priorityId, durMat) => {
  const n = custs.length;
  if (n===0) return [];
  if (n===1) return custs;

  const unvis = custs.map((c,i)=>({c,idx:i+1}));
  const ord=[];
  if (priorityId) {
    const pi=unvis.findIndex(x=>x.c.id===priorityId);
    if(pi>=0){const[p]=unvis.splice(pi,1);ord.push(p);}
  }
  if(!ord.length){
    let fp=0,mx=-1;
    unvis.forEach((x,p)=>{const t=durMat[0]?.[x.idx]??0;if(t>mx){mx=t;fp=p;}});
    const[f]=unvis.splice(fp,1);ord.push(f);
  }
  while(unvis.length){
    const ci=ord[ord.length-1].idx;
    let np=0,mn=Infinity;
    unvis.forEach((x,p)=>{const t=durMat[ci]?.[x.idx]??Infinity;if(t<mn){mn=t;np=p;}});
    const[ne]=unvis.splice(np,1);ord.push(ne);
  }

  let route=ord.map(x=>x.idx);
  const fixedStart=priorityId?1:0;
  let improved=true, iter=300;
  // Bug 3 fixed: was iter–>0 (U+2013 EN DASH instead of --)
  while(improved && iter-- > 0){
    improved=false;
    for(let i=fixedStart;i<route.length-1;i++){
      for(let j=i+1;j<route.length;j++){
        const pi=i===0?0:route[i-1], pj=j===route.length-1?0:route[j+1];
        const before=(durMat[pi]?.[route[i]]??0)+(durMat[route[j]]?.[pj]??0);
        const after =(durMat[pi]?.[route[j]]??0)+(durMat[route[i]]?.[pj]??0);
        if(after<before-0.5){
          const seg=route.slice(i,j+1).reverse();
          // Bug 4 fixed: was […route.slice(0,i),…seg,…route.slice(j+1)]
          route=[...route.slice(0,i),...seg,...route.slice(j+1)];
          improved=true;
        }
      }
    }
  }
  const map=new Map(ord.map(x=>[x.idx,x.c]));
  return route.map(idx=>map.get(idx)).filter(Boolean);
};

const optimizeRoute = (custs,priorityId,durMat) =>
  custs.length<=9 ? optimizeDP(custs,priorityId,durMat) : optimize2opt(custs,priorityId,durMat);

// ═══════════════════════════════════════════════════════════════
// SECTION 6: LUNCH OPTIMIZATION
// ═══════════════════════════════════════════════════════════════

// travelMins付きノード列で全挿入位置を評価し帰社時刻最短の位置を返す
const bestLunchPosition = (middle, retNode, departTime, lunchStay) => {
  const MIN_L=30, MAX_L=70, n=middle.length;

  const simulate = (ins, lSt) => {
    let cur = t2m(departTime);
    for(let i=0;i<n;i++){
      if(i===ins){
        const la=Math.max(cur,LUNCH_S);
        if(la<LUNCH_S||la+lSt>LUNCH_E) return Infinity;
        cur=la+lSt;
      }
      const c=middle[i];
      let arr=cur+(c.travelMins??0);
      const end=arr+c.stay;
      if((arr>=VISIT_S&&arr<VISIT_E)||(arr<VISIT_S&&end>VISIT_S)) arr=VISIT_E;
      cur=arr+c.stay;
    }
    if(ins===n){
      const la=Math.max(cur,LUNCH_S);
      if(la<LUNCH_S||la+lSt>LUNCH_E) return Infinity;
      cur=la+lSt;
    }
    return cur+(retNode.travelMins??fallbackMins(LUNCH_TMPL,{lat:35.1565,lng:136.9208}));
  };

  let bestIns=Math.min(1,n), bestSt=Math.min(MAX_L,Math.max(MIN_L,lunchStay)), bestT=Infinity;
  for(let ins=0;ins<=n;ins++){
    for(const lSt of [lunchStay,MIN_L,MAX_L]){
      const cSt=Math.min(MAX_L,Math.max(MIN_L,lSt));
      const t=simulate(ins,cSt);
      if(t<bestT){bestT=t;bestIns=ins;bestSt=cSt;}
    }
  }
  if(bestT===Infinity){bestIns=Math.min(1,n);bestSt=Math.min(MAX_L,Math.max(MIN_L,lunchStay));}
  return {insertIdx:bestIns,stay:bestSt};
};

// ═══════════════════════════════════════════════════════════════
// SECTION 7: SCHEDULE ENGINE
// ═══════════════════════════════════════════════════════════════

const calcSchedule = (locations, departTime) => {
  const result=[]; let cursor=t2m(departTime);
  for(let i=0;i<locations.length;i++){
    const loc=locations[i];
    const travelMins=i===0?0:(loc.travelMins??fallbackMins(locations[i-1],loc));
    let arr=i===0?cursor:cursor+travelMins;

    if(loc.type==="customer"){
      if(loc.pinnedTime) arr=Math.max(arr,t2m(loc.pinnedTime));
      const end=arr+loc.stay;
      if((arr>=VISIT_S&&arr<VISIT_E)||(arr<VISIT_S&&end>VISIT_S)) arr=VISIT_E;
    }

    let stay=loc.stay;
    if(loc.type==="lunch"){
      arr=Math.max(arr,LUNCH_S);
      const next=locations[i+1];
      if(next&&next.type==="customer"){
        const ntv=next.travelMins??fallbackMins(loc,next);
        const na=arr+stay+ntv, ne=na+next.stay;
        if((na>=VISIT_S&&na<VISIT_E)||(na<VISIT_S&&ne>VISIT_S)){
          const ext=VISIT_E-ntv-arr;
          if(ext>stay&&ext<=70) stay=Math.floor(ext);
        }
      }
      stay=Math.min(70,Math.max(30,stay));
      if(arr+stay>LUNCH_E) stay=Math.max(30,LUNCH_E-arr);
    }

    const dep=arr+stay; cursor=dep;
    result.push({...loc,stay,arrivalMins:arr,departureMins:dep,arrivalTime:m2t(arr),departureTime:m2t(dep),travelMins});
  }
  return result;
};

// ═══════════════════════════════════════════════════════════════
// SECTION 8: LEAFLET MAP COMPONENTS
// ═══════════════════════════════════════════════════════════════

const loadLeaflet = () => new Promise(res => {
  if(window.L){res();return;}
  if(!document.getElementById("lf-css")){
    const l=document.createElement("link");
    l.id="lf-css";l.rel="stylesheet";
    l.href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(l);
  }
  const s=document.createElement("script");
  s.src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
  s.onload=res; document.head.appendChild(s);
});

// ─── ルートマップ（スクロール/操作切り替え）───
const RouteMap = ({ schedule, priorityId }) => {
  const mapRef=useRef(null), lMapRef=useRef(null), layersRef=useRef([]);
  const [loaded,setLoaded]=useState(!!window.L);
  const [active,setActive]=useState(false);

  useEffect(()=>{
    loadLeaflet().then(()=>setLoaded(true));
  },[]);

  useEffect(()=>{
    if(!loaded||!mapRef.current||lMapRef.current) return;
    const L=window.L;
    const map=L.map(mapRef.current,{center:[35.05,137.05],zoom:11,dragging:false,scrollWheelZoom:false,touchZoom:false});
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap",maxZoom:19}).addTo(map);
    lMapRef.current=map;
    return ()=>{map.remove();lMapRef.current=null;};
  },[loaded]);

  useEffect(()=>{
    const map=lMapRef.current; if(!map) return;
    if(active){map.dragging.enable();map.scrollWheelZoom.enable();map.touchZoom.enable();}
    else{map.dragging.disable();map.scrollWheelZoom.disable();map.touchZoom.disable();}
  },[active]);

  useEffect(()=>{
    if(!loaded||!lMapRef.current) return;
    const L=window.L, map=lMapRef.current;
    layersRef.current.forEach(l=>map.removeLayer(l));
    layersRef.current=[];
    const nodes=schedule.filter(s=>s.type!=="lunch"&&s.type!=="office_return");
    if(!nodes.length) return;
    const LABELS=["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩"];
    const bounds=[];

    const addLine=(coords,color,w,op,dash)=>{
      const ll=coords.map(([g,lt])=>[lt,g]);
      const line=L.polyline(ll,{color,weight:w,opacity:op,dashArray:dash||null,lineJoin:"round",lineCap:"round"}).addTo(map);
      layersRef.current.push(line); ll.forEach(p=>bounds.push(p));
    };

    nodes.forEach((loc,i)=>{
      if(!i) return;
      if(loc.osrmGeom?.length>1) addLine(loc.osrmGeom,"#6366f1",5,0.85,null);
      else addLine([[nodes[i-1].lng,nodes[i-1].lat],[loc.lng,loc.lat]],"#6366f1",3,0.5,"8,5");
    });
    const ret=schedule.find(e=>e.type==="office_return");
    if(ret) ret.osrmGeom?.length>1?addLine(ret.osrmGeom,"#818cf8",4,0.5,"10,6"):null;

    let ci=0;
    nodes.forEach(loc=>{
      const isOfc=loc.type==="office";
      const isPri=loc.type==="customer"&&loc.id===priorityId;
      const col=isOfc?"#1e3a5f":isPri?"#059669":"#4f46e5";
      const lbl=isOfc?"🏢":(LABELS[ci++]??"●");
      const sz=isOfc?40:34;
      const icon=L.divIcon({className:"",html:`<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${col};border:3px solid white;box-shadow:0 3px 10px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;font-size:${isOfc?15:12}px;font-weight:bold;color:white;${isPri?"outline:3px solid #34d399;outline-offset:2px;":""}">${lbl}</div>`,iconSize:[sz,sz],iconAnchor:[sz/2,sz/2],popupAnchor:[0,-sz/2-4]});
      const pop=isOfc?`<strong>自社オフィス</strong><br>出発・帰社`:`${isPri?`<span style="color:#10b981;font-size:10px">⚡ 優先</span><br>`:""}<strong>${loc.name}</strong>${loc.address?`<br><span style="color:#64748b;font-size:11px">${loc.address}</span>`:""}`;
      layersRef.current.push(L.marker([loc.lat,loc.lng],{icon}).bindPopup(pop,{maxWidth:220}).addTo(map));
      bounds.push([loc.lat,loc.lng]);
    });
    if(bounds.length) map.fitBounds(L.latLngBounds(bounds),{padding:[40,40],maxZoom:13});
  },[loaded,schedule,priorityId]);

  const hasOsrm=schedule.some(n=>n.osrmGeom);
  return (
    <div className="rounded-2xl overflow-hidden border border-slate-700/50 shadow-lg">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900/90">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-widest">
          <Navigation size={9}/> Route Map
          <span className={`ml-2 text-[9px] px-1.5 py-0.5 rounded font-bold ${hasOsrm?"bg-emerald-900/60 text-emerald-400":"bg-slate-800 text-slate-600"}`}>
            {hasOsrm?"OSRM実走行":"直線距離×1.4"}
          </span>
        </div>
        <button onClick={()=>setActive(v=>!v)}
          className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all active:scale-95 ${active?"bg-indigo-600 text-white":"bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-white"}`}>
          <Navigation size={10}/>{active?"操作中":"地図を操作"}
        </button>
      </div>
      {!loaded
        ? <div className="flex items-center justify-center bg-slate-900" style={{height:"340px"}}><Loader2 size={24} className="animate-spin text-indigo-500"/></div>
        : <div className="relative">
            <div ref={mapRef} style={{height:"340px",width:"100%"}}/>
            {!active&&<div onClick={()=>setActive(true)} className="absolute inset-0 flex items-end justify-center pb-4 cursor-pointer z-[400]">
              <div className="bg-slate-900/80 backdrop-blur-sm text-slate-300 text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-600/60 flex items-center gap-1.5">
                <Navigation size={11} className="text-indigo-400"/> タップして地図を操作
              </div>
            </div>}
          </div>
      }
      <div className="flex gap-4 px-4 py-2 bg-slate-900/80 text-[10px] text-slate-400 border-t border-slate-800">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-[#1e3a5f] inline-block border border-white/30"/>オフィス</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-indigo-600 inline-block border border-white/30"/>訪問先</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block border border-white/30"/>優先</span>
      </div>
    </div>
  );
};

// ─── ピン設置用ミニマップ（常にdragging有効）───
const PinPickerMap = ({ lat, lng, onPinChange }) => {
  const mapRef=useRef(null), lMapRef=useRef(null), markerRef=useRef(null);
  const [loaded,setLoaded]=useState(!!window.L);

  useEffect(()=>{ loadLeaflet().then(()=>setLoaded(true)); },[]);

  useEffect(()=>{
    if(!loaded||!mapRef.current||lMapRef.current) return;
    const L=window.L;
    const center=(lat&&lng)?[lat,lng]:[35.05,137.05];
    const map=L.map(mapRef.current,{center,zoom:14,zoomControl:true,dragging:true,scrollWheelZoom:true,touchZoom:true});
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap",maxZoom:19}).addTo(map);

    const mkIcon=()=>L.divIcon({className:"",html:`<div style="width:28px;height:28px;border-radius:50%;background:#6366f1;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;"><div style="width:8px;height:8px;border-radius:50%;background:white;"></div></div>`,iconSize:[28,28],iconAnchor:[14,14]});

    if(lat&&lng){
      markerRef.current=L.marker([lat,lng],{icon:mkIcon(),draggable:true}).addTo(map);
      markerRef.current.on("dragend",e=>{ const p=e.target.getLatLng(); onPinChange(p.lat,p.lng); });
    }
    map.on("click",e=>{
      const{lat:la,lng:lg}=e.latlng;
      if(markerRef.current) markerRef.current.setLatLng([la,lg]);
      else{ markerRef.current=L.marker([la,lg],{icon:mkIcon(),draggable:true}).addTo(map); markerRef.current.on("dragend",ev=>{const p=ev.target.getLatLng();onPinChange(p.lat,p.lng);}); }
      onPinChange(la,lg);
    });
    lMapRef.current=map;
    return ()=>{ map.remove(); lMapRef.current=null; markerRef.current=null; };
  },[loaded]);

  return !loaded
    ? <div className="flex items-center justify-center bg-slate-800 rounded-xl" style={{height:"220px"}}><Loader2 size={20} className="animate-spin text-indigo-400"/></div>
    : <div>
        <div ref={mapRef} className="rounded-xl overflow-hidden" style={{height:"220px"}}/>
        <p className="text-[10px] text-slate-500 mt-1.5 flex items-center gap-1"><MapPin size={9}/> タップでピン設置・ドラッグで微調整</p>
      </div>;
};

// ═══════════════════════════════════════════════════════════════
// SECTION 9: UI UTILITIES
// ═══════════════════════════════════════════════════════════════

const Toast = ({ msg, type="success", onClose }) => (
  <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 rounded-2xl shadow-xl text-sm font-semibold backdrop-blur-md border
    ${type==="success"?"bg-emerald-900/90 border-emerald-500/50 text-emerald-200":type==="error"?"bg-red-900/90 border-red-500/50 text-red-200":"bg-slate-800/90 border-slate-600/50 text-slate-200"}`}>
    {type==="success"?<Check size={14}/>:type==="error"?<AlertTriangle size={14}/>:null}
    {msg}
    <button onClick={onClose} className="ml-1 opacity-60 hover:opacity-100"><X size={12}/></button>
  </div>
);

// ═══════════════════════════════════════════════════════════════
// SECTION 10: OFFICE SETTINGS MODAL
// ═══════════════════════════════════════════════════════════════

const OfficeSettingsModal = ({ office, onSave, onClose }) => {
  // Bug 4 fixed: was {…office} (U+2026)
  const [form,setForm]=useState({...office});
  const [geocoding,setGeocoding]=useState(false);
  const [geoStatus,setGeoStatus]=useState(office.lat?"ok":"idle");
  const [tab,setTab]=useState("form");

  const handleGeocode=async()=>{
    if(!form.address.trim()){setGeoStatus("error");return;}
    setGeocoding(true);setGeoStatus("idle");
    const r=await geocodeAddress(form.address);
    setGeocoding(false);
    // Bug 4 fixed: was {…p,…r}
    if(r){setForm(p=>({...p,...r}));setGeoStatus("ok");}else setGeoStatus("error");
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <span className="font-bold text-sm text-white flex items-center gap-2"><Building2 size={14} className="text-indigo-400"/>オフィス設定</span>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={18}/></button>
        </div>
        <div className="flex bg-slate-800/60 mx-5 mt-4 rounded-xl p-1 gap-1">
          {[{key:"form",label:"入力",icon:<Building2 size={11}/>},{key:"map",label:"地図",icon:<MapPin size={11}/>}].map(t=>(
            <button key={t.key} onClick={()=>setTab(t.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${tab===t.key?"bg-indigo-600 text-white":"text-slate-500 hover:text-slate-300"}`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>
        <div className="px-5 py-4 space-y-3 max-h-[55vh] overflow-y-auto">
          {tab==="form"?(
            <>
              <div>
                <label className="text-xs text-slate-400 font-semibold mb-1 block">オフィス名</label>
                {/* Bug 4 fixed: was {…p,name:...} */}
                <input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              </div>
              <div>
                <label className="text-xs text-slate-400 font-semibold mb-1 block">住所</label>
                <div className="flex gap-2">
                  {/* Bug 4 fixed: was {…p,address:...} */}
                  <input value={form.address} onChange={e=>{setForm(p=>({...p,address:e.target.value}));setGeoStatus("idle");}}
                    onKeyDown={e=>e.key==="Enter"&&(e.preventDefault(),handleGeocode())}
                    placeholder="例: 愛知県名古屋市中区千代田5丁目19-5"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder:text-slate-600 min-w-0"/>
                  <button onClick={handleGeocode} disabled={geocoding||!form.address.trim()}
                    className={`flex-shrink-0 flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 disabled:opacity-40 whitespace-nowrap ${geoStatus==="ok"?"bg-emerald-700 text-white":"bg-indigo-600 hover:bg-indigo-500 text-white"}`}>
                    {geocoding?<><Loader2 size={11} className="animate-spin"/>取得中</>:geoStatus==="ok"?<><Check size={11}/>取得済</>:<><MapPin size={11}/>座標取得</>}
                  </button>
                </div>
                {geoStatus==="ok"&&<div className="mt-2 bg-emerald-950/40 border border-emerald-700/30 rounded-lg px-3 py-1.5 text-[11px] text-emerald-300"><Check size={10} className="inline mr-1"/>座標: {form.lat?.toFixed(5)}, {form.lng?.toFixed(5)}</div>}
                {geoStatus==="error"&&<div className="mt-2 bg-red-950/40 border border-red-700/30 rounded-lg px-3 py-1.5 text-[11px] text-red-300"><AlertTriangle size={10} className="inline mr-1"/>住所が見つかりません</div>}
              </div>
            </>
          ):(
            <>
              {/* Bug 4 fixed: was {…p,lat,lng} */}
              <PinPickerMap lat={form.lat} lng={form.lng} onPinChange={(lat,lng)=>{setForm(p=>({...p,lat,lng}));setGeoStatus("ok");}}/>
              {form.lat&&<div className="bg-emerald-950/40 border border-emerald-700/30 rounded-lg px-3 py-1.5 text-[11px] text-emerald-300"><Check size={10} className="inline mr-1"/>ピン: {form.lat.toFixed(5)}, {form.lng.toFixed(5)}</div>}
            </>
          )}
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-400 hover:text-white text-sm font-semibold transition-colors">キャンセル</button>
          <button onClick={()=>{if(!form.lat||!form.lng){alert("座標を取得してください");return;}onSave(form);}} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold flex items-center justify-center gap-1.5 transition-colors"><Save size={13}/>保存</button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// SECTION 11: CUSTOMER FORM MODAL
// ═══════════════════════════════════════════════════════════════

const emptyForm=()=>({id:"",name:"",kana:"",address:"",area:"",defaultStay:20,lat:null,lng:null});

const CustomerFormModal = ({ initial, onSave, onClose }) => {
  // Bug 4 fixed: was {…emptyForm(),…initial,...}
  const [form,setForm]=useState(()=>initial?{...emptyForm(),...initial,lat:initial.lat??null,lng:initial.lng??null}:emptyForm());
  const [geocoding,setGeocoding]=useState(false);
  const [geoStatus,setGeoStatus]=useState(initial?.lat!=null?"ok":"idle");
  const [tab,setTab]=useState("form");
  // Bug 4 fixed: was {…p,[k]:v}
  const set=(k,v)=>setForm(p=>({...p,[k]:v}));

  const handleGeocode=async()=>{
    const addr=form.address.trim(); if(!addr){setGeoStatus("error");return;}
    setGeocoding(true);setGeoStatus("idle");
    const r=await geocodeAddress(addr);
    setGeocoding(false);
    // Bug 4 fixed: was {…p,…r}
    if(r){setForm(p=>({...p,...r}));setGeoStatus("ok");}else setGeoStatus("error");
  };

  const handleSave=()=>{
    if(!form.name.trim()){alert("会社名は必須です");return;}
    if(!form.address.trim()){alert("住所は必須です");return;}
    if(form.lat==null||form.lng==null){alert("座標を取得または地図でピンを設置してください");return;}
    if(initial&&(initial.lat!==form.lat||initial.lng!==form.lng)){purgeCacheFor(form.id);}
    // Bug 4 fixed: was {…form,id:...}
    onSave({...form,id:form.id||`cust_${Date.now()}`,defaultStay:parseInt(form.defaultStay)||20});
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <span className="font-bold text-sm text-white">{initial?"訪問先を編集":"訪問先を追加"}</span>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X size={18}/></button>
        </div>
        <div className="flex bg-slate-800/60 mx-5 mt-4 rounded-xl p-1 gap-1">
          {[{key:"form",label:"入力フォーム",icon:<Building2 size={11}/>},{key:"map",label:"地図でピン設置",icon:<MapPin size={11}/>}].map(t=>(
            <button key={t.key} onClick={()=>setTab(t.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${tab===t.key?"bg-indigo-600 text-white":"text-slate-500 hover:text-slate-300"}`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>
        <div className="px-5 py-4 space-y-3 max-h-[58vh] overflow-y-auto">
          {tab==="form"?(
            <>
              {[{l:"会社名 *",k:"name",t:"text",p:"例: トヨタ自動車 本社"},{l:"かな",k:"kana",t:"text",p:"例: とよたじどうしゃほんしゃ"},{l:"エリア",k:"area",t:"text",p:"例: 豊田市"}].map(f=>(
                <div key={f.k}>
                  <label className="text-xs text-slate-400 font-semibold mb-1 block">{f.l}</label>
                  <input type={f.t} value={form[f.k]} placeholder={f.p} onChange={e=>set(f.k,e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder:text-slate-600"/>
                </div>
              ))}
              <div>
                <label className="text-xs text-slate-400 font-semibold mb-1 block">住所 *</label>
                <div className="flex gap-2">
                  <input type="text" value={form.address} placeholder="例: 愛知県豊田市トヨタ町1番地"
                    onChange={e=>{set("address",e.target.value);setGeoStatus("idle");}}
                    onKeyDown={e=>e.key==="Enter"&&(e.preventDefault(),handleGeocode())}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder:text-slate-600 min-w-0"/>
                  <button onClick={handleGeocode} disabled={geocoding||!form.address.trim()}
                    className={`flex-shrink-0 flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 disabled:opacity-40 whitespace-nowrap ${geoStatus==="ok"?"bg-emerald-700 text-white":"bg-indigo-600 hover:bg-indigo-500 text-white"}`}>
                    {geocoding?<><Loader2 size={11} className="animate-spin"/>取得中</>:geoStatus==="ok"?<><Check size={11}/>取得済</>:<><MapPin size={11}/>座標を取得</>}
                  </button>
                </div>
                {geoStatus==="ok"&&form.lat!=null&&(
                  <div className="mt-2 flex items-center gap-1.5 bg-emerald-950/40 border border-emerald-700/30 rounded-lg px-3 py-1.5">
                    <Check size={11} className="text-emerald-400"/>
                    <span className="text-[11px] text-emerald-300">座標確定: {form.lat.toFixed(5)}, {form.lng.toFixed(5)}</span>
                    <button onClick={()=>setTab("map")} className="ml-auto text-[10px] text-emerald-400 underline">地図で確認</button>
                  </div>
                )}
                {geoStatus==="error"&&<div className="mt-2 bg-red-950/40 border border-red-700/30 rounded-lg px-3 py-1.5 text-[11px] text-red-300 flex items-center gap-1.5"><AlertTriangle size={10}/>住所が見つかりません。地図タブでピンを設置できます。</div>}
                {geoStatus==="idle"&&<p className="mt-1 text-[10px] text-slate-600">住所入力後「座標を取得」、または地図タブでピンを設置</p>}
              </div>
              <div>
                <label className="text-xs text-slate-400 font-semibold mb-1 block">滞在時間（分）</label>
                <input type="number" value={form.defaultStay} onChange={e=>set("defaultStay",e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
              </div>
            </>
          ):(
            <>
              {!form.name.trim()&&<div className="bg-amber-950/30 border border-amber-700/30 rounded-xl px-3 py-2 text-xs text-amber-300 flex items-center gap-1.5"><AlertTriangle size={11}/>先にフォームで会社名を入力してください</div>}
              {/* Bug 4 fixed: was {…p,lat,lng} */}
              <PinPickerMap lat={form.lat} lng={form.lng} onPinChange={(lat,lng)=>{setForm(p=>({...p,lat,lng}));setGeoStatus("ok");}}/>
              {form.lat!=null&&<div className="bg-emerald-950/40 border border-emerald-700/30 rounded-lg px-3 py-1.5 text-[11px] text-emerald-300"><Check size={10} className="inline mr-1"/>ピン: {form.lat.toFixed(5)}, {form.lng.toFixed(5)}</div>}
            </>
          )}
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-400 hover:text-white text-sm font-semibold">キャンセル</button>
          <button onClick={handleSave} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold flex items-center justify-center gap-1.5 transition-colors"><Save size={13}/>保存</button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// SECTION 12: DATABASE VIEW
// ═══════════════════════════════════════════════════════════════

const DatabaseView = ({ customers, onUpdate, onToast }) => {
  const [q,setQ]=useState("");
  const [modal,setModal]=useState(null);
  const [confirm,setConfirm]=useState(null);
  const fileRef=useRef();

  const filtered=useMemo(()=>customers.filter(c=>matchQuery(c,q)),[customers,q]);

  const handleExport=()=>{
    const b=new Blob([JSON.stringify(customers,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download="customers_backup.json"; a.click(); URL.revokeObjectURL(a.href);
    onToast("customers_backup.json をダウンロードしました");
  };
  const handleImport=(e)=>{
    const f=e.target.files?.[0]; if(!f) return;
    const r=new FileReader();
    r.onload=ev=>{
      try{
        const d=JSON.parse(ev.target.result);
        if(!Array.isArray(d)) throw 0;
        // Bug 4 fixed: was […customers]
        if(window.confirm(`${d.length}件。[OK]上書き [キャンセル]追加`)){onUpdate(d);onToast(`${d.length}件で上書き`);}
        else{const m=[...customers];d.forEach(x=>{if(!m.find(c=>c.id===x.id))m.push(x);});onUpdate(m);onToast(`${d.length}件を追加`);}
      }catch{onToast("JSONの読み込みに失敗","error");}
      e.target.value="";
    };
    r.readAsText(f);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button onClick={()=>setModal("add")} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-2 rounded-xl transition-colors"><Plus size={13}/>追加</button>
        <button onClick={handleExport} className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold px-3 py-2 rounded-xl transition-colors"><Download size={13}/>エクスポート</button>
        <button onClick={()=>fileRef.current?.click()} className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold px-3 py-2 rounded-xl transition-colors"><Upload size={13}/>インポート</button>
        <input ref={fileRef} type="file" accept=".json,application/json,text/plain" onChange={handleImport} className="hidden"/>
      </div>
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/>
        <input type="text" value={q} onChange={e=>setQ(e.target.value)} placeholder="スペース区切りでAND検索 例: とよた ほんしゃ"
          className="w-full bg-slate-800/70 border border-slate-700 rounded-xl pl-8 pr-4 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div className="text-xs text-slate-500 flex justify-between"><span>{filtered.length}件 / 全{customers.length}件</span><span className="text-slate-600">localStorageに自動保存</span></div>
      <div className="space-y-2">
        {filtered.length===0&&<div className="text-center py-12 text-slate-600 text-sm">{q?"検索結果なし":"データなし"}</div>}
        {filtered.map(c=>(
          <div key={c.id} className="flex items-center gap-3 bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
            <div className="w-7 h-7 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center flex-shrink-0"><Building2 size={12} className="text-indigo-400"/></div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-100 truncate">{c.name}</div>
              <div className="text-xs text-slate-500 truncate mt-0.5">{c.address||"住所未設定"}</div>
              <div className="text-xs text-slate-600 flex items-center gap-2 mt-0.5">
                {c.area&&<span>{c.area}</span>}
                <span className="text-indigo-400/70">{c.defaultStay}分</span>
                {c.lat!=null?<span className="text-emerald-500/70 flex items-center gap-0.5"><Check size={9}/>座標済</span>:<span className="text-amber-500/70 flex items-center gap-0.5"><AlertTriangle size={9}/>座標未取得</span>}
              </div>
            </div>
            <div className="flex gap-1.5">
              <button onClick={()=>setModal({edit:c})} className="w-7 h-7 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white flex items-center justify-center"><Pencil size={12}/></button>
              <button onClick={()=>setConfirm(c.id)} className="w-7 h-7 rounded-lg bg-slate-700 hover:bg-red-800 text-slate-400 hover:text-red-300 flex items-center justify-center"><Trash2 size={12}/></button>
            </div>
          </div>
        ))}
      </div>
      {/* Bug 4 fixed: was […customers,d] */}
      {modal==="add"&&<CustomerFormModal onSave={d=>{onUpdate([...customers,d]);setModal(null);onToast("追加しました");}} onClose={()=>setModal(null)}/>}
      {modal?.edit&&<CustomerFormModal initial={modal.edit} onSave={d=>{onUpdate(customers.map(c=>c.id===d.id?d:c));setModal(null);onToast("更新しました");}} onClose={()=>setModal(null)}/>}
      {confirm&&(
        <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center gap-2 mb-3"><AlertTriangle size={16} className="text-red-400"/><span className="font-bold text-white">削除の確認</span></div>
            <p className="text-sm text-slate-400 mb-4">「{customers.find(c=>c.id===confirm)?.name}」を削除しますか？</p>
            <div className="flex gap-2">
              <button onClick={()=>setConfirm(null)} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-400 text-sm font-semibold hover:text-white">キャンセル</button>
              <button onClick={()=>{onUpdate(customers.filter(c=>c.id!==confirm));setConfirm(null);onToast("削除しました");}} className="flex-1 py-2.5 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-bold">削除する</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// SECTION 13: LOCATION SELECTOR (STEP 1)
// ═══════════════════════════════════════════════════════════════

const LocationSelector = ({ customers, selected, onToggle, priorityId, onSetPriority, pinnedTimes, onSetPinnedTime, departTime, onDepartChange, onSearch, isOptimizing }) => {
  const [q,setQ]=useState("");
  const [editingTimeId,setEditingTimeId]=useState(null);
  const filtered=useMemo(()=>customers.filter(c=>matchQuery(c,q)),[customers,q]);
  const noCoordSelected=selected.filter(id=>{ const c=customers.find(x=>x.id===id); return c&&(c.lat==null||c.lng==null); });
  const canSearch=selected.length>0&&noCoordSelected.length===0&&!isOptimizing;

  return (
    <>
    <div className="space-y-4">
      <div className="bg-slate-800/60 rounded-2xl border border-slate-700/50 p-4">
        <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1.5"><Clock size={11} className="text-indigo-400"/>出発時刻</label>
        <select value={departTime} onChange={e=>onDepartChange(e.target.value)}
          className="w-full bg-slate-900 border border-slate-600 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          {DEPART_OPTIONS.map(t=><option key={t} value={t}>{t} 出発</option>)}
        </select>
      </div>
      <div className="flex items-start gap-2 bg-indigo-950/40 border border-indigo-800/40 rounded-xl p-3">
        <TrendingDown size={14} className="text-indigo-400 mt-0.5 flex-shrink-0"/>
        <div className="text-xs text-indigo-300/80 leading-relaxed">
          <strong className="text-indigo-200">最適化:</strong> 9件以内→ビットDP（厳密解）/ 10件以上→2-opt。昼食は全パターン探索で帰社時刻最短を選択。優先⚡は先頭固定。
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"/>
          <input type="text" value={q} onChange={e=>setQ(e.target.value)} placeholder="スペース区切りでAND検索…"
            className="w-full bg-slate-800/70 border border-slate-700 rounded-xl pl-8 pr-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
        </div>
        <span className="text-xs text-indigo-400 font-bold whitespace-nowrap">{selected.length}件選択</span>
      </div>
      <div className="flex gap-3 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><CheckCircle2 size={10} className="text-indigo-400"/>訪問先に追加</span>
        <span className="flex items-center gap-1"><Zap size={10} className="text-emerald-400"/>最優先（先頭固定）</span>
      </div>
      <div className="space-y-2">
        {filtered.length===0&&<div className="text-center py-8 text-slate-600 text-sm">該当なし</div>}
        {filtered.map(loc=>{
          const isSel=selected.includes(loc.id), isPri=priorityId===loc.id, noC=loc.lat==null||loc.lng==null;
          const pinTime=pinnedTimes[loc.id]??null;
          return (
            <div key={loc.id} className={`flex items-center gap-2 rounded-xl border px-3 py-3 transition-all ${noC?"border-amber-700/40 bg-amber-950/10 opacity-75":isPri?"border-emerald-500/60 bg-emerald-950/25":isSel?"border-indigo-500/50 bg-indigo-900/20":"border-slate-700/50 bg-slate-800/40"}`}>
              <button onClick={()=>!noC&&onToggle(loc.id)} className={`flex-shrink-0 ${noC?"text-slate-700 cursor-not-allowed":isSel||isPri?"text-indigo-400":"text-slate-600 hover:text-slate-400"}`}>
                {isSel||isPri?<CheckCircle2 size={19}/>:<Circle size={19}/>}
              </button>
              <div className="flex-1 min-w-0 cursor-pointer" onClick={()=>!noC&&onToggle(loc.id)}>
                <div className={`text-sm font-semibold ${isPri?"text-emerald-100":"text-slate-100"}`}>{loc.name}</div>
                <div className="text-xs mt-0.5 flex items-center gap-1.5 flex-wrap">
                  {noC?<span className="text-amber-500 flex items-center gap-0.5"><AlertTriangle size={9}/>座標未取得</span>:<>{loc.area&&<span className="text-slate-500">{loc.area}</span>}{loc.address&&<span className="text-slate-600 truncate max-w-[140px]">{loc.address}</span>}{isPri&&<span className="text-emerald-400 font-semibold flex items-center gap-0.5"><Zap size={9}/>最優先</span>}{pinTime&&<span className="text-amber-400 font-semibold flex items-center gap-0.5"><Clock size={9}/>{pinTime}指定</span>}</>}
                </div>
              </div>
              <div className="flex-shrink-0 flex items-center gap-1">
                {!noC&&<button onClick={()=>onSetPriority(loc.id)} className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${isPri?"bg-emerald-500 text-white":"bg-slate-700 text-slate-400 hover:bg-emerald-600/70 hover:text-white"}`}><Zap size={11}/>優先</button>}
                {!noC&&isSel&&(
                  editingTimeId===loc.id
                    ?<input type="time" autoFocus defaultValue={pinTime??""}
                        className="w-24 bg-slate-800 border border-amber-500 rounded-lg px-1.5 py-1 text-xs text-white focus:outline-none"
                        onChange={e=>onSetPinnedTime(loc.id,e.target.value||null)}
                        onBlur={()=>setEditingTimeId(null)}/>
                    :<button onClick={()=>setEditingTimeId(loc.id)}
                        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${pinTime?"bg-amber-500 text-white":"bg-slate-700 text-slate-400 hover:bg-amber-600/70 hover:text-white"}`}>
                        <Clock size={11}/>{pinTime??"時刻"}
                        {pinTime&&<span className="ml-0.5 opacity-70 hover:opacity-100" onClick={e=>{e.stopPropagation();onSetPinnedTime(loc.id,null);}}>×</span>}
                      </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{height:"80px"}}/>
    </div>
    <div className="sticky bottom-0 z-20 px-4 pb-4 pt-2 bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent pointer-events-none">
      <div className="pointer-events-auto space-y-1">
        {selected.length===0&&<p className="text-center text-xs text-slate-500">1件以上を選択してください</p>}
        {noCoordSelected.length>0&&selected.length>0&&<p className="text-center text-xs text-amber-500 flex items-center justify-center gap-1"><AlertTriangle size={11}/>座標未取得の訪問先があります。マスターで住所を登録してください。</p>}
        <button onClick={onSearch} disabled={!canSearch}
          className={`w-full flex items-center justify-center gap-2 py-4 rounded-2xl text-sm font-bold tracking-wide transition-all active:scale-[0.98] shadow-xl ${canSearch?"bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-900/60":"bg-slate-800 text-slate-600 cursor-not-allowed"}`}>
          {isOptimizing?<><Loader2 size={15} className="animate-spin"/>最適化中…</>:<><Search size={15}/>ルートを最適化して検索<ChevronRight size={15} className="ml-1"/></>}
        </button>
      </div>
    </div>
    </>
  );
};

// ═══════════════════════════════════════════════════════════════
// SECTION 14: SCHEDULE ROW (STEP 2)
// ═══════════════════════════════════════════════════════════════

const ScheduleRow = ({ entry, index, onStayChange, onMoveUp, onMoveDown, canUp, canDown, isPriority, custLabel, usedFallback }) => {
  const isOffice=entry.type==="office", isReturn=entry.type==="office_return", isOfficeAny=isOffice||isReturn;
  const isLunch=entry.type==="lunch";
  const isLunchAdj=entry.type==="customer"&&entry.arrivalMins===VISIT_E;

  const badge=isLunch?<UtensilsCrossed size={11}/>:isOfficeAny?<Building2 size={11}/>:custLabel;
  const cardBg=isLunch?"border-amber-500/60 bg-amber-950/30":isOfficeAny?"border-slate-600/50 bg-slate-800/60":isPriority?"border-emerald-500/60 bg-emerald-950/30":isLunchAdj?"border-orange-500/60 bg-orange-950/25":"border-indigo-500/30 bg-slate-800/35";
  const badgeBg=isLunch?"bg-amber-600":isOfficeAny?"bg-slate-600":isPriority?"bg-emerald-600":"bg-indigo-600";

  return (
    <div className={`relative rounded-xl border p-3.5 ${cardBg}`}>
      {isLunchAdj&&!isPriority&&<div className="absolute -top-2.5 left-3 bg-orange-500 text-white text-[8px] font-bold px-2 py-0.5 rounded-full">⚠ 昼休み後に自動調整</div>}
      {isPriority&&<div className="absolute -top-2.5 right-3 flex items-center gap-0.5 bg-emerald-500 text-white text-[8px] font-bold px-2 py-0.5 rounded-full"><Zap size={8}/>優先訪問</div>}
      <div className="flex items-start gap-2.5">
        <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${badgeBg} text-white`}>{badge}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            {isLunch?<UtensilsCrossed size={12} className="text-amber-400"/>:isOfficeAny?<Building2 size={12} className="text-slate-400"/>:<MapPin size={12} className={isPriority?"text-emerald-400":"text-indigo-400"}/>}
            <span className={`text-sm font-semibold truncate ${isPriority?"text-emerald-100":"text-slate-100"}`}>{isReturn?"自社オフィス":entry.name}</span>
            {isReturn&&<span className="text-[9px] text-slate-500 bg-slate-700/60 px-1.5 py-0.5 rounded font-semibold">帰社</span>}
            {isPriority&&<Zap size={11} className="text-emerald-400 flex-shrink-0"/>}
          </div>
          {!isLunch&&entry.travelMins>0&&(
            <div className={`flex items-center gap-1 text-[11px] mb-1.5 ${usedFallback?"text-amber-600":"text-slate-500"}`}>
              <Navigation size={9}/><span>移動 {entry.travelMins}分{usedFallback?" (直線×1.4)":""}</span>
            </div>
          )}
          {entry.type==="customer"&&entry.address&&<div className="text-[10px] text-slate-600 truncate mb-1.5 flex items-center gap-1"><MapPin size={8} className="text-slate-700"/>{entry.address}</div>}
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className="flex items-center gap-1 bg-slate-700/60 rounded-lg px-2 py-0.5">
              <Clock size={9} className={isLunch?"text-amber-400":isPriority?"text-emerald-400":"text-indigo-400"}/>
              <span className="text-slate-300">{isLunch?"開始":isReturn?"帰着":"到着"} <strong className="text-white">{entry.arrivalTime}</strong></span>
            </span>
            {!isOffice&&!isReturn&&<span className="flex items-center gap-1 bg-slate-700/60 rounded-lg px-2 py-0.5">
              <Clock size={9} className="text-slate-500"/>
              <span className="text-slate-300">{isLunch?"終了":"出発"} <strong className="text-white">{entry.departureTime}</strong></span>
            </span>}
          </div>
          {!isOfficeAny&&<div className="flex items-center gap-2 mt-2">
            <span className="text-[11px] text-slate-500">{isLunch?"休憩:":"滞在:"}</span>
            <button onClick={()=>onStayChange(index,-10)} className="w-6 h-6 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-sm">−</button>
            <span className={`text-sm font-semibold w-11 text-center ${isLunch?"text-amber-300":isPriority?"text-emerald-300":"text-indigo-300"}`}>{entry.stay}分</span>
            <button onClick={()=>onStayChange(index,10)} className="w-6 h-6 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-bold flex items-center justify-center text-sm">＋</button>
          </div>}
        </div>
        {!isOfficeAny&&<div className="flex flex-col gap-1">
          <button onClick={()=>onMoveUp(index)} disabled={!canUp} className="w-6 h-6 rounded-lg bg-slate-700 hover:bg-indigo-600 disabled:opacity-20 disabled:cursor-not-allowed text-white flex items-center justify-center"><ArrowUp size={12}/></button>
          <button onClick={()=>onMoveDown(index)} disabled={!canDown} className="w-6 h-6 rounded-lg bg-slate-700 hover:bg-indigo-600 disabled:opacity-20 disabled:cursor-not-allowed text-white flex items-center justify-center"><ArrowDown size={12}/></button>
        </div>}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// SECTION 15: ROUTE RESULT (STEP 2)
// ═══════════════════════════════════════════════════════════════

const RouteResult = ({ schedule, priorityId, usedFallback, onStayChange, onMove, onBack }) => {
  const custN=schedule.filter(e=>e.type==="customer").length;
  const total=schedule.reduce((s,e)=>s+(e.type!=="lunch"?(e.travelMins||0):0),0);
  const retEnt=schedule.find(e=>e.type==="office_return");
  const endTime=retEnt?.arrivalTime??schedule[schedule.length-1]?.arrivalTime??"–:–";
  const last=schedule.length-1;
  const LABELS=["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩"];
  let ci=0;
  const custLabels=schedule.map(e=>e.type==="customer"?LABELS[ci++]??ci:null);

  return (
    <div className="space-y-4">
      {usedFallback&&<div className="flex items-start gap-2 bg-amber-950/30 border border-amber-700/30 rounded-xl p-3 text-xs text-amber-300">
        <AlertTriangle size={13} className="flex-shrink-0 mt-0.5"/>
        <span>OSRM APIに接続できなかったため、直線距離×1.4係数のフォールバック値で計算しています。実際の走行時間と差が生じる場合があります。</span>
      </div>}
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold border bg-emerald-950/30 border-emerald-700/30 text-emerald-300">
        <Check size={12}/>昼食: 全挿入位置を探索し帰社時刻が最短になる位置を選択
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[{l:"訪問件数",v:`${custN}件`,i:<MapPin size={12} className="text-indigo-400"/>},{l:"総移動時間",v:`${total}分`,i:<Navigation size={12} className="text-indigo-400"/>},{l:"帰社予定",v:endTime,i:<Clock size={12} className="text-indigo-400"/>}].map(s=>(
          <div key={s.l} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3 text-center">
            <div className="flex justify-center mb-1">{s.i}</div>
            <div className="text-sm font-bold text-white">{s.v}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{s.l}</div>
          </div>
        ))}
      </div>
      <RouteMap schedule={schedule} priorityId={priorityId}/>
      <div>
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2.5 flex items-center gap-1.5">
          <Coffee size={10} className="text-amber-400"/>訪問スケジュール
          <div className="ml-auto flex items-center gap-2 text-[9px] font-normal normal-case tracking-normal">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded border border-emerald-500 bg-emerald-950/40 inline-block"/>優先</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded border border-amber-500 bg-amber-950/40 inline-block"/>昼食</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded border border-orange-500 bg-orange-950/30 inline-block"/>時間ずれ</span>
          </div>
        </div>
        <div className="space-y-2">
          {schedule.map((entry,i)=>(
            <ScheduleRow key={entry.id+"-"+i} entry={entry} index={i}
              isPriority={entry.type==="customer"&&entry.id===priorityId}
              custLabel={custLabels[i]}
              usedFallback={usedFallback&&!entry.osrmGeom&&entry.travelMins>0}
              onStayChange={onStayChange}
              onMoveUp={(idx)=>onMove(idx,-1)} onMoveDown={(idx)=>onMove(idx,1)}
              canUp={i>1} canDown={i<last-1}
            />
          ))}
        </div>
      </div>
      <button onClick={onBack} className="w-full py-3 rounded-2xl border border-slate-600 text-slate-400 hover:text-white hover:bg-slate-800 text-sm font-semibold transition-colors">← 地点選択に戻る</button>
      <p className="text-[10px] text-slate-700 text-center pb-4">顧客訪問禁止 12:00〜13:00 ／ 昼食ウィンドウ 11:45〜14:00</p>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// SECTION 16: PWA INSTALL PROMPT
// ═══════════════════════════════════════════════════════════════

const InstallPrompt = () => {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [show, setShow] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [iosOpen, setIosOpen] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    if (localStorage.getItem("pwa-dismissed")) return;

    const ios = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
    if (ios) { setIsIOS(true); setShow(true); return; }

    const handler = (e) => { e.preventDefault(); setDeferredPrompt(e); setShow(true); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const dismiss = () => { setShow(false); localStorage.setItem("pwa-dismissed", "1"); };

  const install = async () => {
    if (isIOS) { setIosOpen(true); return; }
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    if (outcome === "accepted") setShow(false);
  };

  if (!show) return null;

  return (
    <>
      <div className="fixed bottom-0 left-0 right-0 z-50 px-3 pb-safe-area-inset-bottom" style={{paddingBottom:"max(12px,env(safe-area-inset-bottom))"}}>
        <div className="max-w-xl mx-auto bg-slate-900/95 backdrop-blur-md border border-indigo-500/40 rounded-2xl shadow-2xl shadow-indigo-900/40 px-4 py-3 mb-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0 shadow-lg">
              <Navigation size={22} className="text-white"/>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white leading-tight">ルート最適化ツール</p>
              <p className="text-[11px] text-slate-400 mt-0.5">ホーム画面に追加するとオフラインでも使用可</p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button onClick={dismiss} className="px-2.5 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-300 transition-colors">後で</button>
              <button onClick={install} className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors active:scale-95">
                {isIOS ? "追加方法" : "追加"}
              </button>
            </div>
          </div>
        </div>
      </div>
      {iosOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center p-4" onClick={()=>setIosOpen(false)}>
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl p-6" onClick={e=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center"><Navigation size={18} className="text-white"/></div>
                <span className="font-bold text-sm text-white">ホーム画面に追加</span>
              </div>
              <button onClick={()=>setIosOpen(false)} className="text-slate-500 hover:text-white"><X size={18}/></button>
            </div>
            <ol className="space-y-3">
              {[
                { n:1, text:"Safari下部の「共有」ボタン（□↑）をタップ" },
                { n:2, text:"メニューを下にスクロールし「ホーム画面に追加」をタップ" },
                { n:3, text:"右上の「追加」をタップして完了" },
              ].map(s=>(
                <li key={s.n} className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{s.n}</span>
                  <span className="text-sm text-slate-300 leading-relaxed">{s.text}</span>
                </li>
              ))}
            </ol>
            <button onClick={()=>{setIosOpen(false);dismiss();}} className="w-full mt-5 py-2.5 rounded-xl border border-slate-600 text-slate-400 text-sm font-semibold hover:text-white transition-colors">閉じる</button>
          </div>
        </div>
      )}
    </>
  );
};

// ═══════════════════════════════════════════════════════════════
// SECTION 17: MAIN APP
// ═══════════════════════════════════════════════════════════════

export default function App() {
  const [tab,setTab]           = useState("route");
  const [step,setStep]         = useState("select");
  const [selectedIds,setSelectedIds] = useState([]);
  const [priorityId,setPriorityId]   = useState(null);
  const [pinnedTimes,setPinnedTimes] = useState({});
  const [departTime,setDepartTime]   = useState(DEFAULT_DEPART);
  const [routeLocations,setRouteLocations] = useState([]);
  const [isOptimizing,setIsOptimizing]     = useState(false);
  const [usedFallback,setUsedFallback]     = useState(false);
  const [showOfficeSetting,setShowOfficeSetting] = useState(false);

  const [customers,setCustomers] = useState(()=>[...loadMaster()].sort((a,b)=>(a.kana||a.name).localeCompare(b.kana||b.name,"ja")));
  const [office,setOffice]       = useState(loadOffice);
  const [toast,setToast]         = useState(null);

  useEffect(()=>saveMaster(customers),[customers]);
  useEffect(()=>saveOffice(office),[office]);

  const showToast=useCallback((msg,type="success")=>{
    setToast({msg,type}); setTimeout(()=>setToast(null),3500);
  },[]);

  const handleToggle=useCallback((id)=>{
    // Bug 4 fixed: was […p,id]
    setSelectedIds(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
    setPriorityId(p=>p===id?null:p);
  },[]);

  const handleSetPriority=useCallback((id)=>{
    setPriorityId(p=>p===id?null:id);
    // Bug 4 fixed: was […p,id]
    setSelectedIds(p=>p.includes(id)?p:[...p,id]);
  },[]);

  const handleSetPinnedTime=useCallback((id,time)=>{
    setPinnedTimes(prev=>time?{...prev,[id]:time}:Object.fromEntries(Object.entries(prev).filter(([k])=>k!==id)));
    setSelectedIds(p=>time&&!p.includes(id)?[...p,id]:p);
  },[]);

  // Bug 4 fixed: was {…office,...}
  const officeNode = useMemo(()=>({ ...office, id:"office", type:"office", stay:0 }),[office]);

  // TSPTW-DP: 時刻指定あり・≤9件の完全最適化
  const tsptw_dp = useCallback((custs,officeNode,durMat,tableNodes,pinnedTimes,priorityId,departTime)=>{
    const n=custs.length;
    const nodeIdx=new Map(tableNodes.map((nd,i)=>[nd.id,i]));
    const getT=(a,b)=>{const ai=nodeIdx.get(a.id)??-1,bi=nodeIdx.get(b.id)??-1;return(ai>=0&&bi>=0&&durMat[ai]?.[bi]!=null)?durMat[ai][bi]:fallbackMins(a,b);};
    const applyArr=(c,arr)=>{
      if(pinnedTimes[c.id])arr=Math.max(arr,t2m(pinnedTimes[c.id]));
      const end=arr+c.stay;
      if((arr>=VISIT_S&&arr<VISIT_E)||(arr<VISIT_S&&end>VISIT_S))arr=VISIT_E;
      return arr;
    };
    const INF=1e9,depart=t2m(departTime);
    const dp=Array.from({length:1<<n},()=>new Float64Array(n).fill(INF));
    const prev=Array.from({length:1<<n},()=>new Int8Array(n).fill(-1));
    const priorIdx=priorityId&&!pinnedTimes[priorityId]?custs.findIndex(c=>c.id===priorityId):-1;
    const initVisit=(i)=>{const c=custs[i];dp[1<<i][i]=applyArr(c,depart+getT(officeNode,c))+c.stay;};
    if(priorIdx>=0)initVisit(priorIdx);else for(let i=0;i<n;i++)initVisit(i);
    for(let mask=1;mask<(1<<n);mask++){
      for(let i=0;i<n;i++){
        if(!(mask&(1<<i))||dp[mask][i]>=INF)continue;
        if(priorIdx>=0&&!(mask&(1<<priorIdx)))continue;
        for(let j=0;j<n;j++){
          if(mask&(1<<j))continue;
          const c=custs[j];
          const arr=applyArr(c,dp[mask][i]+getT(custs[i],c));
          const dep=arr+c.stay,nm=mask|(1<<j);
          if(dep<dp[nm][j]){dp[nm][j]=dep;prev[nm][j]=i;}
        }
      }
    }
    const full=(1<<n)-1;
    let best=INF,lastJ=0;
    for(let j=0;j<n;j++){const ret=dp[full][j]+getT(custs[j],officeNode);if(ret<best){best=ret;lastJ=j;}}
    const order=[];let mask=full,cur=lastJ;
    while(mask>0){order.push(custs[cur]);const p=prev[mask][cur];mask^=(1<<cur);cur=p;}
    order.reverse();return order;
  },[]);

  // 2フェーズ法: 時刻指定あり・≥10件（貪欲割り当て＋窓内2-opt）
  const two_phase_route = useCallback((custs,officeNode,durMat,tableNodes,pinnedTimes,priorityId,departTime)=>{
    const nodeIdx=new Map(tableNodes.map((nd,i)=>[nd.id,i]));
    const getT=(a,b)=>{const ai=nodeIdx.get(a.id)??-1,bi=nodeIdx.get(b.id)??-1;return(ai>=0&&bi>=0&&durMat[ai]?.[bi]!=null)?durMat[ai][bi]:fallbackMins(a,b);};
    const pinned=custs.filter(c=>pinnedTimes[c.id]).sort((a,b)=>t2m(pinnedTimes[a.id])-t2m(pinnedTimes[b.id]));
    let flexible=custs.filter(c=>!pinnedTimes[c.id]);
    if(priorityId&&!pinnedTimes[priorityId]){const pi=flexible.findIndex(c=>c.id===priorityId);if(pi>0)flexible=[flexible[pi],...flexible.filter((_,i)=>i!==pi)];}
    const EOD=t2m("20:00");
    const milestones=[{node:officeNode,time:t2m(departTime)},...pinned.map(c=>({node:c,time:t2m(pinnedTimes[c.id])})),{node:{...officeNode,id:"office_return"},time:EOD}];
    const windowSets=[];let remaining=[...flexible];
    for(let wi=0;wi<milestones.length-1;wi++){
      const ms=milestones[wi],me=milestones[wi+1];
      let curPos=ms.node,curTime=ms.time+(wi>0?(ms.node.stay??DEFAULT_STAY):0);
      const lunchReserve=(me.time>LUNCH_S&&curTime<LUNCH_E)?DEFAULT_LUNCH_STAY+10:0;
      const wSet=[];
      if(wi===0&&remaining.length>0&&remaining[0].id===priorityId){
        const pc=remaining[0];
        if(getT(curPos,pc)+pc.stay+getT(pc,me.node)+lunchReserve<=me.time-curTime){wSet.push(pc);curTime+=getT(curPos,pc)+pc.stay;curPos=pc;remaining=remaining.slice(1);}
      }
      let added=true;
      while(added&&remaining.length>0){
        added=false;
        const budget=me.time-curTime-getT(curPos,me.node)-lunchReserve;
        let bestIdx=-1,bestT=Infinity;
        for(let k=0;k<remaining.length;k++){const c=remaining[k],tTo=getT(curPos,c),tAway=getT(c,me.node);if(tTo+c.stay+tAway<=budget&&tTo<bestT){bestT=tTo;bestIdx=k;}}
        if(bestIdx>=0){const c=remaining[bestIdx];wSet.push(c);curTime+=getT(curPos,c)+c.stay;curPos=c;remaining=remaining.filter((_,i)=>i!==bestIdx);added=true;}
      }
      windowSets.push(wSet);
    }
    const route=[];
    for(let wi=0;wi<windowSets.length;wi++){
      const wCusts=windowSets[wi];
      const opt=wCusts.length>1?optimize2opt(wCusts,wi===0?priorityId:null,durMat):wCusts;
      route.push(...opt);
      if(wi<pinned.length)route.push(pinned[wi]);
    }
    let curPos2=route.length>0?route[route.length-1]:officeNode;
    while(remaining.length>0){let bi=0,bt=Infinity;for(let k=0;k<remaining.length;k++){const t=getT(curPos2,remaining[k]);if(t<bt){bt=t;bi=k;}}route.push(remaining[bi]);curPos2=remaining[bi];remaining=remaining.filter((_,i)=>i!==bi);}
    return route;
  },[]);

  const handleSearch = useCallback(async () => {
    setIsOptimizing(true);
    setUsedFallback(false);
    try {
      // Bug 4 fixed: was {…c,...} and […custs]
      const custs = customers.filter(c=>selectedIds.includes(c.id)).map(c=>({...c,type:"customer",stay:c.defaultStay??DEFAULT_STAY}));
      const tableNodes = [officeNode, ...custs];

      // Bug 5 & 6 fixed: removed double-call and unused isFallback variable
      const durMat = await fetchOsrmTable(tableNodes);

      // STEP2: ルート最適化（defer でブラウザフリーズ防止）
      const hasPinned=custs.some(c=>pinnedTimes[c.id]);
      let optimized = await defer(()=>{
        if(!hasPinned) return optimizeRoute(custs,priorityId,durMat);
        return custs.length<=9
          ? tsptw_dp(custs,officeNode,durMat,tableNodes,pinnedTimes,priorityId,departTime)
          : two_phase_route(custs,officeNode,durMat,tableNodes,pinnedTimes,priorityId,departTime);
      });

      // STEP3: OSRM ポリライン並列取得
      const retNode = {...officeNode,id:"office_return",type:"office_return"};
      const fullNodes = [officeNode,...optimized,retNode];
      const geoms = await Promise.all(fullNodes.map(async(n,i)=>i===0?null:fetchOsrmGeom(fullNodes[i-1],n)));

      // STEP4: travelMins・osrmGeom 付加
      const tableIdx = new Map(tableNodes.map((n,i)=>[n.id,i]));
      const withMeta = fullNodes.map((node,i)=>{
        if(i===0) return node;
        const pn=fullNodes[i-1], pi=tableIdx.get(pn.id)??-1, ci=tableIdx.get(node.id)??-1;
        const tm=(pi>=0&&ci>=0&&durMat[pi]?.[ci]!=null)?durMat[pi][ci]:fallbackMins(pn,node);
        return {...node,travelMins:tm,osrmGeom:geoms[i],pinnedTime:pinnedTimes[node.id]??null};
      });

      const middle=withMeta.slice(1,withMeta.length-1);
      const retMeta=withMeta[withMeta.length-1];

      // STEP5: 逆順でtravelMins再計算 → 逆順に基づいた昼食位置探索
      const nodeTableIdx=(n)=>n.type==="office_return"?tableIdx.get("office")??-1:tableIdx.get(n.id)??-1;
      const tmBetween=(a,b)=>{const ai=nodeTableIdx(a),bi=nodeTableIdx(b);return(ai>=0&&bi>=0&&durMat[ai]?.[bi]!=null)?durMat[ai][bi]:fallbackMins(a,b);};

      let prevRev=withMeta[0];
      const reversedMiddle=[...middle].reverse().map(node=>{
        const tm=tmBetween(prevRev,node); prevRev=node; return {...node,travelMins:tm};
      });
      const recomputedRet={...retMeta,travelMins:tmBetween(prevRev,retMeta)};

      const {insertIdx,stay:lSt}=await defer(()=>bestLunchPosition(reversedMiddle,recomputedRet,departTime,DEFAULT_LUNCH_STAY));

      const withLunch=[
        ...reversedMiddle.slice(0,insertIdx),
        {...LUNCH_TMPL,stay:lSt,travelMins:0},
        ...reversedMiddle.slice(insertIdx),
      ];
      setRouteLocations([withMeta[0],...withLunch,recomputedRet]);
      setUsedFallback(!geoms.some(g=>g&&g.length>2));
      setStep("result");
    } catch(err) {
      console.error(err);
      showToast("ルート計算中にエラーが発生しました","error");
    } finally {
      setIsOptimizing(false);
    }
  },[customers,selectedIds,priorityId,pinnedTimes,departTime,officeNode]);

  const handleStayChange=useCallback((idx,delta)=>{
    // Bug 4 fixed: was {…l,stay:...}
    setRouteLocations(p=>p.map((l,i)=>i===idx?{...l,stay:Math.max(0,l.stay+delta)}:l));
  },[]);

  const handleMove=useCallback((idx,dir)=>{
    setRouteLocations(p=>{
      // Bug 4 fixed: was […p]
      const n=[...p],t=idx+dir;
      if(t<1||t>=n.length-1) return p;
      [n[idx],n[t]]=[n[t],n[idx]]; return n;
    });
  },[]);

  const handleBack  = useCallback(()=>setStep("select"),[]);
  const handleReset = useCallback(()=>{setStep("select");setSelectedIds([]);setPriorityId(null);setDepartTime(DEFAULT_DEPART);setRouteLocations([]);},[]);

  const schedule=useMemo(()=>step==="result"?calcSchedule(routeLocations,departTime):[],[routeLocations,departTime,step]);

  return (
    <div className="min-h-screen bg-slate-950 text-white" style={{fontFamily:"'Noto Sans JP',sans-serif"}}>
      <header className="sticky top-0 z-30 bg-slate-950/90 backdrop-blur-md border-b border-slate-800"
              style={{paddingTop:"env(safe-area-inset-top)"}}>
        <div className="max-w-xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <Navigation size={17} className="text-indigo-400"/>
              <div>
                <h1 className="text-sm font-bold leading-tight tracking-tight">ルート最適化ツール</h1>
                <p className="text-[9px] text-slate-600">Sales Route Optimizer</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {tab==="route"&&(
                <div className="flex items-center gap-0.5 text-[10px]">
                  {[["select","1","地点選択"],["result","2","ルート確認"]].map(([s,n,lbl])=>(
                    <span key={s} className={`flex items-center gap-0.5 px-2 py-1 rounded-lg font-semibold transition-colors ${step===s?"bg-indigo-600 text-white":"bg-slate-800 text-slate-500"}`}>
                      <span className="w-3 h-3 rounded-full bg-white/20 flex items-center justify-center text-[7px]">{n}</span>{lbl}
                    </span>
                  ))}
                </div>
              )}
              <button onClick={()=>setShowOfficeSetting(true)} title="オフィス設定"
                className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-500 hover:text-white flex items-center justify-center transition-colors">
                <Settings size={12}/>
              </button>
              <button onClick={handleReset} className="w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-500 hover:text-white flex items-center justify-center transition-colors">
                <RefreshCw size={12}/>
              </button>
            </div>
          </div>
          <div className="flex bg-slate-900 rounded-xl p-1 gap-1">
            {[{key:"route",icon:<Route size={12}/>,label:"ルート計画"},{key:"db",icon:<Database size={12}/>,label:"顧客マスター"}].map(t=>(
              <button key={t.key} onClick={()=>setTab(t.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${tab===t.key?"bg-indigo-600 text-white shadow-lg":"text-slate-500 hover:text-slate-300"}`}>
                {t.icon}{t.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="max-w-xl mx-auto px-4 py-5">
        {tab==="route"
          ?(step==="select"
            ?<LocationSelector customers={customers} selected={selectedIds} onToggle={handleToggle} priorityId={priorityId} onSetPriority={handleSetPriority} pinnedTimes={pinnedTimes} onSetPinnedTime={handleSetPinnedTime} departTime={departTime} onDepartChange={setDepartTime} onSearch={handleSearch} isOptimizing={isOptimizing}/>
            :<RouteResult schedule={schedule} priorityId={priorityId} usedFallback={usedFallback} onStayChange={handleStayChange} onMove={handleMove} onBack={handleBack}/>
          )
          :<DatabaseView customers={customers} onUpdate={d=>setCustomers([...d].sort((a,b)=>(a.kana||a.name).localeCompare(b.kana||b.name,"ja")))} onToast={showToast}/>
        }
      </div>
      {showOfficeSetting&&<OfficeSettingsModal office={office} onSave={o=>{setOffice(o);setShowOfficeSetting(false);showToast("オフィス設定を保存しました");}} onClose={()=>setShowOfficeSetting(false)}/>}
      {toast&&<Toast msg={toast.msg} type={toast.type} onClose={()=>setToast(null)}/>}
      <InstallPrompt/>
    </div>
  );
}
