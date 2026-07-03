# 끄적끄적 Mobile Web

Official 끄적끄적 mobile web/PWA MVP.

## Run Locally

```bash
cd doodle-mobile-web
npm start
```

Local URL:

```text
http://localhost:4174/
```

## Implemented Flow

- PWA manifest and iOS home-screen metadata
- First screen with official app icon
- Invite-code creation
- Invite-code acceptance
- Device-session user identity without phone/email login
- 100-day prompt draft source
- Today's prompt/session
- Drawing canvas with color, undo, clear
- Submit drawing
- Modify drawing once on the same day
- Delete drawing with `삭제됨` state
- Reveal drawings after both users submit
- Poke event
- Archive list
- Local Drive mock under `data/drive`
- Local Sheets mock JSONL under `data/sheets`

## Google Integration

Google Drive/Sheets write operations require OAuth access token or service account credentials.
An API key alone is not enough to upload files to Drive or append rows to Sheets.

Create `.env` from `.env.example` when credentials are ready:

```bash
cp .env.example .env
```

Supported environment variables:

```text
GOOGLE_API_KEY=
GOOGLE_ACCESS_TOKEN=
GOOGLE_SHEETS_ID=
GOOGLE_DRIVE_FOLDER_ID=
```

Current API status can be checked at:

```text
/api/google/status
```

## Local Data

Runtime data is ignored by git:

```text
data/state.json
data/drive/
data/sheets/
```

## Checks

```bash
npm run check
```
