const crypto = require("node:crypto");

const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";

let cachedCredentials = null;
let cachedToken = null;
let cachedSheetTitle = null;

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
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetsId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to read spreadsheet: ${payload.error?.message || response.status}`);
  }

  return (payload.sheets || [])
    .map((sheet) => sheet.properties?.title)
    .filter(Boolean);
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
  uploadDriveFile,
  downloadDriveFile,
  deleteDriveFile,
  resetGoogleData,
  oauthConfigured,
  userAuthorized,
  getAuthUrl,
  exchangeCodeForTokens,
};
