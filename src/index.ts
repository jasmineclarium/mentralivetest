import MentraSDK from '@mentra/sdk';
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';

const { AppServer } = MentraSDK as any;

const PORT = parseInt(process.env.PORT || '3000', 10);

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });

type AppState = 'idle' | 'collecting' | 'review' | 'saving';

type ExtractedRecord = {
  productName: string | null;
  vendorName: string | null;
  countryOfOrigin: string | null;
  expirationDate: string | null;
  unavailableFields: string[];
};

type CapturedImage = {
  base64: string;
  mimeType: string;
  capturedAt: string;
};

type SessionData = {
  userId: string;
  state: AppState;
  images: CapturedImage[];
  merged: ExtractedRecord;
};

const REQUIRED_FIELDS: Array<keyof Omit<ExtractedRecord, 'unavailableFields'>> = [
  'productName',
  'vendorName',
  'countryOfOrigin',
  'expirationDate',
];

function emptyRecord(): ExtractedRecord {
  return {
    productName: null,
    vendorName: null,
    countryOfOrigin: null,
    expirationDate: null,
    unavailableFields: [],
  };
}

function resetItem(data: SessionData) {
  data.images = [];
  data.merged = emptyRecord();
  data.state = 'idle';
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

function missingFields(record: ExtractedRecord) {
  return REQUIRED_FIELDS.filter((field) => {
    if (record.unavailableFields.includes(field)) return false;
    return !record[field];
  });
}

function compactFieldLabel(field: string) {
  switch (field) {
    case 'productName':
      return 'Product';
    case 'vendorName':
      return 'Vendor';
    case 'countryOfOrigin':
      return 'Origin';
    case 'expirationDate':
      return 'Expiry';
    default:
      return field;
  }
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

function parseManualField(text: string): Partial<ExtractedRecord> | null {
  const lower = text.toLowerCase().trim();

  const expiry = dateFromSpeech(lower);
  if (
    expiry &&
    (lower.includes('expiration') ||
      lower.includes('expiry') ||
      lower.includes('best by') ||
      lower.includes('bb') ||
      lower.includes('use by'))
  ) {
    return { expirationDate: expiry };
  }

  const vendorMatch = lower.match(/(?:vendor|seller|manufacturer|brand)\s+(?:is\s+)?(.+)/);
  if (vendorMatch) {
    return { vendorName: vendorMatch[1].trim() };
  }

  const productMatch = lower.match(/(?:product|name)\s+(?:is\s+)?(.+)/);
  if (productMatch) {
    return { productName: productMatch[1].trim() };
  }

  const originMatch = lower.match(/(?:country of origin|origin|made in)\s+(?:is\s+)?(.+)/);
  if (originMatch) {
    return { countryOfOrigin: originMatch[1].trim() };
  }

  return null;
}

function parseUnavailableField(text: string): keyof Omit<ExtractedRecord, 'unavailableFields'> | null {
  const lower = text.toLowerCase();

  if (!(lower.includes('not available') || lower.includes('unknown') || lower.includes('not on package'))) {
    return null;
  }

  if (lower.includes('vendor') || lower.includes('manufacturer') || lower.includes('brand')) {
    return 'vendorName';
  }
  if (lower.includes('product') || lower.includes('name')) {
    return 'productName';
  }
  if (lower.includes('origin') || lower.includes('country')) {
    return 'countryOfOrigin';
  }
  if (lower.includes('expiry') || lower.includes('expiration') || lower.includes('best by') || lower.includes('bb')) {
    return 'expirationDate';
  }

  return null;
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
      state: 'idle',
      images: [],
      merged: emptyRecord(),
    };

    this.sessions.set(sessionId, data);

    await this.renderStatus(session, data);
    await session.audio.speak('Scanner ready.');

    session.events.onPhotoTaken(async (photo: any) => {
      try {
        if (data.state !== 'collecting') {
          return;
        }

        const base64 = Buffer.from(photo.photoData).toString('base64');
        data.images.push({
          base64,
          mimeType: photo.mimeType || 'image/jpeg',
          capturedAt: new Date().toISOString(),
        });

        console.log('Photo added to current item', {
          count: data.images.length,
          mimeType: photo.mimeType,
          bytes: base64.length,
        });

        await this.renderStatus(session, data);
      } catch (err) {
        console.error('onPhotoTaken failed:', err);
        await session.layouts.showTextWall('Photo failed', { durationMs: 1500 });
      }
    });

    session.events.onTranscription(async (t: any) => {
      if (!t.isFinal) return;

      const text = (t.text || '').toLowerCase().trim();
      console.log('Final transcription:', text);

      if (text.includes('cancel') || text.includes('stop')) {
        resetItem(data);
        await this.renderStatus(session, data);
        await session.audio.speak('Cancelled.');
        return;
      }

      if (data.state === 'idle') {
        if (text.includes('scan') || text.includes('start')) {
          data.state = 'collecting';
          data.images = [];
          data.merged = emptyRecord();
          await this.renderStatus(session, data);
        } else if (text.includes('list') || text.includes('history')) {
          await this.readList(session, data);
        }
        return;
      }

      if (data.state === 'collecting') {
        if (text.includes('review') || text.includes('analyze') || text.includes('process')) {
          await this.reviewCurrentItem(session, data);
        }
        return;
      }

      if (data.state === 'review') {
        const unavailable = parseUnavailableField(text);
        if (unavailable) {
          if (!data.merged.unavailableFields.includes(unavailable)) {
            data.merged.unavailableFields.push(unavailable);
          }
          await this.renderStatus(session, data);
          return;
        }

        const manual = parseManualField(text);
        if (manual) {
          data.merged = {
            ...data.merged,
            ...manual,
          };
          await this.renderStatus(session, data);
          return;
        }

        if (text.includes('another photo') || text.includes('more photo') || text.includes('take more')) {
          data.state = 'collecting';
          await this.renderStatus(session, data);
          return;
        }

        if (text.includes('save next') || text.includes('save and next') || text.includes('save and add')) {
          await this.saveItem(session, data, true);
          return;
        }

        if (text === 'save' || text.includes('save as is')) {
          await this.saveItem(session, data, false);
          return;
        }

        if (text.includes('close') || text.includes('done')) {
          resetItem(data);
          await this.renderStatus(session, data);
          await session.audio.speak('Closed.');
          return;
        }
      }
    });

    session.events.onButtonPress(async (btn: any) => {
      console.log('Button press:', btn?.pressType);

      if (btn?.pressType === 'long') {
        if (data.state === 'idle') {
          await this.readList(session, data);
        } else {
          resetItem(data);
          await this.renderStatus(session, data);
          await session.audio.speak('Cancelled.');
        }
      }
    });

    session.events.onDisconnected(() => {
      this.sessions.delete(sessionId);
    });
  }

  private async renderStatus(session: any, data: SessionData) {
    if (data.state === 'idle') {
      await session.layouts.showReferenceCard({
        title: 'Product Scanner',
        text:
          'Say scan to start\n' +
          'Use camera button to take photos\n' +
          'Say review when done\n' +
          'Long press to cancel',
      });
      return;
    }

    if (data.state === 'collecting') {
      await session.layouts.showReferenceCard({
        title: `Photos: ${data.images.length}`,
        text:
          'Use camera button for 1+ sides\n' +
          'Say review when done\n' +
          'Long press cancels',
      });
      return;
    }

    const missing = missingFields(data.merged);
    const summary =
      `Product: ${data.merged.productName || '-'}\n` +
      `Vendor: ${data.merged.vendorName || '-'}\n` +
      `Origin: ${data.merged.countryOfOrigin || '-'}\n` +
      `Expiry: ${data.merged.expirationDate || '-'}\n` +
      `Missing: ${missing.length ? missing.map(compactFieldLabel).join(', ') : 'None'}\n` +
      `Say save, save next, another photo, or a field value`;

    await session.layouts.showReferenceCard({
      title: 'Review Item',
      text: summary,
    });
  }

  private async reviewCurrentItem(session: any, data: SessionData) {
    if (!data.images.length) {
      await session.audio.speak('No photos yet.');
      return;
    }

    data.state = 'saving';
    await session.layouts.showTextWall('Analyzing...');

    try {
      const prompt = `You are extracting structured product packaging data from multiple photos of the SAME product.
Merge details across all images into one record.

Return ONLY JSON:
{
  "product_name": null,
  "vendor_name": null,
  "country_of_origin": null,
  "expiration_date": null
}

Rules:
- Merge information across all photos.
- product_name = product/item name
- vendor_name = seller, vendor, brand, manufacturer, or company if visible
- country_of_origin = country of origin or made in
- expiration_date = expiration, expiry, BB, best by, or use by date
- expiration_date must be YYYY-MM-DD if possible
- use null when unavailable or unreadable`;

      const parts: any[] = data.images.map((img) => ({
        inlineData: {
          mimeType: img.mimeType,
          data: img.base64,
        },
      }));

      parts.push(prompt);

      console.log('Sending photos to Gemini', { photoCount: data.images.length });

      const resp = await model.generateContent(parts);
      const text = resp.response.text();
      const parsed = parseJSON(text);

      console.log('Gemini raw response:', text);
      console.log('Gemini parsed response:', parsed);

      if (parsed) {
        data.merged.productName = parsed.product_name || data.merged.productName;
        data.merged.vendorName = parsed.vendor_name || data.merged.vendorName;
        data.merged.countryOfOrigin = parsed.country_of_origin || data.merged.countryOfOrigin;
        data.merged.expirationDate = parsed.expiration_date || data.merged.expirationDate;
      }

      data.state = 'review';
      await this.renderStatus(session, data);

      const missing = missingFields(data.merged);
      if (!missing.length) {
        await session.audio.speak('Ready to save.');
      } else {
        await session.audio.speak(
          `Missing ${missing.map(compactFieldLabel).join(', ')}.`
        );
      }
    } catch (err: any) {
      console.error('Review failed:', err);
      data.state = 'collecting';

      if (err?.status === 404) {
        await session.audio.speak('The AI model is unavailable.');
      } else if (err?.status === 429) {
        await session.audio.speak('The AI quota is exceeded.');
      } else {
        await session.audio.speak('Analysis failed.');
      }

      await this.renderStatus(session, data);
    }
  }

  private async saveItem(session: any, data: SessionData, startNext: boolean) {
    if (!data.merged.productName) {
      await session.audio.speak('Need product name before saving.');
      return;
    }

    data.state = 'saving';
    await session.layouts.showTextWall('Saving...');

    const expiry = data.merged.expirationDate ? calcExpiry(data.merged.expirationDate) : null;

    try {
      await db.query(
        `INSERT INTO scanned_items(
          user_id,
          scanned_at,
          product_name,
          vendor_name,
          country_of_origin,
          expiry_date,
          is_expired,
          days_until_expiry,
          no_expiry_confirmed,
          captured_images_json
        )
        VALUES($1, now(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          data.userId,
          data.merged.productName,
          data.merged.vendorName,
          data.merged.countryOfOrigin,
          data.merged.expirationDate,
          expiry?.isExpired ?? null,
          expiry?.days ?? null,
          data.merged.unavailableFields.includes('expirationDate'),
          JSON.stringify(data.images),
        ]
      );

      if (startNext) {
        data.images = [];
        data.merged = emptyRecord();
        data.state = 'collecting';
        await this.renderStatus(session, data);
        await session.audio.speak('Saved. Next item.');
      } else {
        resetItem(data);
        await this.renderStatus(session, data);
        await session.audio.speak('Saved.');
      }
    } catch (err) {
      console.error('Save failed:', err);
      data.state = 'review';
      await this.renderStatus(session, data);
      await session.audio.speak('Save failed.');
    }
  }

  private async readList(session: any, data: SessionData) {
    try {
      const { rows } = await db.query(
        `SELECT product_name, vendor_name, days_until_expiry, is_expired
         FROM scanned_items
         WHERE user_id = $1
         ORDER BY scanned_at DESC
         LIMIT 5`,
        [data.userId]
      );

      if (!rows.length) {
        await session.audio.speak('No items yet.');
        return;
      }

      const preview = rows
        .map((r: any) => {
          if (r.is_expired) return `${r.product_name}, expired`;
          if (r.days_until_expiry != null) return `${r.product_name}, ${r.days_until_expiry} days`;
          return `${r.product_name}`;
        })
        .join('. ');

      await session.audio.speak(preview);
    } catch (err) {
      console.error('Read list failed:', err);
      await session.audio.speak('Could not load items.');
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
