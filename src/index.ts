import MentraSDK from '@mentra/sdk';
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';

const { AppServer } = MentraSDK as any;

const PORT = parseInt(process.env.PORT || '3000', 10);

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });

type ScanStep = 'idle' | 'front' | 'barcode' | 'expiry' | 'saving';

type Extraction = {
  productName: string | null;
  manufacturer: string | null;
  barcode: string | null;
  expiryDate: string | null;
  noExpiryConfirmed: boolean;
};

type SessionData = {
  userId: string;
  step: ScanStep;
  ext: Extraction;
};

function resetExtraction(): Extraction {
  return {
    productName: null,
    manufacturer: null,
    barcode: null,
    expiryDate: null,
    noExpiryConfirmed: false,
  };
}

function parseJSON(text: string) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

function calcExpiry(d: string) {
  const ex = new Date(d);
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const days = Math.round((ex.getTime() - t.getTime()) / 86400000);
  return { isExpired: days < 0, days };
}

function expiryLine(d: string) {
  const { isExpired, days } = calcExpiry(d);
  if (isExpired) return `Warning. This product is expired. It expired ${Math.abs(days)} days ago.`;
  if (days === 0) return `Expiry date ${d}. This expires today.`;
  if (days <= 7) return `Expiry date ${d}. Caution. Only ${days} days left.`;
  return `Expiry date ${d}. Good for ${days} more days.`;
}

function dateFromSpeech(text: string): string | null {
  const months: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12,
  };

  for (const [name, num] of Object.entries(months)) {
    const m = text.match(new RegExp(name + '\\s+(\\d{1,2})?\\s*(\\d{2,4})', 'i'));
    if (m) {
      const day = m[1] ? parseInt(m[1], 10) : 1;
      let y = parseInt(m[2], 10);
      if (y < 100) y += 2000;
      return `${y}-${String(num).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const n = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (n) {
    let y = parseInt(n[3], 10);
    if (y < 100) y += 2000;
    return `${y}-${n[1].padStart(2, '0')}-${n[2].padStart(2, '0')}`;
  }

  return null;
}

function isNoExpiry(text: string) {
  return (
    text.includes('no expir') ||
    text.includes('no date') ||
    text.includes('no best by') ||
    text.includes('does not have') ||
    (text.includes('no') && text.includes('date'))
  );
}

class ProductScannerApp extends AppServer {
  private sessions = new Map<string, SessionData>();

constructor(config: { packageName: string; apiKey: string; port: number }) {
  super({
    ...config,
    subscriptions: {
      transcription: true,
      buttonPress: true,
    },
  });
}

  protected async onSession(session: any, sessionId: string, userId: string) {
    const data: SessionData = {
      userId,
      step: 'idle',
      ext: resetExtraction(),
    };

    this.sessions.set(sessionId, data);
    console.log(`Session started for user ${userId}`);

    await session.audio.speak(
      'Product scanner ready. Say scan or press the button to start.'
    );

    session.events.onTranscription(async (t: any) => {
      if (!t.isFinal) return;

      const text = (t.text || '').toLowerCase().trim();
      console.log('Final transcription:', text);

      if (text.includes('cancel') || text.includes('stop')) {
        await this.cancelFlow(session, data);
        return;
      }

      if (data.step === 'idle') {
        if (text.includes('scan') || text.includes('start')) {
          await this.beginFlow(session, data);
        } else if (text.includes('list') || text.includes('history')) {
          await this.readList(session, data);
        }
        return;
      }

      if (data.step === 'expiry') {
        if (isNoExpiry(text)) {
          data.ext.noExpiryConfirmed = true;
          await session.audio.speak('No expiration date noted. Saving now.');
          await this.saveItem(session, data);
          return;
        }

        const spokenDate = dateFromSpeech(text);
        if (spokenDate) {
          data.ext.expiryDate = spokenDate;
          await session.audio.speak(`${expiryLine(spokenDate)} Saving now.`);
          await this.saveItem(session, data);
          return;
        }
      }

      if (text.includes('save')) {
        await this.saveItem(session, data);
      }
    });

    session.events.onButtonPress(async (btn: any) => {
      console.log('Button press:', btn?.pressType);

      if (btn?.pressType === 'long') {
        if (data.step === 'idle') {
          await this.readList(session, data);
        } else {
          await this.cancelFlow(session, data);
        }
        return;
      }

      if (btn?.pressType !== 'short') return;

      if (data.step === 'idle') {
        await this.beginFlow(session, data);
        return;
      }

      if (data.step === 'front') {
        await this.captureFrontLabel(session, data);
        return;
      }

      if (data.step === 'barcode') {
        await this.captureBarcode(session, data);
        return;
      }

      if (data.step === 'expiry') {
        await this.captureExpiry(session, data);
      }
    });

    session.events.onDisconnected(() => {
      this.sessions.delete(sessionId);
      console.log(`Session disconnected: ${sessionId}`);
    });
  }

  private async beginFlow(session: any, data: SessionData) {
    data.ext = resetExtraction();
    data.step = 'front';

    await session.audio.speak(
      'Starting scan. Hold the front label still in view, then press the button to capture the product image.'
    );
  }

  private async cancelFlow(session: any, data: SessionData) {
    data.step = 'idle';
    data.ext = resetExtraction();
    await session.audio.speak('Scan cancelled.');
  }

  private async takePhoto(session: any, label: string) {
    console.log(`Capturing photo for step: ${label}`);

    const photo = await session.camera.requestPhoto({
      compress: 'medium',
      size: 'large',
    });

    const bytes =
      photo?.buffer && typeof photo.buffer.length === 'number'
        ? photo.buffer.length
        : 0;

    console.log('Photo captured', {
      step: label,
      bytes,
      hasBuffer: !!photo?.buffer,
      mimeType: photo?.mimeType || 'image/jpeg',
    });

    if (!photo?.buffer || bytes === 0) {
      throw new Error(`No image buffer returned for step: ${label}`);
    }

    return {
      base64: photo.buffer.toString('base64'),
      mimeType: photo?.mimeType || 'image/jpeg',
      bytes,
    };
  }

  private async runGemini(
    prompt: string,
    base64: string,
    mimeType: string,
    label: string
  ) {
    console.log(`Sending image to Gemini for step: ${label}`);
    console.log(`Base64 length for ${label}:`, base64.length);

    const resp = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: base64,
        },
      },
      prompt,
    ]);

    const text = resp.response.text();
    console.log(`Gemini raw response for ${label}:`, text);

    const parsed = parseJSON(text);
    console.log(`Gemini parsed response for ${label}:`, parsed);

    return { text, parsed };
  }

  private async captureFrontLabel(session: any, data: SessionData) {
    try {
      await session.audio.speak('Capturing product image now.');

      const photo = await this.takePhoto(session, 'front');

      const prompt = `Analyze this product package front label.
Extract ONLY clearly visible info.
Reply ONLY with JSON:
{"product_name":null,"manufacturer":null}
Rules:
- product_name should be the main product name
- manufacturer should be the brand or maker
- use null if unclear`;

      const { parsed, text } = await this.runGemini(
        prompt,
        photo.base64,
        photo.mimeType,
        'front'
      );

      if (!parsed || !parsed.product_name) {
        await session.audio.speak(
          'I captured the image, but I could not identify the product yet. Please hold the front label closer and steadier, then press the button again.'
        );
        return;
      }

      data.ext.productName = parsed.product_name;
      data.ext.manufacturer = parsed.manufacturer || null;
      data.step = 'barcode';

      const spokenResult = parsed.manufacturer
        ? `I found ${parsed.product_name} by ${parsed.manufacturer}.`
        : `I found ${parsed.product_name}.`;

      console.log('Front capture succeeded:', {
        productName: data.ext.productName,
        manufacturer: data.ext.manufacturer,
        geminiText: text,
      });

      await session.audio.speak(
        `${spokenResult} Now show the barcode and press the button.`
      );
    } catch (err) {
      console.error('Front label capture failed:', err);
      await session.audio.speak(
        'I had trouble reading that image. Please try again.'
      );
    }
  }

  private async captureBarcode(session: any, data: SessionData) {
    try {
      await session.audio.speak('Capturing barcode image now.');

      const photo = await this.takePhoto(session, 'barcode');

      const prompt = `Analyze this image for a product barcode or QR code.
Extract ONLY clearly visible info.
Reply ONLY with JSON:
{"barcode":null}
Rules:
- barcode should be the decoded numeric or alphanumeric value if visible
- use null if not readable`;

      const { parsed, text } = await this.runGemini(
        prompt,
        photo.base64,
        photo.mimeType,
        'barcode'
      );

      if (!parsed || !parsed.barcode) {
        await session.audio.speak(
          'I captured the image, but I could not read the barcode. Please center the barcode, hold it still, and press the button again.'
        );
        return;
      }

      data.ext.barcode = parsed.barcode;
      data.step = 'expiry';

      console.log('Barcode capture succeeded:', {
        barcode: data.ext.barcode,
        geminiText: text,
      });

      await session.audio.speak(
        `I found barcode ${parsed.barcode}. Now show the expiration date and press the button. Or say no expiration date.`
      );
    } catch (err) {
      console.error('Barcode capture failed:', err);
      await session.audio.speak(
        'I had trouble reading that barcode image. Please try again.'
      );
    }
  }

  private async captureExpiry(session: any, data: SessionData) {
    try {
      await session.audio.speak('Capturing expiration date image now.');

      const photo = await this.takePhoto(session, 'expiry');

      const prompt = `Analyze this image for an expiration date, best by date, or use by date.
Extract ONLY clearly visible info.
Reply ONLY with JSON:
{"expiry_date":null}
Rules:
- expiry_date must be YYYY-MM-DD
- use null if not readable`;

      const { parsed, text } = await this.runGemini(
        prompt,
        photo.base64,
        photo.mimeType,
        'expiry'
      );

      if (!parsed || !parsed.expiry_date) {
        await session.audio.speak(
          'I captured the image, but I could not read an expiration date. Please hold the date closer and steadier, press the button again, or say no expiration date.'
        );
        return;
      }

      data.ext.expiryDate = parsed.expiry_date;

      console.log('Expiry capture succeeded:', {
        expiryDate: data.ext.expiryDate,
        geminiText: text,
      });

      await session.audio.speak(`${expiryLine(parsed.expiry_date)} Saving now.`);
      await this.saveItem(session, data);
    } catch (err) {
      console.error('Expiry capture failed:', err);
      await session.audio.speak(
        'I had trouble reading that date image. Please try again.'
      );
    }
  }

  private async saveItem(session: any, data: SessionData) {
    if (!data.ext.productName) {
      await session.audio.speak(
        'I do not have a product name yet, so I cannot save this item.'
      );
      return;
    }

    data.step = 'saving';

    const ext = data.ext;
    const expiry = ext.expiryDate ? calcExpiry(ext.expiryDate) : null;

    console.log('Saving item to database:', {
      userId: data.userId,
      productName: ext.productName,
      manufacturer: ext.manufacturer,
      barcode: ext.barcode,
      expiryDate: ext.expiryDate,
      noExpiryConfirmed: ext.noExpiryConfirmed,
      isExpired: expiry?.isExpired ?? null,
      daysUntilExpiry: expiry?.days ?? null,
    });

    try {
      await db.query(
        `INSERT INTO scanned_items(
          user_id, scanned_at, product_name, manufacturer, barcode,
          expiry_date, is_expired, days_until_expiry,
          no_expiry_confirmed, stream_hls_url
        )
        VALUES($1, now(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          data.userId,
          ext.productName,
          ext.manufacturer || 'Unknown',
          ext.barcode,
          ext.expiryDate,
          expiry?.isExpired ?? null,
          expiry?.days ?? null,
          ext.noExpiryConfirmed,
          null,
        ]
      );

      let tts = `Saved: ${ext.productName}`;

      if (ext.manufacturer && ext.manufacturer !== 'Unknown') {
        tts += ` by ${ext.manufacturer}`;
      }

      if (ext.barcode) {
        tts += '. Barcode recorded';
      }

      if (ext.noExpiryConfirmed) {
        tts += '. No expiration date.';
      } else if (expiry?.isExpired) {
        tts += `. Expired ${Math.abs(expiry.days)} days ago. Please discard.`;
      } else if (expiry && expiry.days <= 7) {
        tts += `. Caution, expires in ${expiry.days} days.`;
      } else if (ext.expiryDate && expiry) {
        tts += `. Good for ${expiry.days} more days.`;
      } else {
        tts += '. No expiration date found.';
      }

      data.step = 'idle';
      data.ext = resetExtraction();

      await session.audio.speak(tts);
    } catch (err) {
      console.error('Database save failed:', err);
      data.step = 'idle';
      await session.audio.speak(
        'I had trouble saving that item to the database.'
      );
    }
  }

  private async readList(session: any, data: SessionData) {
    try {
      const { rows } = await db.query(
        `SELECT product_name, is_expired, days_until_expiry, no_expiry_confirmed
         FROM scanned_items
         WHERE user_id = $1
         ORDER BY scanned_at DESC
         LIMIT 20`,
        [data.userId]
      );

      if (!rows.length) {
        await session.audio.speak('No items scanned yet.');
        return;
      }

      const expired = rows.filter((r: any) => r.is_expired).length;
      const soon = rows.filter(
        (r: any) =>
          !r.is_expired &&
          r.days_until_expiry != null &&
          r.days_until_expiry <= 7
      ).length;

      const preview = rows
        .slice(0, 3)
        .map((r: any) => {
          if (r.no_expiry_confirmed) return `${r.product_name}, no expiry`;
          if (r.is_expired) return `${r.product_name}, expired`;
          if (r.days_until_expiry != null) {
            return `${r.product_name}, ${r.days_until_expiry} days`;
          }
          return `${r.product_name}, no date`;
        })
        .join('. ');

      await session.audio.speak(
        `${rows.length} items. ${expired} expired, ${soon} expiring soon. ${preview}`
      );
    } catch (err) {
      console.error('Read list failed:', err);
      await session.audio.speak('I had trouble loading scanned items.');
    }
  }

  protected async onStop(sessionId: string, _userId: string, reason: string) {
    this.sessions.delete(sessionId);
    console.log(`Session ${sessionId} ended: ${reason}`);
  }
}

const app = new ProductScannerApp({
  packageName: process.env.MENTRA_PACKAGE_NAME!,
  apiKey: process.env.MENTRA_API_KEY!,
  port: PORT,
});

app.start();
console.log(`Product scanner running on port ${PORT}`);
