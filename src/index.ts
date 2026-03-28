import { AppServer, AppSession } from '@mentra/sdk';
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash' });

function parseJSON(text) {
  try { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
function calcExpiry(d) {
  const ex = new Date(d); const today = new Date(); today.setHours(0,0,0,0);
  const days = Math.round((ex.getTime() - today.getTime()) / 86400000);
  return { isExpired: days < 0, days };
}
function expiryLine(d) {
  const { isExpired, days } = calcExpiry(d);
  if (isExpired) return `Warning! This product is EXPIRED. It expired ${Math.abs(days)} days ago`;
  if (days === 0) return `Expiry date ${d}. This expires today`;
  if (days <= 7) return `Expiry date ${d}. Caution, only ${days} days left`;
  return `Expiry date ${d}. Good for ${days} more days`;
}
function dateFromSpeech(text) {
  const months = {january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,june:6,jun:6,july:7,jul:7,august:8,aug:8,september:9,sep:9,sept:9,october:10,oct:10,november:11,nov:11,december:12,dec:12};
  for (const [name, num] of Object.entries(months)) {
    const m = text.match(new RegExp(name+'\\s+(\\d{1,2})?\\s*(\\d{2,4})','i'));
    if (m) { const day=m[1]?parseInt(m[1]):1; let year=parseInt(m[2]); if(year<100)year+=2000; return `${year}-${String(num).padStart(2,'0')}-${String(day).padStart(2,'0')}`; }
  }
  const n = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (n) { let year=parseInt(n[3]); if(year<100)year+=2000; return `${year}-${n[1].padStart(2,'0')}-${n[2].padStart(2,'0')}`; }
  return null;
}
function isNoExpiry(text) {
  return text.includes('no expir')||text.includes('no date')||text.includes('no best by')||
    text.includes('does not have')||text.includes("doesn't have")||text.includes('skip expir')||
    (text.includes('no')&&text.includes('date'));
}

class ProductScannerApp extends AppServer {
  sessions = new Map();

  async onSession(session, sessionId, userId) {
    const data = { phase:'idle', userId,
      ext:{ productName:null,manufacturer:null,barcode:null,expiryDate:null,noExpiryConfirmed:false },
      announced:{ product:false,barcode:false,expiry:false },
      loopActive:false, hlsUrl:null };
    this.sessions.set(sessionId, data);
    await session.audio.speak('Product scanner ready. Say scan or press the button to start.');

    session.events.onTranscription(async (t) => {
      if (!t.isFinal) return;
      const text = t.text.toLowerCase().trim();
      if (data.phase === 'idle') {
        if (text.includes('scan')||text.includes('start')) await this.startScan(session,sessionId,data);
        else if (text.includes('list')||text.includes('history')) await this.readList(session,data);
        return;
      }
      if (data.phase === 'scanning') {
        if (isNoExpiry(text)) {
          data.ext.noExpiryConfirmed = true;
          await session.audio.speak('Got it, no expiration date. Saving now.');
          await this.saveAndFinish(session,sessionId,data);
        } else {
          const d = dateFromSpeech(text);
          if (d) { data.ext.expiryDate=d; data.announced.expiry=true; await session.audio.speak(`${expiryLine(d)}. Saving now.`); await this.saveAndFinish(session,sessionId,data); }
          else if (text.includes('save')||text.includes('done')) await this.saveAndFinish(session,sessionId,data);
          else if (text.includes('cancel')||text.includes('stop')) await this.stopScan(session,sessionId,data,true);
        }
      }
    });

    session.events.onButtonPress(async (btn) => {
      if (btn.pressType==='short') {
        if (data.phase==='idle') await this.startScan(session,sessionId,data);
        else if (data.phase==='scanning') await this.saveAndFinish(session,sessionId,data);
      } else if (btn.pressType==='long') {
        if (data.phase==='scanning') await this.stopScan(session,sessionId,data,true);
        else await this.readList(session,data);
      }
    });
    session.events.onDisconnected(()=>{ this.stopLoop(data); this.sessions.delete(sessionId); });
  }

  async startScan(s, sid, data) {
    if (data.phase!=='idle') return;
    data.ext={productName:null,manufacturer:null,barcode:null,expiryDate:null,noExpiryConfirmed:false};
    data.announced={product:false,barcode:false,expiry:false}; data.phase='scanning';
    try {
      const st = await s.camera.startManagedStream({quality:'720p'}); data.hlsUrl=st.hlsUrl;
      await db.query('INSERT INTO active_streams(user_id,hls_url,dash_url,started_at)VALUES($1,$2,$3,now())ON CONFLICT(user_id)DO UPDATE SET hls_url=$2,dash_url=$3,started_at=now()',[data.userId,st.hlsUrl,st.dashUrl]);
    } catch(e) {}
    await s.audio.speak('Scanning started. Point your glasses at the product and rotate it slowly.');
    this.startLoop(s,sid,data);
  }

  async stopScan(s, _, data, announce) {
    this.stopLoop(data); try{await s.camera.stopManagedStream();}catch(e){}
    await db.query('DELETE FROM active_streams WHERE user_id=$1',[data.userId]);
    data.phase='idle'; data.hlsUrl=null;
    if (announce) await s.audio.speak('Scan cancelled.');
  }

  async saveAndFinish(s, sid, data) {
    if (data.phase!=='scanning') return; data.phase='saving';
    this.stopLoop(data); try{await s.camera.stopManagedStream();}catch(e){}
    await db.query('DELETE FROM active_streams WHERE user_id=$1',[data.userId]);
    const ext=data.ext;
    if (!ext.productName) { await s.audio.speak('Could not identify a product. Try again pointing at the label.'); data.phase='idle'; return; }
    const expiry=ext.expiryDate?calcExpiry(ext.expiryDate):null;
    await db.query('INSERT INTO scanned_items(user_id,scanned_at,product_name,manufacturer,barcode,expiry_date,is_expired,days_until_expiry,no_expiry_confirmed,stream_hls_url)VALUES($1,now(),$2,$3,$4,$5,$6,$7,$8,$9)',[data.userId,ext.productName,ext.manufacturer||'Unknown',ext.barcode,ext.expiryDate,expiry?expiry.isExpired:null,expiry?expiry.days:null,ext.noExpiryConfirmed,data.hlsUrl]);
    let tts=`Saved: ${ext.productName}`;
    if(ext.manufacturer&&ext.manufacturer!=='Unknown')tts+=` by ${ext.manufacturer}`;
    if(ext.barcode)tts+='. Barcode recorded';
    if(ext.noExpiryConfirmed)tts+='. No expiration date.';
    else if(expiry&&expiry.isExpired)tts+=`. WARNING - EXPIRED ${Math.abs(expiry.days)} days ago. Please discard.`;
    else if(expiry&&expiry.days<=7)tts+=`. Caution - expires in ${expiry.days} days.`;
    else if(ext.expiryDate)tts+=`. Good for ${expiry.days} more days.`;
    else tts+='. No expiration date found.';
    await s.audio.speak(tts); data.phase='idle'; data.hlsUrl=null;
  }

  startLoop(s,sid,data){data.loopActive=true;this.scheduleNext(s,sid,data);}
  stopLoop(data){data.loopActive=false;if(data.loopTimer){clearTimeout(data.loopTimer);data.loopTimer=undefined;}}
  scheduleNext(s,sid,data){
    if(!data.loopActive||data.phase!=='scanning')return;
    const{product,barcode,expiry}=data.announced;
    const delay=(product&&barcode&&expiry)?4000:(product&&barcode)?1000:2000;
    data.loopTimer=setTimeout(async()=>{
      if(!data.loopActive||data.phase!=='scanning')return;
      try{await this.analyzeFrame(s,data);}catch(e){s.logger.error(e,'Frame error');}
      this.scheduleNext(s,sid,data);
    },delay);
  }

  async analyzeFrame(s, data) {
    const photo=await s.camera.requestPhoto({compress:'medium',size:'large'});
    const base64=photo.buffer.toString('base64');
    const{product,barcode,expiry}=data.announced;
    const needExpiry=!expiry&&!data.ext.noExpiryConfirmed;
    if(product&&barcode&&!needExpiry)return;
    const need=[];
    if(!product)need.push('product name and manufacturer/brand');
    if(!barcode)need.push('barcode or QR code value');
    if(needExpiry)need.push('expiration date, best by date, or use by date');
    const result=await this.geminiAnalyze(base64,need);
    if(!result)return;
    const toSay=[]; const ext=data.ext;
    if(!product&&result.product_name){ext.productName=result.product_name;ext.manufacturer=result.manufacturer||null;data.announced.product=true;toSay.push(`Product identified: ${result.product_name}${result.manufacturer?' by '+result.manufacturer:''}`);}
    if(!barcode&&result.barcode){ext.barcode=result.barcode;data.announced.barcode=true;toSay.push('Barcode scanned');}
    if(needExpiry&&result.expiry_date){ext.expiryDate=result.expiry_date;data.announced.expiry=true;toSay.push(expiryLine(result.expiry_date));}
    if(toSay.length>0){
      const stillNeed=[];
      if(!data.announced.barcode)stillNeed.push('please show me the barcode');
      if(!data.announced.expiry&&!ext.noExpiryConfirmed)stillNeed.push('please show the expiration date, speak it, or say no expiration date');
      if(stillNeed.length>0&&ext.productName)toSay.push(stillNeed.join('. '));
      else if(data.announced.product&&data.announced.barcode&&data.announced.expiry)toSay.push('All information captured. Say save or press the button to finish.');
      await s.audio.speak(toSay.join('. '));
    }
  }

  async geminiAnalyze(base64, need) {
    const prompt=`Analyze this product packaging image. Extract ONLY what you can clearly see.\nLooking for: ${need.join(', ')}.\nReply ONLY with JSON, no markdown:\n{"product_name":null,"manufacturer":null,"barcode":null,"expiry_date":null}\nRules: expiry_date must be YYYY-MM-DD; barcode: decode the actual number; return null if not clearly visible; manufacturer means brand name`;
    const response=await model.generateContent([{inlineData:{mimeType:'image/jpeg',data:base64}},prompt]);
    return parseJSON(response.response.text());
  }

  async readList(s, data) {
    const{rows}=await db.query('SELECT product_name,is_expired,days_until_expiry,no_expiry_confirmed FROM scanned_items WHERE user_id=$1 ORDER BY scanned_at DESC LIMIT 20',[data.userId]);
    if(!rows.length){await s.audio.speak('No items scanned yet.');return;}
    const expired=rows.filter(r=>r.is_expired).length;
    const soon=rows.filter(r=>!r.is_expired&&r.days_until_expiry!=null&&r.days_until_expiry<=7).length;
    const preview=rows.slice(0,3).map(r=>{if(r.no_expiry_confirmed)return r.product_name+', no expiry';if(r.is_expired)return r.product_name+', expired';if(r.days_until_expiry!=null)return r.product_name+', '+r.days_until_expiry+' days';return r.product_name+', no date';}).join('. ');
    await s.audio.speak(`${rows.length} items scanned. ${expired} expired, ${soon} expiring soon. ${preview}`);
  }

  async onStop(sessionId,_,reason){const data=this.sessions.get(sessionId);if(data){this.stopLoop(data);this.sessions.delete(sessionId);}console.log(`Session ${sessionId} ended: ${reason}`);}
}

const app=new ProductScannerApp({packageName:process.env.MENTRA_PACKAGE_NAME,apiKey:process.env.MENTRA_API_KEY,port:parseInt(process.env.PORT||'3000')});
app.start();
console.log(`Product scanner running on port ${process.env.PORT||3000}`);
