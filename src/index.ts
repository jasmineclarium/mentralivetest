import MentraSDK from '@mentra/sdk';
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';

const { AppServer } = MentraSDK as any;
import express from 'express';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash' });

// ── Dashboard express server ───────────────────────────────────────────────
const webApp = express();
webApp.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM scanned_items ORDER BY scanned_at DESC LIMIT 50');
    const rows_html = rows.map(r => {
      const expClass = r.is_expired ? 'expired' : (r.days_until_expiry != null && r.days_until_expiry <= 7) ? 'soon' : 'ok';
      const expLabel = r.no_expiry_confirmed ? 'No expiry' : r.is_expired ? `EXPIRED (${Math.abs(r.days_until_expiry)}d ago)` : r.days_until_expiry != null ? `${r.days_until_expiry}d left` : 'No date';
      const date = new Date(r.scanned_at).toLocaleDateString();
      return `<tr class='${expClass}'><td>${r.product_name}</td><td>${r.manufacturer||'—'}</td><td>${r.barcode||'—'}</td><td>${expLabel}</td><td>${date}</td></tr>`;
    }).join('');
    res.send(`<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Product Scanner</title><style>
      body{font-family:system-ui,sans-serif;background:#0a0f1e;color:#fff;margin:0;padding:20px}
      h1{color:#00e5cc;font-size:22px;margin-bottom:4px}
      p{color:#888;font-size:13px;margin:0 0 20px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th{background:#0d1f3c;color:#00e5cc;padding:10px 12px;text-align:left}
      td{padding:9px 12px;border-bottom:1px solid #1a2a4a}
      .expired{background:#2a0a0a} .expired td:nth-child(4){color:#ff4444;font-weight:bold}
      .soon{background:#1a1a0a} .soon td:nth-child(4){color:#ffaa00;font-weight:bold}
      .ok td:nth-child(4){color:#00e5cc}
      .empty{text-align:center;padding:40px;color:#444}
    </style></head><body>
    <h1>🔍 Product Scanner</h1><p>${rows.length} items scanned</p>
    <table><thead><tr><th>Product</th><th>Brand</th><th>Barcode</th><th>Expiry</th><th>Scanned</th></tr></thead>
    <tbody>${rows_html || '<tr><td colspan=5 class=empty>No items scanned yet. Say \'scan\' in the glasses app to start.</td></tr>'}</tbody>
    </table></body></html>`);
  } catch(e) { res.status(500).send('DB error: '+(e as any).message); }
});
webApp.listen(parseInt(process.env.PORT||'3000'), () => {
  console.log(`Dashboard running on port ${process.env.PORT||3000}`);
});

// ── Types ─────────────────────────────────────────────────────────────────
interface Extraction { productName:string|null; manufacturer:string|null; barcode:string|null; expiryDate:string|null; noExpiryConfirmed:boolean; }
interface SessionData { phase:'idle'|'scanning'|'saving'; userId:string; ext:Extraction; announced:{product:boolean;barcode:boolean;expiry:boolean}; loopActive:boolean; loopTimer?:NodeJS.Timeout; hlsUrl:string|null; }

function parseJSON(text:string) { try { const m=text.match(/\{[\s\S]*\}/); return m?JSON.parse(m[0]):null; } catch { return null; } }
function calcExpiry(d:string) { const ex=new Date(d); const t=new Date(); t.setHours(0,0,0,0); const days=Math.round((ex.getTime()-t.getTime())/86400000); return {isExpired:days<0,days}; }
function expiryLine(d:string) { const{isExpired,days}=calcExpiry(d); if(isExpired)return `Warning! EXPIRED ${Math.abs(days)} days ago`; if(days===0)return `Expiry today`; if(days<=7)return `Expiry ${d}, only ${days} days left`; return `Expiry ${d}, ${days} days remaining`; }
function dateFromSpeech(text:string):string|null { const months:any={january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,june:6,jun:6,july:7,jul:7,august:8,aug:8,september:9,sep:9,sept:9,october:10,oct:10,november:11,nov:11,december:12,dec:12}; for(const[n,num]of Object.entries(months)){const m=text.match(new RegExp(n+'\\s+(\\d{1,2})?\\s*(\\d{2,4})','i'));if(m){const day=m[1]?parseInt(m[1]):1;let y=parseInt(m[2]);if(y<100)y+=2000;return `${y}-${String(num).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}} const n=text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);if(n){let y=parseInt(n[3]);if(y<100)y+=2000;return `${y}-${n[1].padStart(2,'0')}-${n[2].padStart(2,'0')}`;} return null; }
function isNoExpiry(t:string) { return t.includes('no expir')||t.includes('no date')||t.includes('no best by')||t.includes('does not have')||(t.includes('no')&&t.includes('date')); }

// ── App ───────────────────────────────────────────────────────────────────
class ProductScannerApp extends AppServer {
  private sessions = new Map<string,SessionData>();

  protected async onSession(session:AppSession, sessionId:string, userId:string) {
    const data:SessionData = {phase:'idle',userId,ext:{productName:null,manufacturer:null,barcode:null,expiryDate:null,noExpiryConfirmed:false},announced:{product:false,barcode:false,expiry:false},loopActive:false,hlsUrl:null};
    this.sessions.set(sessionId,data);
    console.log(`Session started for user ${userId}`);
    await session.audio.speak('Product scanner ready. Say scan or press the button to start.');

    session.events.onTranscription(async(t)=>{
      if(!t.isFinal)return;
      const text=t.text.toLowerCase().trim();
      if(data.phase==='idle'){
        if(text.includes('scan')||text.includes('start'))await this.startScan(session,sessionId,data);
        else if(text.includes('list')||text.includes('history'))await this.readList(session,data);
        return;
      }
      if(data.phase==='scanning'){
        if(isNoExpiry(text)){data.ext.noExpiryConfirmed=true;await session.audio.speak('No expiration date. Saving now.');await this.saveAndFinish(session,sessionId,data);}
        else{const d=dateFromSpeech(text);if(d){data.ext.expiryDate=d;data.announced.expiry=true;await session.audio.speak(`${expiryLine(d)}. Saving now.`);await this.saveAndFinish(session,sessionId,data);}
        else if(text.includes('save')||text.includes('done'))await this.saveAndFinish(session,sessionId,data);
        else if(text.includes('cancel')||text.includes('stop'))await this.stopScan(session,sessionId,data,true);}
      }
    });

    session.events.onButtonPress(async(btn)=>{
      if(btn.pressType==='short'){if(data.phase==='idle')await this.startScan(session,sessionId,data);else if(data.phase==='scanning')await this.saveAndFinish(session,sessionId,data);}
      else if(btn.pressType==='long'){if(data.phase==='scanning')await this.stopScan(session,sessionId,data,true);else await this.readList(session,data);}
    });
    session.events.onDisconnected(()=>{this.stopLoop(data);this.sessions.delete(sessionId);});
  }

  private async startScan(s:AppSession,sid:string,data:SessionData){
    if(data.phase!=='idle')return;
    data.ext={productName:null,manufacturer:null,barcode:null,expiryDate:null,noExpiryConfirmed:false};
    data.announced={product:false,barcode:false,expiry:false}; data.phase='scanning';
    try{const st=await s.camera.startManagedStream({quality:'720p'});data.hlsUrl=st.hlsUrl;await db.query('INSERT INTO active_streams(user_id,hls_url,dash_url,started_at)VALUES($1,$2,$3,now())ON CONFLICT(user_id)DO UPDATE SET hls_url=$2,dash_url=$3,started_at=now()',[data.userId,st.hlsUrl,st.dashUrl]);}catch(e){}
    await s.audio.speak('Scanning started. Point your glasses at the product and rotate it slowly.');
    this.startLoop(s,sid,data);
  }
  private async stopScan(s:AppSession,_:string,data:SessionData,announce:boolean){
    this.stopLoop(data);try{await s.camera.stopManagedStream();}catch(e){}
    await db.query('DELETE FROM active_streams WHERE user_id=$1',[data.userId]);
    data.phase='idle';data.hlsUrl=null;if(announce)await s.audio.speak('Scan cancelled.');
  }
  private async saveAndFinish(s:AppSession,sid:string,data:SessionData){
    if(data.phase!=='scanning')return;data.phase='saving';
    this.stopLoop(data);try{await s.camera.stopManagedStream();}catch(e){}
    await db.query('DELETE FROM active_streams WHERE user_id=$1',[data.userId]);
    const ext=data.ext;
    if(!ext.productName){await s.audio.speak('Could not identify a product. Try again pointing at the label.');data.phase='idle';return;}
    const expiry=ext.expiryDate?calcExpiry(ext.expiryDate):null;
    await db.query('INSERT INTO scanned_items(user_id,scanned_at,product_name,manufacturer,barcode,expiry_date,is_expired,days_until_expiry,no_expiry_confirmed,stream_hls_url)VALUES($1,now(),$2,$3,$4,$5,$6,$7,$8,$9)',[data.userId,ext.productName,ext.manufacturer||'Unknown',ext.barcode,ext.expiryDate,expiry?.isExpired??null,expiry?.days??null,ext.noExpiryConfirmed,data.hlsUrl]);
    let tts=`Saved: ${ext.productName}`;
    if(ext.manufacturer&&ext.manufacturer!=='Unknown')tts+=` by ${ext.manufacturer}`;
    if(ext.barcode)tts+='. Barcode recorded';
    if(ext.noExpiryConfirmed)tts+='. No expiration date.';
    else if(expiry?.isExpired)tts+=`. EXPIRED ${Math.abs(expiry.days)} days ago. Please discard.`;
    else if(expiry&&expiry.days<=7)tts+=`. Caution, expires in ${expiry.days} days.`;
    else if(ext.expiryDate)tts+=`. Good for ${expiry!.days} more days.`;
    else tts+='. No expiration date found.';
    await s.audio.speak(tts);data.phase='idle';data.hlsUrl=null;
  }
  private startLoop(s:AppSession,sid:string,data:SessionData){data.loopActive=true;this.scheduleNext(s,sid,data);}
  private stopLoop(data:SessionData){data.loopActive=false;if(data.loopTimer){clearTimeout(data.loopTimer);data.loopTimer=undefined;}}
  private scheduleNext(s:AppSession,sid:string,data:SessionData){
    if(!data.loopActive||data.phase!=='scanning')return;
    const{product,barcode,expiry}=data.announced;
    const delay=(product&&barcode&&expiry)?4000:(product&&barcode)?1000:2000;
    data.loopTimer=setTimeout(async()=>{if(!data.loopActive||data.phase!=='scanning')return;try{await this.analyzeFrame(s,data);}catch(e){s.logger.error(e as Error,'Frame error');}this.scheduleNext(s,sid,data);},delay);
  }
  private async analyzeFrame(s:AppSession,data:SessionData){
    const photo=await s.camera.requestPhoto({compress:'medium',size:'large'});
    const base64=photo.buffer.toString('base64');
    const{product,barcode,expiry}=data.announced;
    const needExpiry=!expiry&&!data.ext.noExpiryConfirmed;
    if(product&&barcode&&!needExpiry)return;
    const need:string[]=[];
    if(!product)need.push('product name and manufacturer/brand');
    if(!barcode)need.push('barcode or QR code number');
    if(needExpiry)need.push('expiration, best by, or use by date');
    const prompt=`Analyze this product packaging. Extract ONLY clearly visible info.\nLooking for: ${need.join(', ')}.\nReply ONLY with JSON: {"product_name":null,"manufacturer":null,"barcode":null,"expiry_date":null}\nRules: expiry_date in YYYY-MM-DD; decode barcode number; null if not visible.`;
    const resp=await model.generateContent([{inlineData:{mimeType:'image/jpeg',data:base64}},prompt]);
    const result=parseJSON(resp.response.text());
    if(!result)return;
    const toSay:string[]=[]; const ext=data.ext;
    if(!product&&result.product_name){ext.productName=result.product_name;ext.manufacturer=result.manufacturer||null;data.announced.product=true;toSay.push(`Product identified: ${result.product_name}${result.manufacturer?' by '+result.manufacturer:''}`);}
    if(!barcode&&result.barcode){ext.barcode=result.barcode;data.announced.barcode=true;toSay.push('Barcode scanned');}
    if(needExpiry&&result.expiry_date){ext.expiryDate=result.expiry_date;data.announced.expiry=true;toSay.push(expiryLine(result.expiry_date));}
    if(toSay.length>0){
      const stillNeed:string[]=[];
      if(!data.announced.barcode)stillNeed.push('please show me the barcode');
      if(!data.announced.expiry&&!ext.noExpiryConfirmed)stillNeed.push('show expiration date, speak it, or say no expiration date');
      if(stillNeed.length>0&&ext.productName)toSay.push(stillNeed.join('. '));
      else if(data.announced.product&&data.announced.barcode&&data.announced.expiry)toSay.push('All info captured. Say save or press the button.');
      await s.audio.speak(toSay.join('. '));
    }
  }
  private async readList(s:AppSession,data:SessionData){
    const{rows}=await db.query('SELECT product_name,is_expired,days_until_expiry,no_expiry_confirmed FROM scanned_items WHERE user_id=$1 ORDER BY scanned_at DESC LIMIT 20',[data.userId]);
    if(!rows.length){await s.audio.speak('No items scanned yet.');return;}
    const expired=rows.filter((r:any)=>r.is_expired).length;
    const soon=rows.filter((r:any)=>!r.is_expired&&r.days_until_expiry!=null&&r.days_until_expiry<=7).length;
    const preview=rows.slice(0,3).map((r:any)=>{if(r.no_expiry_confirmed)return r.product_name+', no expiry';if(r.is_expired)return r.product_name+', expired';if(r.days_until_expiry!=null)return r.product_name+', '+r.days_until_expiry+' days';return r.product_name+', no date';}).join('. ');
    await s.audio.speak(`${rows.length} items. ${expired} expired, ${soon} expiring soon. ${preview}`);
  }
  protected async onStop(sessionId:string,_:string,reason:string){const data=this.sessions.get(sessionId);if(data){this.stopLoop(data);this.sessions.delete(sessionId);}console.log(`Session ${sessionId} ended: ${reason}`);}
}

// ── Start ──────────────────────────────────────────────────────────────────
const app = new ProductScannerApp({
  packageName: process.env.MENTRA_PACKAGE_NAME!,
  apiKey: process.env.MENTRA_API_KEY!,
  port: parseInt(process.env.PORT||'3000'),
});
app.start();
console.log(`Product scanner + dashboard running on port ${process.env.PORT||3000}`);
