const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const google = require("./google");

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
  chats: [],
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

    if (google.isConfigured()) {
      try {
        const events = await google.readDatabaseEvents();

        if (events.length) {
          const restoredState = buildStateFromEvents(events);
          await writeState(restoredState);
          return restoredState;
        }
      } catch (restoreError) {
        console.error("Google Sheets state restore failed:", restoreError.message);
      }
    }

    const initialState = structuredClone(DEFAULT_STATE);
    await writeState(initialState);
    return initialState;
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

function upsertById(items, key, value, patch) {
  let item = items.find((candidate) => candidate[key] === value);

  if (!item) {
    item = { [key]: value };
    items.push(item);
  }

  Object.assign(item, patch);
  return item;
}

function buildStateFromEvents(events) {
  const state = structuredClone(DEFAULT_STATE);

  events.forEach((event) => {
    state.events.push(event);
    const payload = event.payload || {};

    if (event.event_type === "user_created" && payload.user_id && payload.device_id) {
      upsertById(state.users, "user_id", payload.user_id, {
        user_id: payload.user_id,
        device_id: payload.device_id,
        display_name: payload.display_name || "끄적러",
        created_at: event.created_at,
        last_seen_at: event.created_at,
      });
      return;
    }

    if (event.event_type === "profile_updated" && payload.user_id) {
      upsertById(state.users, "user_id", payload.user_id, {
        user_id: payload.user_id,
        device_id: payload.device_id || "",
        display_name: payload.display_name || "끄적러",
        last_seen_at: event.created_at,
      });
      return;
    }

    if (event.event_type === "invite_created" && payload.couple_id && payload.invite_id) {
      upsertById(state.couples, "couple_id", payload.couple_id, {
        couple_id: payload.couple_id,
        user_a_id: payload.user_id || "",
        user_b_id: "",
        created_at: event.created_at,
        created_date: payload.created_date || todayKst(),
        status: "pending",
      });
      upsertById(state.invites, "invite_id", payload.invite_id, {
        invite_id: payload.invite_id,
        couple_id: payload.couple_id,
        code: payload.code || "",
        created_by: payload.user_id || "",
        created_at: event.created_at,
        status: "open",
      });
      return;
    }

    if (event.event_type === "invite_accepted" && payload.couple_id && payload.invite_id) {
      const couple = upsertById(state.couples, "couple_id", payload.couple_id, {
        couple_id: payload.couple_id,
        user_a_id: payload.user_a_id || "",
        user_b_id: payload.user_id || "",
        status: "active",
        activated_at: event.created_at,
      });
      if (!couple.created_at) couple.created_at = event.created_at;
      if (!couple.created_date) couple.created_date = payload.created_date || todayKst();
      upsertById(state.invites, "invite_id", payload.invite_id, {
        invite_id: payload.invite_id,
        couple_id: payload.couple_id,
        code: payload.code || "",
        created_by: payload.user_a_id || "",
        accepted_by: payload.user_id || "",
        accepted_at: event.created_at,
        status: "accepted",
      });
      return;
    }

    if (event.event_type === "daily_session_created" && payload.session_id) {
      upsertById(state.sessions, "session_id", payload.session_id, {
        session_id: payload.session_id,
        couple_id: payload.couple_id || "",
        date: payload.date || "",
        day_index: Number(payload.day_index || 0),
        prompt_id: payload.prompt_id || "",
        revealed_at: "",
        created_at: event.created_at,
        updated_at: event.created_at,
      });
      return;
    }

    if (event.event_type === "drawing_revealed" && payload.session_id) {
      const session = state.sessions.find((item) => item.session_id === payload.session_id);
      if (session) {
        session.revealed_at = event.created_at;
        session.updated_at = event.created_at;
      }
      return;
    }

    if (["drawing_submitted", "drawing_modified", "drawing_deleted"].includes(event.event_type) && payload.drawing) {
      upsertById(state.drawings, "drawing_id", payload.drawing.drawing_id, payload.drawing);
      return;
    }

    if (["chat_created", "chat_updated"].includes(event.event_type) && payload.chat) {
      upsertById(state.chats, "chat_id", payload.chat.chat_id, payload.chat);
    }
  });

  return state;
}

async function readPrompts() {
  const raw = await fs.readFile(path.join(ROOT, "docs", "prompts-100.md"), "utf8");
  return raw
    .split("\n")
    .map((line) => line.match(/^(\d+)\.\s+(.+)$/))
    .filter(Boolean)
    .map((match) => {
      const variants = {};

      match[2].split("||").forEach((part) => {
        const variantMatch = part.trim().match(/^\[(common|friend|lover|close)\]\s+(.+)$/);
        if (variantMatch) {
          variants[variantMatch[1]] = variantMatch[2].trim();
        }
      });

      if (!Object.keys(variants).length) {
        variants.common = match[2].trim();
      }

      return {
        prompt_id: `prompt_${String(match[1]).padStart(3, "0")}`,
        day_index: Number(match[1]),
        variants,
        category: "common",
        text_ko: variants.common || variants.close || Object.values(variants)[0],
        status: "draft",
      };
    });
}

function relationshipTypeFromRequest(request) {
  const relationshipType = String(request.headers["x-relationship-type"] || "close");
  return ["close", "friend", "lover"].includes(relationshipType) ? relationshipType : "close";
}

function promptsForRelationship(prompts, relationshipType) {
  return prompts.map((prompt) => ({
    ...prompt,
    text_ko:
      prompt.variants?.[relationshipType] ||
      prompt.variants?.close ||
      prompt.variants?.common ||
      prompt.text_ko,
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

function normalizeDisplayName(displayName) {
  return String(displayName || "").trim().slice(0, 16);
}

function ensureUser(state, deviceId, displayName = "") {
  let user = state.users.find((item) => item.device_id === deviceId);
  const normalizedDisplayName = normalizeDisplayName(displayName);

  if (!user) {
    user = {
      user_id: id("user"),
      device_id: deviceId,
      display_name: normalizedDisplayName || "끄적러",
      created_at: nowIso(),
      last_seen_at: nowIso(),
    };
    state.users.push(user);
    addEvent(state, "user_created", {
      user_id: user.user_id,
      device_id: user.device_id,
      display_name: user.display_name,
      profile_name: user.display_name,
    });
  } else {
    user.last_seen_at = nowIso();

    if (normalizedDisplayName && user.display_name !== normalizedDisplayName) {
      user.display_name = normalizedDisplayName;
      addEvent(state, "profile_updated", {
        user_id: user.user_id,
        device_id: user.device_id,
        display_name: user.display_name,
        profile_name: user.display_name,
      });
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

  if (google.isConfigured()) {
    try {
      await google.appendDatabaseEvent(event);
    } catch (error) {
      // A logging failure shouldn't take down the request that triggered it.
      console.error("Google Sheets log failed:", error.message);
    }
  }
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

async function getTodayContext(state, user, relationshipType = "close") {
  const date = todayKst();
  const couple = coupleForUser(state, user.user_id);
  const prompts = await readPrompts();
  const promptPool = promptsForRelationship(prompts, relationshipType);

  if (!couple) {
    return { user, couple: null, date, prompt: null };
  }

  const dayIndex = Math.min(dateDiffDays(couple.created_date, date) + 1, promptPool.length);
  let prompt = promptPool[dayIndex - 1] || null;
  let session = state.sessions.find((item) => item.couple_id === couple.couple_id && item.date === date);

  if (session) {
    prompt = prompts.find((item) => item.prompt_id === session.prompt_id) || prompt;
  }

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
      day_index: session.day_index,
      prompt_id: session.prompt_id,
      prompt_text: prompt?.text_ko || "",
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
      date,
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

function drawingSnapshot(drawing) {
  return {
    drawing_id: drawing.drawing_id,
    session_id: drawing.session_id,
    couple_id: drawing.couple_id,
    user_id: drawing.user_id,
    date: drawing.date,
    prompt_id: drawing.prompt_id,
    submitted_at: drawing.submitted_at,
    modified_at: drawing.modified_at,
    modify_count: drawing.modify_count,
    deleted_at: drawing.deleted_at,
    status: drawing.status,
    request_id: drawing.request_id,
    drive_file_id: drawing.drive_file_id,
    drive_json_file_id: drawing.drive_json_file_id,
    file_url: drawing.file_url,
  };
}

function drawingEventPayload(drawing, context, user) {
  return {
    user_id: user.user_id,
    profile_name: user.display_name,
    couple_id: context.couple.couple_id,
    session_id: context.session.session_id,
    date: context.date,
    prompt_id: context.prompt.prompt_id,
    prompt_text: context.prompt.text_ko,
    drawing_id: drawing.drawing_id,
    drawing_status: drawing.status,
    drive_file_id: drawing.drive_file_id,
    file_url: drawing.file_url,
    request_id: drawing.request_id || "",
    drawing: drawingSnapshot(drawing),
  };
}

function exposeChat(chat, user) {
  return {
    chat_id: chat.chat_id,
    date: chat.date,
    user_id: chat.user_id,
    profile_name: chat.profile_name,
    text: chat.text,
    emoji: chat.emoji,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
    can_edit: chat.user_id === user.user_id,
  };
}

function chatSnapshot(chat) {
  return {
    chat_id: chat.chat_id,
    couple_id: chat.couple_id,
    date: chat.date,
    user_id: chat.user_id,
    profile_name: chat.profile_name,
    text: chat.text,
    emoji: chat.emoji,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
  };
}

function chatEventPayload(chat) {
  return {
    user_id: chat.user_id,
    profile_name: chat.profile_name,
    couple_id: chat.couple_id,
    date: chat.date,
    chat_id: chat.chat_id,
    chat_text: chat.text,
    emoji: chat.emoji,
    chat: chatSnapshot(chat),
  };
}

async function saveDrawingFiles(coupleId, date, userId, imageData, strokes, version) {
  const imageMatch = String(imageData).match(/^data:image\/png;base64,(.+)$/);

  if (!imageMatch) {
    throw new Error("PNG 이미지 데이터가 필요해요.");
  }

  const imageBuffer = Buffer.from(imageMatch[1], "base64");
  const imageFile = `${userId}-v${version}.png`;

  if (google.isConfigured()) {
    try {
      const driveFileId = await google.uploadDriveFile({
        name: `${coupleId}_${date}_${imageFile}`,
        mimeType: "image/png",
        buffer: imageBuffer,
      });

      return {
        drive_file_id: driveFileId,
        drive_json_file_id: "",
        file_url: `/api/files/drive/${driveFileId}`,
      };
    } catch (error) {
      // A service account has no storage quota of its own, so uploading into
      // someone's personal "My Drive" folder is rejected even with editor
      // access; only a Shared Drive or user OAuth avoids this. Don't let a
      // Drive-specific failure break the submit — fall back to local storage
      // and keep going, since Sheets logging is independent of this.
      console.error("Drive upload failed, falling back to local storage:", error.message);
    }
  }

  const folder = path.join(DRIVE_MOCK_DIR, "drawings", coupleId, date);
  await fs.mkdir(folder, { recursive: true });
  const jsonFile = `${userId}-v${version}.json`;
  await fs.writeFile(path.join(folder, imageFile), imageBuffer);
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

function pendingCoupleCreatedBy(state, userId) {
  return state.couples.find((couple) => couple.status === "pending" && couple.user_a_id === userId);
}

function openInviteForCouple(state, coupleId) {
  return state.invites.find((invite) => invite.couple_id === coupleId && invite.status === "open");
}

async function handleCreateInvite(request, response, state) {
  const body = await readBody(request);
  const user = ensureUser(state, getDeviceId(request), body.display_name);

  if (coupleForUser(state, user.user_id)) {
    throw new Error("이미 연결된 상대가 있어요.");
  }

  const existingPending = pendingCoupleCreatedBy(state, user.user_id);

  if (existingPending) {
    const existingInvite = openInviteForCouple(state, existingPending.couple_id);

    if (existingInvite) {
      sendJson(response, 200, { invite: { code: existingInvite.code }, couple: existingPending });
      return;
    }
  }

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
  addEvent(state, "invite_created", {
    user_id: user.user_id,
    profile_name: user.display_name,
    couple_id: couple.couple_id,
    invite_id: invite.invite_id,
    code: invite.code,
    created_date: couple.created_date,
  });
  sendJson(response, 200, { invite: { code }, couple });
}

async function handleAcceptInvite(request, response, state) {
  const body = await readBody(request);
  const user = ensureUser(state, getDeviceId(request), body.display_name);

  if (coupleForUser(state, user.user_id)) {
    throw new Error("이미 연결된 상대가 있어요.");
  }

  const code = String(body.code || "").trim().toUpperCase();
  const invite = state.invites.find((item) => item.code === code && item.status === "open");

  if (!invite) {
    throw new Error("초대 코드를 찾지 못했어요. 코드를 다시 확인해주세요.");
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
    profile_name: user.display_name,
    couple_id: couple.couple_id,
    invite_id: invite.invite_id,
    code: invite.code,
    user_a_id: couple.user_a_id,
    partner_user_id: couple.user_a_id,
    created_date: couple.created_date,
  });
  sendJson(response, 200, { couple });
}

async function handleMyInvite(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));

  if (coupleForUser(state, user.user_id)) {
    sendJson(response, 200, { invite: null });
    return;
  }

  const pendingCouple = pendingCoupleCreatedBy(state, user.user_id);
  const invite = pendingCouple ? openInviteForCouple(state, pendingCouple.couple_id) : null;
  sendJson(response, 200, { invite: invite ? { code: invite.code } : null });
}

async function handleToday(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const context = await getTodayContext(state, user, relationshipTypeFromRequest(request));
  sendJson(response, 200, context);
}

async function handleSubmitDrawing(request, response, state) {
  const body = await readBody(request);
  const user = ensureUser(state, getDeviceId(request));
  const context = await getTodayContext(state, user, relationshipTypeFromRequest(request));
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
    addEvent(state, "drawing_submitted", drawingEventPayload(drawing, context, user));
  } else {
    Object.assign(drawing, files, {
      modified_at: nowIso(),
      modify_count: drawing.modify_count + 1,
      status: "modified",
      request_id: requestId,
    });
    addEvent(state, "drawing_modified", drawingEventPayload(drawing, context, user));
  }

  context.session.updated_at = nowIso();
  await appendSheetMock("drawings", drawing);
  sendJson(response, 200, { drawing: exposeDrawing(drawing, context.date) });
}

async function handleDeleteDrawing(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const context = await getTodayContext(state, user, relationshipTypeFromRequest(request));
  const drawing = context.session ? drawingFor(state, context.session.session_id, user.user_id) : null;

  if (!drawing || drawing.status === "deleted") {
    throw new Error("삭제할 오늘 그림이 없어요.");
  }

  drawing.status = "deleted";
  drawing.deleted_at = nowIso();
  addEvent(state, "drawing_deleted", drawingEventPayload(drawing, context, user));
  sendJson(response, 200, { drawing: exposeDrawing(drawing, context.date) });
}

async function handlePoke(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const couple = coupleForUser(state, user.user_id);

  if (!couple) {
    throw new Error("상대와 먼저 연결해주세요.");
  }

  addEvent(state, "poke_sent", {
    user_id: user.user_id,
    profile_name: user.display_name,
    couple_id: couple.couple_id,
  });
  sendJson(response, 200, { ok: true });
}

function dateFromQueryOrToday(request) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const date = String(url.searchParams.get("date") || todayKst()).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayKst();
}

async function handleGetChats(request, response, state) {
  const user = ensureUser(state, getDeviceId(request));
  const couple = coupleForUser(state, user.user_id);

  if (!couple) {
    sendJson(response, 200, { chats: [] });
    return;
  }

  const date = dateFromQueryOrToday(request);
  const chats = state.chats
    .filter((chat) => chat.couple_id === couple.couple_id && chat.date === date)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((chat) => exposeChat(chat, user));
  sendJson(response, 200, { chats });
}

async function handleCreateChat(request, response, state) {
  const body = await readBody(request);
  const user = ensureUser(state, getDeviceId(request));
  const couple = coupleForUser(state, user.user_id);

  if (!couple) {
    throw new Error("둘만의 방을 먼저 연결해 주세요.");
  }

  const text = String(body.text || "").trim().slice(0, 140);
  const emoji = String(body.emoji || "").trim().slice(0, 4);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : todayKst();

  if (!text && !emoji) {
    throw new Error("댓글이나 이모티콘을 남겨주세요.");
  }

  const chat = {
    chat_id: id("chat"),
    couple_id: couple.couple_id,
    date,
    user_id: user.user_id,
    profile_name: user.display_name,
    text,
    emoji,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  state.chats.push(chat);
  addEvent(state, "chat_created", chatEventPayload(chat));
  sendJson(response, 200, { chat: exposeChat(chat, user) });
}

async function handleUpdateChat(request, response, state) {
  const body = await readBody(request);
  const user = ensureUser(state, getDeviceId(request));
  const chat = state.chats.find((item) => item.chat_id === body.chat_id);

  if (!chat || chat.user_id !== user.user_id) {
    throw new Error("내가 남긴 댓글만 수정할 수 있어요.");
  }

  const text = String(body.text || "").trim().slice(0, 140);
  const emoji = String(body.emoji || chat.emoji || "").trim().slice(0, 4);

  if (!text && !emoji) {
    throw new Error("댓글이나 이모티콘을 남겨주세요.");
  }

  chat.text = text;
  chat.emoji = emoji;
  chat.profile_name = user.display_name;
  chat.updated_at = nowIso();
  addEvent(state, "chat_updated", chatEventPayload(chat));
  sendJson(response, 200, { chat: exposeChat(chat, user) });
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

  addEvent(state, "archive_opened", {
    user_id: user.user_id,
    profile_name: user.display_name,
    couple_id: couple.couple_id,
  });
  sendJson(response, 200, { sessions });
}

async function handleFile(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const relative = decodeURIComponent(url.pathname.replace(/^\/api\/files\//, ""));

  if (relative.startsWith("drive/")) {
    const fileId = relative.slice("drive/".length);

    try {
      const content = await google.downloadDriveFile(fileId);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      response.end(content);
    } catch {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Drive fetch failed");
    }

    return;
  }

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

async function googleStatus() {
  const configured = google.isConfigured();
  const status = {
    service_account_present: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    sheets_id_present: Boolean(process.env.GOOGLE_SHEETS_ID),
    drive_folder_id_present: Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID),
    oauth_client_configured: google.oauthConfigured(),
    oauth_user_authorized: google.userAuthorized(),
    configured,
    storage_mode: configured ? (google.userAuthorized() ? "google-oauth" : "google-service-account") : process.env.VERCEL ? "ephemeral-mock" : "local-mock",
  };

  if (configured) {
    try {
      await google.checkAuth();
      status.auth_ok = true;
    } catch (error) {
      status.auth_ok = false;
      status.auth_error = error.message;
    }

    if (status.auth_ok) {
      try {
        await google.readDatabaseEvents();
        status.sheets_database_ok = true;
      } catch (error) {
        status.sheets_database_ok = false;
        status.sheets_database_error = error.message;
      }

      try {
        await google.checkDriveWrite();
        status.drive_write_ok = true;
      } catch (error) {
        status.drive_write_ok = false;
        status.drive_write_error = error.message;
        status.note =
          "Sheets logging works, but Drive uploads are rejected: a service account has no storage quota of its own, so it can't create files even with editor access to a personal 'My Drive' folder. Fix by sharing a Shared Drive folder (needs Google Workspace) or by switching to OAuth with the real account. Until then, drawings fall back to local mock storage.";
      }
    }
  } else {
    status.note =
      "Drive/Sheets write operations require a service account (or OAuth) credential; a plain API key cannot write. Until GOOGLE_SERVICE_ACCOUNT_JSON/GOOGLE_SHEETS_ID/GOOGLE_DRIVE_FOLDER_ID are configured, drawings and logs are written to a local mock folder instead.";
  }

  return status;
}

function currentOrigin(request) {
  const proto = request.headers["x-forwarded-proto"] || "http";
  return `${proto}://${request.headers.host}`;
}

function oauthRedirectUri(request) {
  return `${currentOrigin(request)}/api/google/oauth/callback`;
}

async function handleOAuthStart(request, response) {
  if (!google.oauthConfigured()) {
    sendError(response, 400, "GOOGLE_OAUTH_CLIENT_ID/SECRET이 아직 설정되지 않았어요.");
    return;
  }

  const authUrl = google.getAuthUrl(oauthRedirectUri(request));
  response.writeHead(302, { Location: authUrl });
  response.end();
}

async function handleOAuthCallback(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Google가 인증을 거부했어요: ${error}`);
    return;
  }

  if (!code) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("code 파라미터가 없어요.");
    return;
  }

  try {
    const tokens = await google.exchangeCodeForTokens(code, oauthRedirectUri(request));
    const refreshTokenNote = tokens.refresh_token
      ? tokens.refresh_token
      : "(refresh_token이 없어요. 이 계정으로 이미 한 번 동의한 적이 있어서 재발급되지 않았을 수 있어요. Google 계정 -> 보안 -> 타사 액세스에서 이 앱 연결을 해제한 뒤 다시 시도해주세요.)";

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset="utf-8" />` +
        `<body style="font-family: system-ui; padding: 24px; line-height: 1.6; max-width: 640px; margin: 0 auto;">` +
        `<h1>연결 완료</h1>` +
        `<p>아래 값을 복사해서 알려주세요. 이 화면을 벗어나면 다시 볼 수 없어요.</p>` +
        `<textarea style="width:100%;height:140px;" readonly>${refreshTokenNote}</textarea>` +
        `</body>`,
    );
  } catch (err) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`토큰 교환 실패: ${err.message}`);
  }
}

async function routeApi(request, response, state) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/google/oauth/start") return handleOAuthStart(request, response);
  if (request.method === "GET" && url.pathname === "/api/google/oauth/callback") return handleOAuthCallback(request, response);
  if (request.method === "POST" && url.pathname === "/api/session") return handleSession(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/invites") return handleCreateInvite(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/invites/accept") return handleAcceptInvite(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/invites/mine") return handleMyInvite(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/today") return handleToday(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/drawings/submit") return handleSubmitDrawing(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/drawings/delete") return handleDeleteDrawing(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/poke") return handlePoke(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/chats") return handleGetChats(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/chats") return handleCreateChat(request, response, state);
  if (request.method === "POST" && url.pathname === "/api/chats/update") return handleUpdateChat(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/archive") return handleArchive(request, response, state);
  if (request.method === "GET" && url.pathname === "/api/google/status") return sendJson(response, 200, await googleStatus());
  if (request.method === "GET" && url.pathname.startsWith("/api/files/")) return handleFile(request, response);

  sendError(response, 404, "API 경로를 찾지 못했어요.");
}

// Two people can submit their drawing within the same second. Every API
// request does a read-modify-write cycle against state.json, so without
// serializing them a concurrent request pair can read the same snapshot and
// the second write silently overwrites the first person's submission. This
// queue forces API requests to run one at a time so that never happens.
let stateQueue = Promise.resolve();

function withState(handler) {
  const run = async () => {
    const state = await readState();
    const beforeEventCount = state.events.length;

    try {
      await handler(state);
    } catch (error) {
      state.errors.push({
        error_id: id("error"),
        message: error.message,
        created_at: nowIso(),
      });
      throw error;
    } finally {
      await persistNewEvents(state, beforeEventCount);
      await writeState(state);
    }
  };

  const scheduled = stateQueue.then(run, run);
  stateQueue = scheduled.catch(() => {});
  return scheduled;
}

async function appHandler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const isApi = url.pathname.startsWith("/api/");

  if (!isApi) {
    await serveStatic(request, response);
    return;
  }

  try {
    await withState((state) => routeApi(request, response, state));
  } catch (error) {
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
