# v1-port: v1 Apps Ported to PocketBase

## Overview
These are the v1 2D Master Pro and 2D Agent Pro apps (from `~/workspace/2dMaster-app-fixed/`)
ported from Firebase to PocketBase. The UI is 100% identical to v1 (which Pho confirmed is
error-free). Only the backend data layer was changed.

## Files
- `master.html` - 2D Master Pro (v1 UI + PocketBase backend)
- `agent.html` - 2D Agent Pro (v1 UI + PocketBase backend)

## What Changed (vs v1)

### Removed
- Firebase SDK script tags (firebase-app-compat.js, firebase-database-compat.js, firebase-auth-compat.js)
- Firebase configuration (apiKey, databaseURL, etc.)
- Firebase Realtime Database WebSocket connections
- Firebase Auth (createUserWithEmailAndPassword, signInWithEmailAndPassword, etc.)
- Firebase REST fallback (restGet, restSet via firebasedatabase.app)
- Cloudflare Worker proxy for Firebase

### Added
- **PocketBase client** (`PB` object):
  - Base URL: `https://sought-slides-douglas-wagner.trycloudflare.com`
  - Auth via `/api/collections/users/auth-with-password`
  - Token persisted in localStorage
  - 15-second request timeout
- **Blob storage**: v1's `2d_*` keys stored as JSON in PocketBase `app_settings` collection
  - `2d_sessions` → app_settings (key='2d_sessions')
  - `2d_list_data` → app_settings (key='2d_list_data')
  - `2d_akan_data` → app_settings (key='2d_akan_data')
  - `2d_winning` → app_settings (key='2d_winning')
  - etc.
  - Tenant isolation via the `tenant` field
- **Auth flows**:
  - Master: `PB.register()` / `PB.login()` via users collection
  - Agent: Auto-login as `agent@2dpro.local` for sync

### Kept Unchanged
- All UI HTML/CSS (including HOMEscreens)
- All business logic (formula parser, ledger, vouchers, etc.)
- localStorage caching (offline support)
- `cloudSync.get(key, callback)` / `cloudSync.set(key, value, callback)` API
- `tp()` tenant key prefixing (now maps to PB tenant)

## HOMEscreens (already in v1)
- **Master** (`pageHome`): ⭐ ကစားပွဲစဉ်များ, 👥 လူအသစ်စာရင်းသွင်းရန်, 📊 တပတ်စာစာရင်းချုပ်, 🎯 ပေါက်သီး
- **Agent** (`pageHome`): 📝 စာရင်းသွင်းရန်, 👥 ထိုးသားစာရင်းများ, 📊 ကိုယ်ပိုင်စာရင်းချုပ်, 📅 ၇ ရက်စာ အချုပ်, 📄 စာရွက်ထုတ်ရန်/Save, 🎯 ပေါက်သီး စစ်ဆေးရန်

## Testing Status
- ✅ JavaScript syntax valid (node --check)
- ✅ PB adapter present in both files
- ✅ cloudSync uses PB.getSetting/PB.setSetting
- ⚠️  NOT yet tested in browser
- ⚠️  NOT yet deployed

## Deployment
To deploy, upload `master.html` and `agent.html` to GitHub repo `JohnZayar/2d-pro-v2`
under `v1-port/` folder, or serve directly.

## Known Limitations
1. **No realtime sync**: Firebase's `.on('value')` listeners disabled. Data refreshes on page load and manual sync.
2. **Blob storage**: Large datasets stored as single JSON blobs in app_settings. May hit PocketBase text field limits for very large data.
3. **Agent link verification**: Uses PB tenants API; requires agent account to be logged in.
4. **Device approval**: v1's device approval flow (`/deviceApprovals/`) disabled (was Firebase-specific).
