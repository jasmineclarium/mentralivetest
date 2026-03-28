import { AppServer, AppSession } from '@mentra/sdk';
import { GoogleGenAI } from '@google/genai';
import { Pool } from 'pg';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

interface LiveExtraction { productName:string|null; manufacturer:string|null; barcode:string|null; expiryDate:string|null; noExpiryConfirmed:boolean; }
interface SessionData { phase:'idle'|'streaming'|'saving'; userId:string; extraction:LiveExtraction; announced:{product:boolean;barcode:boolean;expiry:boolean}; loopActive:boolean; loopTimer?:NodeJS.Timeout; hlsUrl:string|null; }

function calcExpiry(d:string){const ex=new Date(d);const t=new Date();t.setHours(0,0,0,0);const days=Math.round((ex.getTime()-t.getTime())/86400000);return{isExpired:days<0,daysUntilExpiry:days};}
function extractDate(text:string):string|null{const months:Record<string,number>={january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,june:6,jun:6,july:7,jul:7,august:8,aug:8,september:9,sep:9,sept:9,october:10,oct:10,november:11,nov:11,december:12,dec:12};for(const[n,num]of Object.entries(months)){const m=text.match(new RegExp(n+'\\s+(\\d{1,2})?\\s*(\\d{2,4})','i'));if(m){const day=m[1]?parseInt(m[1]):1;let y=parseInt(m[2]);if(y<100)y+=2000;return `${y}-${String(num).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}}const n=text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);if(n){let y=parseInt(n[3]);if(y<100)y+=2000;return `${y}-${n[1].padStart(2,'0')}-${n[2].padStart(2,'0')}`;}return null;}
function noExpiry(t:string):boolean{return t.includes('no expir')||t.includes('no date')||t.includes('no best by')||t.includes('does not have')||t.includes('skip expir')||(t.includes('no')&&t.includes('date'));}
function expiryLine(d:string):string{const{isExpired,daysUntilExpiry}=calcExpiry(d);if(isExpired)return `Warning! EXPIRED. Expiry was ${d}, ${Math.abs(daysUntilExpiry)} days ago`;if(daysUntilExpiry===0)return `Expiry: ${d}. Expires today`;if(daysUntilExpiry<=7)return `Expiry: ${d}. Only ${daysUntilExpiry} days left`;return `Expiry: ${d}. ${daysUntilExpiry} days remaining`;}
function parseJSON(text:string):any{try{const m=text.match(/\{[\s\S]*\}/);return m?JSON.parse(m[0]):null;}catch{return null;}}

async function geminiVision(base64:string,fields:string[]):Promise<any>{
  const desc:Record<string,string>={product_name:'product or item name',manufacturer:'brand or manufacturer',barcode:'barcode or QR code value',expiry_date:'expiration/best by/use by date in YYYY-MM-DD format'};
  const model=gemini.getGenerativeModel({model:'gemini-1.5-flash'});
  const result=await model.generateContent([{inlineData:{data:base64,mimeType:'image/jpeg'}},`Extract from this product packaging: ${fields.map(f=>desc[f]||f).join(', ')}. Reply ONLY with JSON, no markdown: {"product_name":null,"manufacturer":null,"barcode":null,"expiry_date":null} Return null for anything not clearly visible.`]);
  return parseJSON(result.response.text());
}

class ScannerApp extends AppServer {
  private sessions=new Map<string,SessionData>();
  protected async onSession(session:AppSession,sessionId:string,userId:string){
    const data:SessionData={phase:'idle',userId,extraction:{productName:null,manufacturer:null,barcode:null,expiryDate:null,noExpiryConfirmed:false},announced:{product:false,barcode:false,expiry:false},loopActive:false,hlsUrl:null};
    this.sessions.set(sessionId,data);
    await session.audio.speak('Product scanner ready. Say scan or press the button.');
    session.events.onTranscription(async t=>{
      if(!t.isFinal)return;const text=t.text.toLowerCase().trim();
      if(data.phase==='idle'){if(text.includes('scan')||text.includes('start'))await this.start(session,sessionId,data);else if(text.includes('list'))await this.list(session,data);return;}
      if(data.phase==='streaming'){if(noExpiry(text)){data.extraction.noExpiryConfirmed=true;await session.audio.speak('Got it, no expiration. Saving.');await this.save(session,sessionId,data);}else{const d=extractDate(text);if(d){data.extraction.expiryDate=d;data.announced.expiry=true;await session.audio.speak(`${expiryLine(d)}. Saving.`);await this.save(session,sessionId,data);}else if(text.includes('save')||text.includes('done'))await this.save(session,sessionId,data);else if(text.includes('cancel')||text.includes('stop'))await this.cancel(session,sessionId,data);}}
    });
    session.events.onButtonPress(async btn=>{
      if(btn.pressType==='short'){if(data.phase==='idle')await this.start(session,sessionId,data);else if(data.phase==='streaming')await this.save(session,sessionId,data);}
      else if(btn.pressType==='long'){if(data.phase==='streaming')await this.cancel(session,sessionId,data);else await this.list(session,data);}
    });
    session.events.onDisconnected(()=>{this.stopLoop(data);this.sessions.delete(sessionId);});
  }
  private async start(s:AppSession,sid:string,data:SessionData){
    if(data.phase!=='idle')return;
    data.extraction={productName:null,manufacturer:null,barcode:null,expiryDate:null,noExpiryConfirmed:false};
    data.announced={product:false,barcode:false,expiry:false};data.phase='streaming';
    try{const st=await s.camera.startManagedStream({quality:'720p'});data.hlsUrl=st.hlsUrl;await db.query('INSERT INTO active_streams(user_id,hls_url,dash_url,started_at)VALUES($1,$2,$3,now())ON CONFLICT(user_id)DO UPDATE SET hls_url=$2,dash_url=$3,started_at=now()',[data.userId,st.hlsUrl,st.dashUrl]);}catch{}
    await s.audio.speak('Scanning. Rotate the product slowly.');this.startLoop(s,sid,data);
  }
  private async cancel(s:AppSession,_:string,data:SessionData){this.stopLoop(data);try{await s.camera.stopManagedStream();}catch{}await db.query('DELETE FROM active_streams WHERE user_id=$1',[data.userId]);data.phase='idle';data.hlsUrl=null;await s.audio.speak('Scan cancelled.');}
  private async save(s:AppSession,sid:string,data:SessionData){
    if(data.phase!=='streaming')return;data.phase='saving';this.stopLoop(data);try{await s.camera.stopManagedStream();}catch{}await db.query('DELETE FROM active_streams WHERE user_id=$1',[data.userId]);
    const ext=data.extraction;if(!ext.productName){await s.audio.speak('Could not identify a product. Try again.');data.phase='idle';return;}
    const exp=ext.expiryDate?calcExpiry(ext.expiryDate):null;
    await db.query('INSERT INTO scanned_items(user_id,scanned_at,product_name,manufacturer,barcode,expiry_date,is_expired,days_until_expiry,no_expiry_confirmed,stream_hls_url)VALUES($1,now(),$2,$3,$4,$5,$6,$7,$8,$9)',[data.userId,ext.productName,ext.manufacturer??'Unknown',ext.barcode,ext.expiryDate,exp?.isExpired??null,exp?.daysUntilExpiry??null,ext.noExpiryConfirmed,data.hlsUrl]);
    let tts=`Saved: ${ext.productName}`;
    if(ext.manufacturer&&ext.manufacturer!=='Unknown')tts+=` by ${ext.manufacturer}`;
    if(ext.barcode)tts+='. Barcode recorded';
    if(ext.noExpiryConfirmed)tts+='. No expiration date.';
    else if(exp?.isExpired)tts+=`. EXPIRED ${Math.abs(exp.daysUntilExpiry)} days ago. Please discard.`;
    else if(exp&&exp.daysUntilExpiry<=7)tts+=`. Expires in ${exp.daysUntilExpiry} days.`;
    else if(ext.expiryDate)tts+=`. Good for ${exp!.daysUntilExpiry} more days.`;
    else tts+='. No expiration date found.';
    await s.audio.speak(tts);data.phase='idle';data.hlsUrl=null;
  }
  private startLoop(s:AppSession,sid:string,data:SessionData){data.loopActive=true;this.next(s,sid,data);}
  private stopLoop(data:SessionData){data.loopActive=false;if(data.loopTimer){clearTimeout(data.loopTimer);data.loopTimer=undefined;}}
  private next(s:AppSession,sid:string,data:SessionData){
    if(!data.loopActive||data.phase!=='streaming')return;
    const{product,barcode,expiry}=data.announced;
    const delay=(product&&barcode&&expiry)?4000:(product&&barcode)?1000:2000;
    data.loopTimer=setTimeout(async()=>{if(!data.loopActive||data.phase!=='streaming')return;try{await this.analyze(s,data);}catch{}this.next(s,sid,data);},delay);
  }
  private async analyze(s:AppSession,data:SessionData){
    const photo=await s.camera.requestPhoto({compress:'medium',size:'large'});
    const base64=photo.buffer.toString('base64');
    const{product,barcode,expiry}=data.announced;
    const needExpiry=!expiry&&!data.extraction.noExpiryConfirmed;
    if(product&&barcode&&!needExpiry)return;
    const fields=[...(!product?['product_name','manufacturer']:[]),...(!barcode?['barcode']:[]),...(needExpiry?['expiry_date']:[])];
    const result=await geminiVision(base64,fields);
    if(!result)return;
    const toSay:string[]=[];const ext=data.extraction;
    if(!product&&result.product_name){ext.productName=result.product_name;ext.manufacturer=result.manufacturer??null;data.announced.product=true;toSay.push(`Got it: ${result.product_name}${result.manufacturer?` by ${result.manufacturer}`:''}`);}
    if(!barcode&&result.barcode){ext.barcode=result.barcode;data.announced.barcode=true;toSay.push('Barcode captured');}
    if(needExpiry&&result.expiry_date){ext.expiryDate=result.expiry_date;data.announced.expiry=true;toSay.push(expiryLine(result.expiry_date));}
    if(toSay.length>0){
      const still:string[]=[];
      if(!data.announced.barcode)still.push('show the barcode');
      if(!data.announced.expiry&&!ext.noExpiryConfirmed)still.push('show expiration date, speak it, or say no expiration date');
      if(still.length>0&&ext.productName)toSay.push(`Now ${still.join(' and ')}`);
      else if(data.announced.product&&data.announced.barcode&&data.announced.expiry)toSay.push('All info captured. Say save or press the button');
      await s.audio.speak(toSay.join('. '));
    }
  }
  private async list(s:AppSession,data:SessionData){
    const{rows}=await db.query('SELECT product_name,is_expired,days_until_expiry,no_expiry_confirmed FROM scanned_items WHERE user_id=$1 ORDER BY scanned_at DESC LIMIT 20',[data.userId]);
    if(!rows.length){await s.audio.speak('No items scanned yet.');return;}
    const exp=rows.filter((r:any)=>r.is_expired).length;const soon=rows.filter((r:any)=>!r.is_expired&&r.days_until_expiry!=null&&r.days_until_expiry<=7).length;
    const preview=rows.slice(0,3).map((r:any)=>{if(r.no_expiry_confirmed)return `${r.product_name}, no expiry`;if(r.is_expired)return `${r.product_name}, expired`;if(r.days_until_expiry!=null)return `${r.product_name}, ${r.days_until_expiry} days`;return `${r.product_name}, no date`;}).join('. ');
    await s.audio.speak(`${rows.length} items. ${exp} expired, ${soon} expiring soon. ${preview}`);
  }
  protected async onStop(sessionId:string,_:string,reason:string){const d=this.sessions.get(sessionId);if(d){this.stopLoop(d);this.sessions.delete(sessionId);}console.log(`Session ${sessionId} ended: ${reason}`);}
}

const app=new ScannerApp({packageName:process.env.MENTRA_PACKAGE_NAME!,apiKey:process.env.MENTRA_API_KEY!,port:parseInt(process.env.PORT||'3000')});
app.start();
console.log(`Scanner running on port ${process.env.PORT||3000}`);
