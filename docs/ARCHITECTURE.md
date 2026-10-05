# 2D Pro v2 — Architecture

## Overview
Complete rebuild of the 2D Master Pro / 2D Agent Pro apps.
- **Backend**: PocketBase on Singapore VPS (https://sought-slides-douglas-wagner.trycloudflare.com)
- **Frontend**: PWA (HTML/CSS/JS), local-first with IndexedDB
- **Goal**: Works on any network (data/wifi/vpn), offline-capable, sellable quality

## Collections (PocketBase)
1. **tenants** — `name` (Text)
2. **sessions** — `tenant` (Relation), `name`, `date`, `timeType`, `is_open` (Bool)
3. **lottery_records** — `tenant`, `session`, `number`, `amount`, `agent_name`, `record_type` (pos/akan), `batch_no`
4. **winning_numbers** — `tenant`, `session`, `number`, `week_monday`
5. **agents** — `tenant`, `name`, `phone`, `commission`, `payout_rate`
6. **app_settings** — `tenant`, `key`, `value`
7. **users** (built-in auth) — Main accounts

## Local-First Strategy
- **IndexedDB** (via simple wrapper) stores all data locally
- UI reads from IndexedDB (instant, no network wait)
- Background sync pushes/pulls to PocketBase
- Conflict resolution: last-write-wins with timestamps
- Offline queue: operations queued when offline, synced when online

## Auth Flow
### Master (Main)
- Email/password via PocketBase `users` collection
- On login: create/get tenant, store tenant ID locally

### Agent
- Simple: Main link code (tenant ID) + agent name
- No password needed (or optional device password)
- Data scoped to tenant

## Key Features (from v1)
1. Sessions management
2. Digital board (paste/type, formula parsing)
3. Ledger (00-99 grid, over-limit highlighting)
4. Winning numbers
5. 📊 ကျန်ဂဏန်း (Remaining digits, 10-week history)
6. 📋 Copy Total (for shareholders)
7. Daily summary
8. Agent management
9. Vouchers (per-agent)
10. ALL TOTAL

## Formula Parser
Port the v218.x formula parser (R/r/အာ/@, ထိပ်/နောက်, BK, ခွေ/ပူး, etc.)
Keep all working formulas from v1.

## Project Structure
```
2d-pro-v2/
├── shared/          # Shared JS (db wrapper, sync, parser, utils)
│   ├── db.js        # IndexedDB wrapper
│   ├── pb.js        # PocketBase client wrapper
│   ├── sync.js      # Background sync logic
│   ├── parser.js    # Formula parser (from v1)
│   └── utils.js     # Helpers
├── master/          # Master app (PWA)
│   ├── index.html
│   ├── app.js
│   └── style.css
├── agent/           # Agent app (PWA)
│   ├── index.html
│   ├── app.js
│   └── style.css
└── docs/            # Documentation
```

## API Base
`https://sought-slides-douglas-wagner.trycloudflare.com`

Note: This is a temporary tunnel URL. For production, use the VPS direct IP or a proper domain.
