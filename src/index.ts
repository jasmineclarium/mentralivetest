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

type AppState = 'idle' | 'collecting' | 'reviewing' | 'ready' | 'saving';

type CapturedImage = {
  base64: string;
  mimeType: string;
  capturedAt: string;
};

type ExtractedRecord = {
  productName: string | null;
  vendorName: string | null;
  countryOfOrigin: string | null;
  expirationDate: string | null;
  unavailableFields: string[];
};

type SessionData = {
  userId: string;
  state: AppState;
  images: CapturedImage[];
  record: ExtractedRecord;
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
  data.state = 'idle';
  data.images = [];
  data.record = emptyRecord();
}

function parseJSON(text: string) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (err) {
    console.error('parseJSON failed:', err);
    return null;
  }
}

function calcExpiry(d: string) {
  const ex = new Date(d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((ex.getTime() - today.getTime()) / 86400000);
  return { isExpired: days < 0, days };
}

function missingFields(record: ExtractedRecord) {
  return REQUIRED_FIELDS.filter((field) => {
    if (record.unavailableFields.includes(field)) return false;
    return !record[field];
  });
}

function fieldLabel(field: string) {
  switch (field) {
    case 'productName':
      return 'product';
    case 'vendorName':
      return 'vendor';
    case 'countryOfOrigin':
      return 'origin';
    case 'expirationDate':
      return 'expiration';
    default:
      return field;
  }
}

function shortMissingMessage(record: ExtractedRecord) {
  const missing = missingFields(record);
  if (!missing.length) return 'Ready to save.';
  return `Missing ${missing.map(fieldLabel).join(', ')}.`;
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
  if (
    lower.includes('expiration') ||
    lower.includes('expiry') ||
    lower.includes('best by') ||
    lower.includes('bb')
  ) {
    return 'expirationDate';
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

  const vendorMatch = lower.match(/(?:vendor|manufacturer|brand|seller)\s+(?:is\s+)?(.+)/);
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

function photoToCapturedImage(photo: any): CapturedImage | null {
  try {
    let raw: Buffer | null = null;

    if (photo?.buffer) {
      raw = Buffer.isBuffer(photo.buffer) ? photo.buffer : Buffer.from(photo.buffer);
    } else if (photo?.photoData) {
      raw = Buffer.isBuffer(photo.photoData)
        ? photo.photoData
        : Buffer.from(photo.photoData);
    } else if (photo?.data) {
      raw = Buffer.isBuffer(photo.data) ? photo.data : Buffer.from(photo.data);
    } else if (photo?.base64) {
      return {
        base64: photo.base64,
        mimeType: photo?.mimeType || 'image/jpeg',
        capturedAt: new Date().toISOString(),
      };
    }

    if (!raw || raw.length === 0) return null;

    return {
      base64: raw.toString('base64'),
      mimeType: photo?.mimeType || 'image/jpeg',
      capturedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('photoToCapturedImage failed:', err);
    return null;
  }
}

class ProductScannerApp extends AppServer {
  private sessions = new Map<string, SessionData>();

  constructor(config: { packageName: string; apiKey: string; port: number }) {
    super({
      ...config,
      subscriptions: {
        transcription: true,
        buttonPress: true,
        photoTaken: true,
      },
    });
  }

  protected async onSession(session: any, sessionId: string, userId: string) {
    const data: SessionData = {
      userId,
      state: 'idle',
      images: [],
      record: emptyRecord(),
    };

    this.sessions.set(sessionId, data);
    console.log(`Session started for user ${userId}`);

    // Attach handlers FIRST
    session.events.onTranscription(async (t: any) => {
      console.log('Raw transcription event:', JSON.stringify(t, null, 2));

      const text = (t?.text || '').toLowerCase().trim();
      console.log('Parsed transcription text:', text);

      if (!text) return;

      const isCaptureCommand =
        text === 'capture' ||
        text === 'scan' ||
        text.includes('capture image') ||
        text.includes('take picture') ||
        text.includes('scan product');

      if (isCaptureCommand) {
        if (data.state === 'reviewing' || data.state === 'saving') {
          await session.audio.speak('Still processing, please wait.');
          return;
        }

        try {
          resetItem(data);

          await session.audio.speak('Capturing image.');

          const photo = await session.camera.requestPhoto({
            metadata: {
              reason: 'product-scan',
              source: 'voice-command',
            },
          });

          console.log('requestPhoto returned', {
            hasPhotoData: !!photo?.photoData,
            hasBuffer: !!photo?.buffer,
            hasData: !!photo?.data,
            hasBase64: !!photo?.base64,
            mimeType: photo?.mimeType,
            keys: Object.keys(photo || {}),
          });

          await this.handleCapturedPhoto(session, data, photo);
        } catch (err) {
          console.error('requestPhoto failed:', err);
          data.state = 'idle';
          await session.audio.speak('Image capture failed.');
        }

        return;
      }

      if (text.includes('cancel') || text.includes('stop')) {
        resetItem(data);
        await session.audio.speak('Cancelled.');
        return;
      }

      if (text.includes('list') || text.includes('history')) {
        await this.readList(session, data);
        return;
      }

      if (data.state === 'ready') {
        const unavailable = parseUnavailableField(text);
        if (unavailable) {
          if (!data.record.unavailableFields.includes(unavailable)) {
            data.record.unavailableFields.push(unavailable);
          }

          const stillMissing = missingFields(data.record);
          if (!stillMissing.length && data.record.productName) {
            await this.saveItem(session, data, false);
          } else {
            await session.audio.speak(shortMissingMessage(data.record));
          }
          return;
        }

        const manual = parseManualField(text);
        if (manual) {
          data.record = { ...data.record, ...manual };

          if (data.record.productName) {
            await this.saveItem(session, data, false);
          } else {
            await session.audio.speak(shortMissingMessage(data.record));
          }
          return;
        }

        if (text === 'save' || text.includes('save as is')) {
          if (data.record.productName) {
            await this.saveItem(session, data, false);
          } else {
            await session.audio.speak('Need at least a product name.');
          }
          return;
        }

        if (text.includes('retake') || text.includes('another photo') || text.includes('more photo')) {
          data.state = 'idle';
          data.images = [];
          data.record = emptyRecord();
          await session.audio.speak('Ready. Say capture when you are ready.');
          return;
        }

        if (text.includes('close') || text.includes('done')) {
          resetItem(data);
          await session.audio.speak('Closed.');
          return;
        }
      }
    });

    session.events.onButtonPress(async (btn: any) => {
      console.log('Button press:', btn?.pressType, btn);
    });

    session.events.onPhotoTaken(async (photo: any) => {
      console.log('onPhotoTaken fired', {
        hasPhotoData: !!photo?.photoData,
        hasBuffer: !!photo?.buffer,
        hasData: !!photo?.data,
        hasBase64: !!photo?.base64,
        mimeType: photo?.mimeType,
        keys: Object.keys(photo || {}),
      });
    });

    session.events.onDisconnected(() => {
      this.sessions.delete(sessionId);
      console.log(`Session disconnected: ${sessionId}`);
    });

    // Subscribe AFTER handlers are attached
    try {
      await session.updateSubscriptions([
        {
          type: 'TRANSCRIPTION',
          config: {
            languages: ['en-US'],
            interimResults: false,
          },
        },
        {
          type: 'BUTTON_PRESS',
          config: {
            buttons: ['MAIN'],
          },
        },
      ]);
      console.log('Subscriptions updated successfully');
    } catch (err) {
      console.error('updateSubscriptions failed:', err);
    }

    await session.audio.speak(
      'Welcome to Clarium Vision. Say capture when you are ready to scan a product.'
    );
  }

  private async handleCapturedPhoto(session: any, data: SessionData, photo: any) {
    console.log('handleCapturedPhoto called', {
      state: data.state,
      hasPhotoData: !!photo?.photoData,
      hasBuffer: !!photo?.buffer,
      hasData: !!photo?.data,
      hasBase64: !!photo?.base64,
      mimeType: photo?.mimeType,
      keys: Object.keys(photo || {}),
    });

    if (data.state === 'reviewing' || data.state === 'saving') {
      await session.audio.speak('Still processing, please wait.');
      return;
    }

    try {
      const captured = photoToCapturedImage(photo);

      if (!captured) {
        console.error('Photo had no usable image data.', {
          hasPhotoData: !!photo?.photoData,
          hasBuffer: !!photo?.buffer,
          hasData: !!photo?.data,
          hasBase64: !!photo?.base64,
          mimeType: photo?.mimeType,
          keys: Object.keys(photo || {}),
        });
        await session.audio.speak('Photo failed.');
        data.state = 'idle';
        return;
      }

      data.images.push(captured);
      data.state = 'collecting';

      console.log('Photo captured, starting review', {
        count: data.images.length,
        mimeType: captured.mimeType,
        base64Length: captured.base64.length,
      });

      await session.audio.speak('Image captured. Processing.');

      const reviewed = await this.reviewCurrentItem(data);

      console.log('Review result', {
        reviewed,
        record: data.record,
      });

      if (reviewed && data.record.productName) {
        await this.saveItem(session, data, false);
      } else if (reviewed) {
        data.state = 'ready';
        await session.audio.speak(
          `Could not save automatically. ${shortMissingMessage(data.record)} Say corrections or retake.`
        );
      } else {
        data.state = 'idle';
        await session.audio.speak('Review failed.');
      }
    } catch (err) {
      console.error('Auto pipeline failed:', err);
      data.state = 'idle';
      await session.audio.speak('Processing failed.');
    }
  }

  private async reviewCurrentItem(data: SessionData): Promise<boolean> {
    if (!data.images.length) {
      return false;
    }

    data.state = 'reviewing';

    try {
      const prompt = `
You are extracting structured product packaging data from multiple photos of the SAME product.
Merge details across all photos into one record.

Return ONLY valid JSON:
{
  "product_name": null,
  "vendor_name": null,
  "country_of_origin": null,
  "expiration_date": null
}

Rules:
- Merge information across all photos.
- product_name = product or item name.
- vendor_name = vendor, manufacturer, brand, seller, or company if visible.
- country_of_origin = country of origin or made in.
- expiration_date = expiration, expiry, BB, best by, or use by date.
- expiration_date must be YYYY-MM-DD if possible.
- Use null if unknown.
`.trim();

      const parts: any[] = [
        { text: prompt },
        ...data.images.map((img) => ({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64,
          },
        })),
      ];

      console.log('Sending photos to Gemini', {
        photoCount: data.images.length,
        mimeTypes: data.images.map((i) => i.mimeType),
      });

      const resp = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
      });

      const text = resp?.response?.text?.() || '';
      const parsed = parseJSON(text);

      console.log('Gemini raw response:', text);
      console.log('Gemini parsed response:', parsed);

      if (!parsed) {
        console.error('Gemini returned unparseable JSON');
      } else {
        data.record.productName = parsed.product_name || data.record.productName;
        data.record.vendorName = parsed.vendor_name || data.record.vendorName;
        data.record.countryOfOrigin = parsed.country_of_origin || data.record.countryOfOrigin;
        data.record.expirationDate = parsed.expiration_date || data.record.expirationDate;
      }

      data.state = 'ready';
      return true;
    } catch (err: any) {
      console.error('Review failed:', {
        message: err?.message,
        status: err?.status,
        stack: err?.stack,
        raw: err,
      });

      data.state = 'idle';
      return false;
    }
  }

  private async saveItem(session: any, data: SessionData, startNext: boolean) {
    if (!data.record.productName) {
      await session.audio.speak('Need product name first.');
      return;
    }

    data.state = 'saving';

    const expiry = data.record.expirationDate
      ? calcExpiry(data.record.expirationDate)
      : null;

    try {
      console.log('Saving item to DB', {
        userId: data.userId,
        productName: data.record.productName,
        vendorName: data.record.vendorName,
        countryOfOrigin: data.record.countryOfOrigin,
        expirationDate: data.record.expirationDate,
        imageCount: data.images.length,
      });

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
          data.record.productName,
          data.record.vendorName,
          data.record.countryOfOrigin,
          data.record.expirationDate,
          expiry?.isExpired ?? null,
          expiry?.days ?? null,
          data.record.unavailableFields.includes('expirationDate'),
          JSON.stringify(data.images),
        ]
      );

      console.log('DB save successful');

      if (startNext) {
        data.images = [];
        data.record = emptyRecord();
        data.state = 'idle';
        await session.audio.speak('Image captured and saved. Ready for next product.');
      } else {
        resetItem(data);
        await session.audio.speak('Image captured and saved.');
      }
    } catch (err: any) {
      console.error('Save failed:', {
        message: err?.message,
        code: err?.code,
        detail: err?.detail,
        stack: err?.stack,
        raw: err,
      });

      data.state = 'ready';
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
