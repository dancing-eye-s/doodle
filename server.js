const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 4174);
const ROOT = __dirname;
const DATA_DIR = process.env.VERCEL
  ? path.join("/tmp", "doodle-mobile-web-data")
  : path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const DRIVE_MOCK_DIR = path.join(DATA_DIR, "drive");
const SHEETS_MOCK_DIR = path.join(DATA_DIR, "sheets");
const TIME_ZONE = "Asia/Seoul";

loadEnvFile();

const DEFAULT_STATE = {
  users: [],
  couples: [],
  invites: [],
  sessions: [],
  drawings: [],
  events: [],
  errors: [],
};

function loadEnvFile() {
  try {
    const raw = fsSync.readFileSync(path.join(ROOT, ".env"), "utf8");
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .forEach((line) => {
        const index = line.indexOf("=");
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();

        if (key && process.env[key] == null) {
          process.env[key] = value;
        }
      });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function todayKst() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateDiffDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00+09:00`);
  const end = new Date(`${endDate}T00:00:00+09:00`);
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let index = 0; index < 6; index += 1) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }

  return code;
}

async function ensureDataDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(DRIVE_MOCK_DIR, { recursive: true });
  await fs.mkdir(SHEETS_MOCK_DIR, { recursive: true });
}

async function readState() {
  await ensureDataDirs();

  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeState(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
}

async function writeState(state) {
  await ensureDataDirs();
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function appendSheetMock(tab, row) {
  await ensureDataDirs();
  await fs.appendFile(path.join(SHEETS_MOCK_DIR, `${tab}.jsonl`), `${JSON.stringify(row)}\n`);
}

async function readPrompts() {
  const raw = await fs.readFile(path.join(ROOT, "docs", "prompts-100.md"), "utf8");
  return raw
    .split("\n")
    .map((line) => line.match(/^(\d+)\.\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      prompt_id: `prompt_${String(match[1]).padStart(3, "0")}`,
      day_index: Number(match[1]),
      text_ko: match[2],
      status: "draft",
    }));
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: { message } });
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;

      if (body.length > 9_000_000) {
        request.destroy();
        reject(new Error("request-too-large"));
      }
    });
    request.on("end", () => resolve(body ? JSON.parse(body) : {}));
    request.on("error", reject);
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);

  if (pathname.startsWith("/data/")) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function getDeviceId(request) {
  const deviceId = String(request.headers["x-device-id"] || "").trim();

  if (!deviceId) {
    throw new Error("기기 세션을 확인하지 못했어요.");
  }

  return deviceId;
}

function ensureUser(state, deviceId, displayName = "") {
  let user = state.users.find((item) => item.device_id === deviceId);

  if (!user) {
    user = {
      user_id: id("user"),
      device_id: deviceId,
      display_name: displayName || "끄적러",
      created_at: nowIso(),
      last_seen_at: nowIso(),
    };
    state.users.push(user);
    addEvent(state, "user_created", { user_id: user.user_id });
  } else {
    user.last_seen_at = nowIso();

    if (displayName) {
      user.display_name = String(displayName).slice(0, 16);
    }
  }

  return user;
}

function addEvent(state, eventType, payload = {}) {
  const event = {
    event_id: id("event"),
    event_type: eventType,
    payload,
    created_at: nowIso(),
  };
  state.events.push(event);
  return event;
}

async function persistEvent(event) {
  await appendSheetMock("events", event);
}

async function persistNewEvents(state, beforeCount) {
  const newEvents = state.events.slice(beforeCount);

  for (const event of newEvents) {
    await persistEvent(event);
  }
}

function coupleForUser(state, userId) {
  return state.couples.find(
    (couple) => couple.status === "active" && [couple.user_a_id, couple.user_b_id].includes(userId),
  );
}

async function getTodayContext(state, user) {
  const date = todayKst();
  const couple = coupleForUser(state, user.user_id);
  const prompts = await readPrompts();

  if (!couple) {
    return { user, couple: null, date, prompt: null };
  }

  const dayIndex = Math.min(dateDiffDays(couple.created_date, date) + 1, prompts.length);
  const prompt = prompts[dayIndex - 1] || null;
  let session = state.sessions.find((item) => item.couple_id === couple.couple_id && item.date === date);

  if (!session) {
    session = {
      session_id: id("session"),
      couple_id: couple.couple_id,
      date,
      day_index: dayIndex,
      prompt_id: prompt?.prompt_id || "",
      revealed_at: "",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.sessions.push(session);
    addEvent(state, "daily_session_created", {
      couple_id: couple.couple_id,
      session_id: session.session_id,
      date,
      prompt_id: session.prompt_id,
    });
  }

  const myDrawing = drawingFor(state, session.session_id, user.user_id);
  const partnerId = couple.user_a_id === user.user_id ? couple.user_b_id : couple.user_a_id;
  const partnerDrawing = drawingFor(state, session.session_id, partnerId);
  const shouldReveal = myDrawing && partnerDrawing && !session.revealed_at;

  if (shouldReveal) {
    session.revealed_at = nowIso();
    session.updated_at = nowIso();
    addEvent(state, "drawing_revealed", {
      couple_id: couple.couple_id,
      session_id: session.session_id,
    });
  }

  return {
    user,
    couple,
    date,
    prompt,
    session,
    my_drawing: exposeDrawing(myDrawing, date),
    partner_drawing: exposeDrawing(partnerDrawing, date),
    revealed: Boolean(session.revealed_at),
  };
}

function drawingFor(state, sessionId, userId) {
  return state.drawings.find((drawing) => drawing.session_id === sessionId && drawing.user_id === userId);
}

function exposeDrawing(drawing, date) {
  if (!drawing) return null;

  return {
    drawing_id: drawing.drawing_id,
    status: drawing.status,
    file_url: drawing.status === "deleted" ? "" : drawing.file_url,
    submitted_at: drawing.submitted_at,
    modified_at: drawing.modified_at,
    modify_count: drawing.modify_count,
    deleted_at: drawing.deleted_at,
    can_modify: drawing.status !== "deleted" && drawing.date === date && drawing.modify_count < 1,
  };
}

async function saveDrawingFiles(coupleId, date, userId, imageData, strokes, version) {
  const folder = path.join(DRIVE_MOCK_DIR, "drawings", coupleId, date);
  await fs.mkdir(folder, { recursive: true });

  const imageMatch = String(imageData).match(/^data:image\/png;base64,(.+)$/);

  if (!imageMatch) {
    throw new Error("PNG 이미지 데이터가 필요해요.");
  }

  const imageFile = `${userId}-v${version}.png`;
  const jsonFile = `${userId}-v${version}.json`;
  await fs.writeFile(path.join(folder, imageFile), Buffer.from(imageMatch[1], "base64"));
  await fs.writeFile(path.join(folder, jsonFile), `${JSON.stringify(strokes || [], null, 2)}\n`);

  return {
    drive_file_id: `local:${imageFile}`,
    drive_json_file_id: `local:${jsonFile}`,
    file_url: `/api/files/drawings/${coupleId}/${date}/${imageFile}`,
  };
}

async function handleSession(request, response, state) {
  const body = request.method === "POST" ? await readBody(request) : {};
  const user = ensureUser(state, getDeviceId(request), String(body.display_name || ""));
  sendJson(response, 200, { user });
}

async function handleCreateInvite(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  let code = inviteCode();

  while (state.invites.some((invite) => invite.code === code && invite.status === "open")) {
    code = inviteCode();
  }

  const couple = {
    couple_id: id("couple"),
    user_a_id: user.user_id,
    user_b_id: "",
    created_at: nowIso(),
    created_date: todayKst(),
    status: "pending",
  };
  const invite = {
    invite_id: id("invite"),
    couple_id: couple.couple_id,
    code,
    created_by: user.user_id,
    created_at: nowIso(),
    status: "open",
  };
  state.couples.push(couple);
  state.invites.push(invite);
  addEvent(state, "invite_created", { user_id: user.user_id, couple_id: couple.couple_id });
  sendJson(response, 200, { invite: { code }, couple });
}

async function handleAcceptInvite(request, response, state) {
  const body = await readBody(request);
  const user = ensureUser(state, getDeviceId(request));
  const code = String(body.code || "").trim().toUpperCase();
  const invite = state.invites.find((item) => item.code === code && item.status === "open");

  if (!invite) {
    throw new Error("초대 코드를 찾지 못했어요.");
  }

  const couple = state.couples.find((item) => item.couple_id === invite.couple_id);

  if (!couple || couple.user_a_id === user.user_id) {
    throw new Error("이 초대 코드는 사용할 수 없어요.");
  }

  invite.status = "accepted";
  invite.accepted_by = user.user_id;
  invite.accepted_at = nowIso();
  couple.user_b_id = user.user_id;
  couple.status = "active";
  couple.activated_at = nowIso();
  addEvent(state, "invite_accepted", {
    user_id: user.user_id,
    couple_id: couple.couple_id,
  });
  sendJson(response, 200, { couple });
}

async function handleToday(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const context = await getTodayContext(state, user);
  sendJson(response, 200, context);
}

async function handleSubmitDrawing(request, response, state) {
  const body = await readBody(request);
  const user = ensureUser(state, getDeviceId(request));
  const context = await getTodayContext(state, user);
  const requestId = String(body.request_id || "");

  if (!context.couple || !context.session || !context.prompt) {
    throw new Error("먼저 초대 코드로 연결해주세요.");
  }

  let drawing = drawingFor(state, context.session.session_id, user.user_id);
  const idempotentDrawing = requestId
    ? state.drawings.find((item) => item.request_id === requestId && item.user_id === user.user_id)
    : null;

  if (idempotentDrawing) {
    sendJson(response, 200, { drawing: exposeDrawing(idempotentDrawing, context.date) });
    return;
  }

  const isModify = Boolean(drawing && drawing.status !== "deleted");

  if (isModify && drawing.modify_count >= 1) {
    throw new Error("수정은 하루에 한 번만 가능해요.");
  }

  const version = isModify ? drawing.modify_count + 1 : 0;
  const files = await saveDrawingFiles(
    context.couple.couple_id,
    context.date,
    user.user_id,
    body.image_data,
    body.strokes,
    version,
  );

  if (!drawing) {
    drawing = {
      drawing_id: id("drawing"),
      session_id: context.session.session_id,
      couple_id: context.couple.couple_id,
      user_id: user.user_id,
      date: context.date,
      prompt_id: context.prompt.prompt_id,
      submitted_at: nowIso(),
      modified_at: "",
      modify_count: 0,
      deleted_at: "",
      status: "submitted",
      request_id: requestId,
      ...files,
    };
    state.drawings.push(drawing);
    addEvent(state, "drawing_submitted", { drawing_id: drawing.drawing_id });
  } else {
    Object.assign(drawing, files, {
      modified_at: nowIso(),
      modify_count: drawing.modify_count + 1,
      status: "modified",
      request_id: requestId,
    });
    addEvent(state, "drawing_modified", { drawing_id: drawing.drawing_id });
  }

  context.session.updated_at = nowIso();
  await appendSheetMock("drawings", drawing);
  sendJson(response, 200, { drawing: exposeDrawing(drawing, context.date) });
}

async function handleDeleteDrawing(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const context = await getTodayContext(state, user);
  const drawing = context.session ? drawingFor(state, context.session.session_id, user.user_id) : null;

  if (!drawing || drawing.status === "deleted") {
    throw new Error("삭제할 오늘 그림이 없어요.");
  }

  drawing.status = "deleted";
  drawing.deleted_at = nowIso();
  addEvent(state, "drawing_deleted", { drawing_id: drawing.drawing_id });
  sendJson(response, 200, { drawing: exposeDrawing(drawing, context.date) });
}

async function handlePoke(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const couple = coupleForUser(state, user.user_id);

  if (!couple) {
    throw new Error("상대와 먼저 연결해주세요.");
  }

  addEvent(state, "poke_sent", { user_id: user.user_id, couple_id: couple.couple_id });
  sendJson(response, 200, { ok: true });
}

async function handleArchive(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const couple = coupleForUser(state, user.user_id);
  const prompts = await readPrompts();

  if (!couple) {
    sendJson(response, 200, { sessions: [] });
    return;
  }

  const sessions = state.sessions
    .filter((session) => session.couple_id === couple.couple_id)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((session) => {
      const partnerId = couple.user_a_id === user.user_id ? couple.user_b_id : couple.user_a_id;
      return {
        date: session.date,
        prompt: prompts.find((prompt) => prompt.prompt_id === session.prompt_id) || null,
        revealed: Boolean(session.revealed_at),
        my_drawing: exposeDrawing(drawingFor(state, session.session_id, user.user_id), session.date),
        partner_drawing: exposeDrawing(drawingFor(state, session.session_id, partnerId), session.date),
      };
    });

  addEvent(state, "archive_opened", { user_id: user.user_id, couple_id: couple.couple_id });
  sendJson(response, 200, { sessions });
}

async function handleFile(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const relative = decodeURIComponent(url.pathname.replace(/^\/api\/files\//, ""));
  const filePath = path.normalize(path.join(DRIVE_MOCK_DIR, relative));

  if (!filePath.startsWith(DRIVE_MOCK_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function googleStatus() {
  return {
    api_key_present: Boolean(process.env.GOOGLE_API_KEY),
    access_token_present: Boolean(process.env.GOOGLE_ACCESS_TOKEN),
    sheets_id_present: Boolean(process.env.GOOGLE_SHEETS_ID),
    drive_folder_id_present: Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID),
    write_ready: Boolean(process.env.GOOGLE_ACCESS_TOKEN && process.env.GOOGLE_SHEETS_ID),
    note: "Drive/Sheets write operations require OAuth access token or service account credentials. API key alone is not sufficient.",
  };
}

async function routeApi(request, response, state) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "POST" && url.pathname === "/api/session") return handleSession(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/invites") return handleCreateInvite(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/invites/accept") return handleAcceptInvite(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/today") return handleToday(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/drawings/submit") return handleSubmitDrawing(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/drawings/delete") return handleDeleteDrawing(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/poke") return handlePoke(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/archive") return handleArchive(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/google/status") return sendJson(response, 200, googleStatus());
  if (request.method === "GET" && url.pathname.startsWith("/api/files/")) return handleFile(request, response);

  sendError(response, 404, "API 경로를 찾지 못했어요.");
}

async function appHandler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const isApi = url.pathname.startsWith("/api/");
  const state = isApi ? await readState() : null;
  const beforeEventCount = state?.events.length || 0;

  try {
    if (isApi) {
      await routeApi(request, response, state);
      await persistNewEvents(state, beforeEventCount);
      await writeState(state);
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    if (state) {
      state.errors.push({
        error_id: id("error"),
        message: error.message,
        created_at: nowIso(),
      });
      await writeState(state);
    }

    const message = error.message === "request-too-large" ? "요청 데이터가 너무 커요." : error.message;
    sendError(response, 400, message || "서버 오류가 발생했어요.");
  }
}

if (require.main === module) {
  const server = http.createServer(appHandler);

  server.listen(PORT, () => {
    console.log(`doodle mobile web: http://localhost:${PORT}`);
  });
}

module.exports = appHandler;
