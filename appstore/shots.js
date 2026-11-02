const fs=require('fs');const {chromium}=require('playwright');
const src=fs.readFileSync('../backend/index.tsx','utf8');
const a=src.indexOf('const PAGE = String.raw`')+'const PAGE = String.raw`'.length;
const html=src.slice(a,src.indexOf('`;\n\n// ---------- server'));
const now=Date.now();
const base={clock:{since:new Date(now-2*86400000-6*3600000-41*60000).toISOString(),matches:9,record:6*86400+7200},history:[
 {ts:new Date(now-86400000).toISOString(),elapsed:2*86400+4*3600,city:'Oakland, CA'},{ts:new Date(now-4*86400000).toISOString(),elapsed:6*86400+7200,city:'Austin, TX'},{ts:new Date(now-9*86400000).toISOString(),elapsed:86400+30000,city:'Brooklyn, NY'}],
 players:214,game_start:150,started:true,vapid:'x',pick_percent:3.36,respond_min:20,pick_window_min:20};
const me=(o)=>({picked:false,used:false,can_send:false,missed:null,push:true,assignment:null,pick_expired:false,...o});
const cases=[
 ['1-join',{condition:'Clear',daylight:true},{...base,me:null}],
 ['2-waiting',{condition:'Clear',daylight:true},{...base,me:me({})}],
 ['3-picked-to-ask',{condition:'Clear',daylight:false},{...base,me:me({picked:true,can_send:true,pick_until:new Date(now+14*60000).toISOString()})}],
 ['4-asked-to-raise',{condition:'Clear',daylight:false},{...base,me:me({used:false,assignment:{status:'pending',expires:new Date(now+17*60000).toISOString(),asked_at:new Date(now-3*60000).toISOString()}})}],
 ['5-sightings',{condition:'Clear',daylight:true},{...base,me:me({}),open:true}],
];
(async()=>{const br=await chromium.launch();
for(const [name,sky,state] of cases){
 const ctx=await br.newContext({viewport:{width:430,height:932},deviceScaleFactor:3,geolocation:{latitude:37.5,longitude:-122.3},permissions:['geolocation'],colorScheme:'light'});
 const p=await ctx.newPage();
 await p.addInitScript(()=>{window.Capacitor={isNativePlatform:()=>true,Plugins:{}}});
 await p.route('**/api/state',r=>r.fulfill({json:state}));
 await p.route('**/api/sky',r=>r.fulfill({json:sky}));
 await p.route('**/*',r=>{const u=r.request().url();if(u.includes('/api/'))return r.fallback();return r.fulfill({contentType:'text/html',body:html})});
 await p.goto('http://localhost/');await p.waitForTimeout(900);
 if(state.open){await p.evaluate(()=>toggleHist());await p.evaluate(()=>window.scrollTo(0,99999));await p.waitForTimeout(300)}
 await p.screenshot({path:'screenshots/'+name+'.png'});await ctx.close();}
await br.close();})();
