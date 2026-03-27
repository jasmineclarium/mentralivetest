# Mentra Live Product Scanner

Smart glasses app — scan products, read barcodes, track expiry dates. Fully voice-driven.

## What it does
- Point glasses at a product → identifies it aloud
- Rotate to show barcode → "Barcode captured"
- Rotate to show expiry → reads it, warns if expired
- Say "no expiration date" → saves without one
- All items saved to Postgres, viewable in dashboard

## Setup

### 1. Get API keys
| Key | Where |
|-----|-------|
| Mentra | console.mentra.glass → Create App |
| Gemini | aistudio.google.com/apikey (free) |
| Anthropic | console.anthropic.com |

### 2. Railway setup
1. railway.com → New Project → Deploy from GitHub → pick this repo
2. Add Plugin → PostgreSQL
3. Settings → Networking → Generate Domain → copy URL
4. Variables tab → add all keys from .env.example
5. DATABASE_URL is filled automatically by Railway

### 3. Register with Mentra
1. console.mentra.glass → Create App
2. Server URL: your Railway domain
3. Permissions: Camera + Microphone

### 4. Run the database schema
Railway → PostgreSQL plugin → Data tab → Query → paste schema.sql → Run

## Voice commands
| Say | Does |
|-----|------|
| "scan" | Start scanning |
| "save" / "done" | Save item |
| "no expiration date" | Save without expiry |
| "cancel" | Cancel scan |
| "list" | Hear recent items |
| Speak a date ("march 2026") | Set expiry by voice |

## Local dev
```bash
npm install
cp .env.example .env
# fill in keys
npm run dev
# expose with: ngrok http 3000
```
