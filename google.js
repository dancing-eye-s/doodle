const crypto = require("node:crypto");

const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";

let cachedCredentials = null;
let cachedToken = null;
let cachedSheetTitle = null;
let ensuredSheets = new Set();

const GLOBAL_SHEET_TITLE = "전체 로그";
const GLOBAL_HEADERS = [
  "기록시각(created_at)",
  "이벤트ID(event_id)",
  "이벤트종류(event_type)",
  "사용자ID(user_id)",
  "관계방ID(couple_id)",
  "날짜(date)",
  "세션ID(session_id)",
  "그림ID(drawing_id)",
  "채팅ID(chat_id)",
  "닉네임(profile_name)",
  "요청ID(request_id)",
  "상세데이터(payload_json)",
];
const PAIR_HEADERS = [
  "기록시각(created_at)",
  "이벤트ID(event_id)",
  "이벤트종류(event_type)",
  "날짜(date)",
  "사용자ID(user_id)",
  "닉네임(profile_name)",
  "상대사용자ID(partner_user_id)",
  "세션ID(session_id)",
  "질문ID(prompt_id)",
  "질문내용(prompt_text)",
  "그림ID(drawing_id)",
  "그림상태(drawing_status)",
  "드라이브파일ID(drive_file_id)",
  "파일URL(file_url)",
  "채팅ID(chat_id)",
  "채팅내용(chat_text)",
  "이모티콘(emoji)",
  "상세데이터(payload_json)",
];

function loadCredentials() {
  if (cachedCredentials !== null) return cachedCredentials;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    cachedCredentials = false;
    return false;
  }

  try {
    cachedCredentials = JSON.parse(raw);
  } catch {
    cachedCredentials = false;
  }

  return cachedCredentials;
}

function isConfigured() {
  return Boolean(loadCredentials() && process.env.GOOGLE_SHEETS_ID && process.env.GOOGLE_DRIVE_FOLDER_ID);
}

function sanitizeSheetTitle(title) {
  return String(title || "sheet")
    .replace(/[\[\]\*\?\/\\:]/g, "_")
    .slice(0, 96);
}

function quoteSheetTitle(title) {
  const safeTitle = sanitizeSheetTitle(title);
  return `'${safeTitle.replace(/'/g, "''")}'`;
}

function sheetRange(title, range) {
  return `${quoteSheetTitle(title)}!${range}`;
}

function columnName(count) {
  let name = "";
  let n = count;

  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }

  return name || "A";
}

function pairSheetTitle(coupleId) {
  const compactId = String(coupleId || "unknown")
    .replace(/^couple_/, "")
    .replace(/[^a-zA-Z0-9가-힣_-]/g, "")
    .slice(0, 18);
  return sanitizeSheetTitle(`방_${compactId || "unknown"}`);
}

function jsonCell(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A service account can't just show up with an API key; it signs a short-lived
// JWT with its private key and trades that for an OAuth access token. Access
// tokens expire in ~1h, so we cache and refresh a little before expiry.
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const credentials = loadCredentials();

  if (!credentials) {
    throw new Error("Google service account is not configured.");
  }

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: SCOPES,
      aud: credentials.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(credentials.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const response = await fetch(credentials.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Google auth failed: ${payload.error_description || payload.error || response.status}`);
  }

  cachedToken = { accessToken: payload.access_token, expiresAt: now + payload.expires_in };
  return cachedToken.accessToken;
}

async function checkAuth() {
  await getAccessToken();
  return true;
}

const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";
let cachedUserToken = null;

function oauthConfigured() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function userAuthorized() {
  return Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
}

function getAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code, redirectUri) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`OAuth exchange failed: ${payload.error_description || payload.error || response.status}`);
  }

  return payload;
}

// The service account has to sign its own JWT; a person's OAuth token instead
// refreshes from the refresh_token we got once during consent. Files created
// with this token are owned by the real Google account, so they count against
// that account's own 15GB, sidestepping the service account's 0-quota wall.
async function getUserAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (cachedUserToken && cachedUserToken.expiresAt > now + 60) {
    return cachedUserToken.accessToken;
  }

  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error("Google OAuth is not authorized yet (no refresh token).");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`OAuth refresh failed: ${payload.error_description || payload.error || response.status}`);
  }

  cachedUserToken = { accessToken: payload.access_token, expiresAt: now + payload.expires_in };
  return cachedUserToken.accessToken;
}

// Drive reads/writes prefer the real account's OAuth token (so uploads count
// against the person's own quota); Sheets keeps using the service account
// since that already works and doesn't need the human in the loop.
async function resolveDriveToken() {
  if (userAuthorized()) return getUserAccessToken();
  return getAccessToken();
}

async function getSheetTitle(token) {
  if (cachedSheetTitle) return cachedSheetTitle;

  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to read spreadsheet: ${payload.error?.message || response.status}`);
  }

  cachedSheetTitle = payload.sheets?.[0]?.properties?.title || "Sheet1";
  return cachedSheetTitle;
}

async function getSheetTitles(token) {
  const sheets = await getSpreadsheetSheets(token);
  return sheets.map((sheet) => sheet.title).filter(Boolean);
}

async function getSpreadsheetSheets(token) {
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to read spreadsheet: ${payload.error?.message || response.status}`);
  }

  return (payload.sheets || [])
    .map((sheet) => sheet.properties)
    .filter((properties) => properties?.title);
}

async function ensureSheet(title, headers) {
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const safeTitle = sanitizeSheetTitle(title);
  const cacheKey = `${safeTitle}:${headers.join("|")}`;

  if (ensuredSheets.has(cacheKey)) {
    return safeTitle;
  }

  const sheets = await getSpreadsheetSheets(token);
  const exists = sheets.some((sheet) => sheet.title === safeTitle);

  if (!exists) {
    const addResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: safeTitle,
                gridProperties: {
                  frozenRowCount: 1,
                },
              },
            },
          },
        ],
      }),
    });
    const addPayload = await addResponse.json().catch(() => ({}));

    if (!addResponse.ok) {
      throw new Error(`Sheet create failed: ${addPayload.error?.message || addResponse.status}`);
    }
  }

  const headerRange = encodeURIComponent(sheetRange(safeTitle, `A1:${columnName(headers.length)}1`));
  const readResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${headerRange}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const readPayload = await readResponse.json().catch(() => ({}));

  if (!readResponse.ok) {
    throw new Error(`Sheet header read failed: ${readPayload.error?.message || readResponse.status}`);
  }

  const currentHeaders = readPayload.values?.[0] || [];
  const shouldWriteHeaders = headers.some((header, index) => currentHeaders[index] !== header);

  if (shouldWriteHeaders) {
    const writeResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${headerRange}?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [headers] }),
      },
    );
    const writePayload = await writeResponse.json().catch(() => ({}));

    if (!writeResponse.ok) {
      throw new Error(`Sheet header write failed: ${writePayload.error?.message || writeResponse.status}`);
    }
  }

  ensuredSheets.add(cacheKey);
  return safeTitle;
}

async function appendSheetRow(values) {
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const title = await getSheetTitle(token);
  const range = encodeURIComponent(`${title}!A1`);

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${range}:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] }),
    },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Sheets append failed: ${payload.error?.message || response.status}`);
  }

  return payload;
}

async function appendSheetRowToSheet(title, values, headers) {
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const safeTitle = await ensureSheet(title, headers);
  const range = encodeURIComponent(sheetRange(safeTitle, "A1"));

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${range}:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [values] }),
    },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Sheets append failed: ${payload.error?.message || response.status}`);
  }

  return payload;
}

function globalEventRow(event) {
  const payload = event.payload || {};

  return [
    event.created_at || "",
    event.event_id || "",
    event.event_type || "",
    payload.user_id || "",
    payload.couple_id || "",
    payload.date || "",
    payload.session_id || "",
    payload.drawing_id || "",
    payload.chat_id || "",
    payload.profile_name || payload.display_name || "",
    payload.request_id || "",
    jsonCell(payload),
  ];
}

function pairEventRow(event) {
  const payload = event.payload || {};

  return [
    event.created_at || "",
    event.event_id || "",
    event.event_type || "",
    payload.date || "",
    payload.user_id || "",
    payload.profile_name || payload.display_name || "",
    payload.partner_user_id || "",
    payload.session_id || "",
    payload.prompt_id || "",
    payload.prompt_text || "",
    payload.drawing_id || "",
    payload.drawing_status || payload.status || "",
    payload.drive_file_id || "",
    payload.file_url || "",
    payload.chat_id || "",
    payload.chat_text || "",
    payload.emoji || "",
    jsonCell(payload),
  ];
}

async function ensurePairSheet(coupleId) {
  return ensureSheet(pairSheetTitle(coupleId), PAIR_HEADERS);
}

async function appendDatabaseEvent(event) {
  await appendSheetRowToSheet(GLOBAL_SHEET_TITLE, globalEventRow(event), GLOBAL_HEADERS);

  if (event.payload?.couple_id) {
    await appendSheetRowToSheet(pairSheetTitle(event.payload.couple_id), pairEventRow(event), PAIR_HEADERS);
  }
}

async function readDatabaseEvents() {
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  await ensureSheet(GLOBAL_SHEET_TITLE, GLOBAL_HEADERS);
  const range = encodeURIComponent(sheetRange(GLOBAL_SHEET_TITLE, `A2:${columnName(GLOBAL_HEADERS.length)}`));
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Sheet read failed: ${payload.error?.message || response.status}`);
  }

  return (payload.values || [])
    .map((row) => {
      let eventPayload = {};

      try {
        eventPayload = JSON.parse(row[11] || "{}");
      } catch {
        eventPayload = {};
      }

      return {
        created_at: row[0] || "",
        event_id: row[1] || "",
        event_type: row[2] || "",
        payload: eventPayload,
      };
    })
    .filter((event) => event.event_id && event.event_type);
}

async function uploadDriveFile({ name, mimeType, buffer }) {
  const token = await resolveDriveToken();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const boundary = `doodle-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf8"),
    buffer,
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);

  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Drive upload failed: ${payload.error?.message || response.status}`);
  }

  return payload.id;
}

async function deleteDriveFile(fileId) {
  const token = await resolveDriveToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok && response.status !== 404) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Drive delete failed: ${payload.error?.message || response.status}`);
  }
}

async function listDriveFolderFiles() {
  const token = await resolveDriveToken();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const files = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "1000",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });

    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(`Drive list failed: ${payload.error?.message || response.status}`);
    }

    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);

  return files;
}

async function clearSheets() {
  const token = await getAccessToken();
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const titles = await getSheetTitles(token);
  let sheetsCleared = 0;

  for (const title of titles) {
    const range = encodeURIComponent(`${title}!A:Z`);
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}/values/${range}:clear`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`Sheets clear failed: ${payload.error?.message || response.status}`);
    }

    sheetsCleared += 1;
  }

  cachedSheetTitle = null;
  ensuredSheets = new Set();
  return { sheetsCleared };
}

async function resetGoogleData() {
  const files = await listDriveFolderFiles();

  for (const file of files) {
    await deleteDriveFile(file.id);
  }

  return {
    driveFilesDeleted: files.length,
    ...(await clearSheets()),
  };
}

// A real write+delete round trip is the only way to know Drive uploads will
// actually work: a service account can have "editor" access to a folder and
// still get rejected on upload because it has no storage quota of its own.
async function checkDriveWrite() {
  const fileId = await uploadDriveFile({
    name: "_doodle_health_check.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("ok"),
  });
  await deleteDriveFile(fileId);
  return true;
}

async function downloadDriveFile(fileId) {
  const token = await resolveDriveToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Drive download failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  isConfigured,
  checkAuth,
  checkDriveWrite,
  appendSheetRow,
  appendDatabaseEvent,
  readDatabaseEvents,
  ensurePairSheet,
  uploadDriveFile,
  downloadDriveFile,
  deleteDriveFile,
  resetGoogleData,
  oauthConfigured,
  userAuthorized,
  getAuthUrl,
  exchangeCodeForTokens,
};
