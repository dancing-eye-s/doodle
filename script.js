const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const appState = {
  activeScreen: "welcome",
  deviceId: getOrCreateDeviceId(),
  user: null,
  today: null,
  archive: [],
  strokes: [],
  activeStroke: null,
  color: "#30262a",
  width: 10,
  pollTimer: null,
  submitting: false,
  waitingForPartner: false,
  archiveSessionsByDate: {},
  archiveMonth: null,
  archiveSelectedDate: null,
  archiveCellTimers: [],
};

const installNote = $("[data-install-note]");
const isIosSafari =
  /iP(hone|od|ad)/.test(navigator.userAgent) &&
  /Safari/.test(navigator.userAgent) &&
  !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

if (installNote && isIosSafari && !isStandalone) {
  installNote.hidden = false;
}

function getOrCreateDeviceId() {
  const key = "doodle_device_id";
  const legacyKey = ["ping", "pong_device_id"].join("");
  const existing = localStorage.getItem(key);

  if (existing) return existing;

  const legacy = localStorage.getItem(legacyKey);
  if (legacy) {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
    return legacy;
  }

  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": appState.deviceId,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "요청을 처리하지 못했어요.");
  }

  return payload;
}

function showToast(message) {
  const toast = $("[data-toast]");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function safe(action) {
  return async (event) => {
    try {
      await action(event);
    } catch (error) {
      showToast(error.message || "잠시 후 다시 시도해주세요.");
    }
  };
}

function showScreen(name) {
  appState.activeScreen = name;
  $$("[data-screen]").forEach((screen) => {
    screen.classList.toggle("is-active", screen.dataset.screen === name);
  });

  if (name === "draw") {
    window.requestAnimationFrame(setupCanvas);
  }
}

function openPairing(mode = "join") {
  const screen = $('[data-screen="pairing"]');
  const helper = $("[data-pairing-helper]");

  if (screen) screen.dataset.pairingMode = mode;
  if (helper) {
    helper.textContent =
      mode === "create"
        ? "내 코드를 상대에게 보내면 같은 방으로 연결돼요."
        : "상대가 보내준 코드를 입력하면 같은 방으로 연결돼요.";
  }

  showScreen("pairing");

  if (mode === "join") {
    window.requestAnimationFrame(() => $('[name="invite_code"]')?.focus());
  }
}

function statusLabel(status) {
  return {
    empty: "기다리는 중",
    submitted: "완성",
    modified: "수정됨",
    deleted: "삭제됨",
  }[status || "empty"] || "기다리는 중";
}

async function bootstrap() {
  try {
    const payload = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({}),
    });
    appState.user = payload.user;
    await loadToday();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadToday() {
  const payload = await api("/api/today");
  appState.today = payload;

  if (!payload.couple) {
    await showWaitingOrWelcome();
    return;
  }

  appState.waitingForPartner = false;
  renderToday();
  showScreen("today");
  startPolling(refreshTodaySilently);
}

async function showWaitingOrWelcome() {
  const mine = await api("/api/invites/mine");

  if (mine.invite) {
    appState.waitingForPartner = true;
    openPairing("create");
    const helper = $("[data-pairing-helper]");
    if (helper) helper.textContent = "이미 만들어둔 내 코드예요. 상대가 입력하면 자동으로 연결돼요.";
    fillInviteCode(mine.invite.code);
    startPolling(pollWaitingRoom);
    return;
  }

  appState.waitingForPartner = false;
  stopPolling();
  showScreen("welcome");
}

async function pollWaitingRoom() {
  try {
    await loadToday();
  } catch {
    stopPolling();
  }
}

async function refreshTodaySilently() {
  if (appState.activeScreen !== "today") return;

  try {
    const payload = await api("/api/today");
    appState.today = payload;

    if (payload.couple) {
      renderToday();
    } else {
      await showWaitingOrWelcome();
    }
  } catch {
    stopPolling();
  }
}

function startPolling(fn) {
  stopPolling();
  appState.pollTimer = window.setInterval(fn, 7000);
}

function stopPolling() {
  if (appState.pollTimer) {
    window.clearInterval(appState.pollTimer);
    appState.pollTimer = null;
  }
}

function renderToday() {
  const today = appState.today;
  $("[data-today-date]").textContent = today.date;
  $("[data-prompt-text]").textContent = today.prompt?.text_ko || "오늘의 주제를 준비 중이에요.";
  $("[data-prompt-meta]").textContent = today.prompt
    ? `${today.prompt.day_index}번째 주제`
    : "100일 MVP 주제가 모두 끝났어요.";
  $("[data-my-status]").textContent = statusLabel(today.my_drawing?.status);
  $("[data-partner-status]").textContent = statusLabel(today.partner_drawing?.status);
  $("[data-reveal-copy]").textContent = today.revealed
    ? "서로의 낙서가 열렸어요."
    : "둘 다 그리면 동시에 열려요.";

  const pair = $("[data-drawing-pair]");
  pair.innerHTML = "";

  if (today.revealed) {
    pair.append(renderDrawingCard("나", today.my_drawing));
    pair.append(renderDrawingCard("상대", today.partner_drawing));
  }

  renderTodayPrimaryRow(today);
}

function renderTodayPrimaryRow(today) {
  const row = $("[data-today-primary-row]");
  row.innerHTML = "";

  const drawButton = document.createElement("button");
  drawButton.type = "button";
  drawButton.className = "primary-action";
  drawButton.dataset.action = "open-draw";

  const hasLiveDrawing = today.my_drawing?.status && today.my_drawing.status !== "deleted";

  if (hasLiveDrawing) {
    drawButton.textContent = today.my_drawing.can_modify ? "오늘 그림 고치기" : "수정 마감";
    drawButton.disabled = !today.my_drawing.can_modify;
    row.classList.add("today-primary-row--split");
    row.append(drawButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-action";
    deleteButton.dataset.action = "delete-drawing";
    deleteButton.textContent = "삭제";
    row.append(deleteButton);
  } else {
    drawButton.textContent = "오늘 주제 그리기";
    drawButton.disabled = false;
    row.classList.remove("today-primary-row--split");
    row.append(drawButton);
  }
}

function renderDrawingCard(label, drawing) {
  const card = document.createElement("article");
  card.className = "drawing-card";
  const heading = document.createElement("p");
  heading.className = "eyebrow";
  heading.textContent = `${label} ${statusLabel(drawing?.status)}`;
  card.append(heading);

  if (!drawing || drawing.status === "deleted") {
    const deleted = document.createElement("div");
    deleted.className = "deleted";
    deleted.textContent = "삭제됨";
    card.append(deleted);
    return card;
  }

  const image = document.createElement("img");
  image.src = drawing.file_url;
  image.alt = `${label}의 그림`;
  card.append(image);

  return card;
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month, day };
}

function monthLabel(year, month) {
  return `${year}년 ${month}월`;
}

function clearArchiveCellTimers() {
  appState.archiveCellTimers.forEach((timerId) => window.clearInterval(timerId));
  appState.archiveCellTimers = [];
}

function renderArchive() {
  appState.archiveSessionsByDate = Object.fromEntries(
    appState.archive.map((session) => [session.date, session]),
  );

  const initialDate = appState.archive[0]
    ? parseDateKey(appState.archive[0].date)
    : parseDateKey(appState.today?.date || new Date().toISOString().slice(0, 10));
  appState.archiveMonth = { year: initialDate.year, month: initialDate.month };
  appState.archiveSelectedDate = null;

  renderArchiveCalendar();
}

function changeArchiveMonth(delta) {
  if (!appState.archiveMonth) return;

  const next = new Date(appState.archiveMonth.year, appState.archiveMonth.month - 1 + delta, 1);
  appState.archiveMonth = { year: next.getFullYear(), month: next.getMonth() + 1 };
  appState.archiveSelectedDate = null;
  renderArchiveCalendar();
}

function renderArchiveCalendar() {
  clearArchiveCellTimers();
  $("[data-archive-detail]").hidden = true;

  const grid = $("[data-calendar-grid]");
  const nav = $("[data-calendar-nav]");
  const weekdays = $("[data-calendar-weekdays]");
  grid.innerHTML = "";

  if (!appState.archive.length) {
    nav.hidden = true;
    weekdays.hidden = true;
    const empty = document.createElement("p");
    empty.className = "calendar-empty-note";
    empty.textContent = "아직 그림일기가 없어요. 오늘 주제에 답하면 여기에 차곡차곡 쌓여요.";
    grid.append(empty);
    return;
  }

  nav.hidden = false;
  weekdays.hidden = false;

  const { year, month } = appState.archiveMonth;
  $("[data-calendar-month-label]").textContent = monthLabel(year, month);

  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let index = 0; index < firstWeekday; index += 1) {
    const filler = document.createElement("div");
    filler.className = "calendar-cell calendar-cell--empty";
    grid.append(filler);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const session = appState.archiveSessionsByDate[dateKey];
    grid.append(session ? buildCalendarEntryCell(dateKey, day, session) : buildCalendarPlainCell(day));
  }
}

function buildCalendarPlainCell(day) {
  const cell = document.createElement("div");
  cell.className = "calendar-cell calendar-cell--plain";
  cell.textContent = String(day);
  return cell;
}

function buildCalendarEntryCell(dateKey, day, session) {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "calendar-cell calendar-cell--entry";
  cell.dataset.dateKey = dateKey;
  cell.setAttribute(
    "aria-label",
    `${day}일, ${session.revealed ? "공개됨" : "대기 중"}. 눌러서 자세히 보기`,
  );

  const face = document.createElement("div");
  face.className = "calendar-cell__face";
  cell.append(face);

  const tag = document.createElement("span");
  tag.className = "calendar-cell__tag";
  tag.textContent = String(day);
  cell.append(tag);

  const faces = [
    () => {
      face.innerHTML = "";
      face.classList.add("calendar-cell__face--date");
      const label = document.createElement("span");
      label.textContent = String(day);
      face.append(label);
    },
    () => {
      face.classList.remove("calendar-cell__face--date");
      face.innerHTML = "";
      face.append(buildCalendarFaceImage("나", session.my_drawing));
    },
    () => {
      face.classList.remove("calendar-cell__face--date");
      face.innerHTML = "";
      face.append(buildCalendarFaceImage("상대", session.partner_drawing));
    },
  ];

  let faceIndex = 0;
  faces[0]();
  const timerId = window.setInterval(() => {
    faceIndex = (faceIndex + 1) % faces.length;
    faces[faceIndex]();
  }, 3000);
  appState.archiveCellTimers.push(timerId);

  cell.addEventListener("click", () => toggleArchiveDetail(dateKey));

  return cell;
}

function buildCalendarFaceImage(label, drawing) {
  if (!drawing || drawing.status === "deleted") {
    const placeholder = document.createElement("span");
    placeholder.textContent = drawing?.status === "deleted" ? "삭제됨" : "대기 중";
    return placeholder;
  }

  const image = document.createElement("img");
  image.src = drawing.file_url;
  image.alt = `${label}의 그림`;
  return image;
}

function toggleArchiveDetail(dateKey) {
  if (appState.archiveSelectedDate === dateKey) {
    appState.archiveSelectedDate = null;
    $("[data-archive-detail]").hidden = true;
    $("[data-calendar-nav]").hidden = false;
    $("[data-calendar-weekdays]").hidden = false;
    $("[data-calendar-grid]").hidden = false;
    $$(".calendar-cell--entry").forEach((cell) => cell.classList.remove("is-selected"));
    return;
  }

  const session = appState.archiveSessionsByDate[dateKey];
  if (!session) return;

  appState.archiveSelectedDate = dateKey;
  $$(".calendar-cell--entry").forEach((cell) => {
    cell.classList.toggle("is-selected", cell.dataset.dateKey === dateKey);
  });

  $("[data-archive-detail-date]").textContent = `${dateKey} · ${session.revealed ? "공개됨" : "대기 중"}`;
  $("[data-archive-detail-prompt]").textContent = session.prompt?.text_ko || "주제 없음";

  setDetailImage("mine", session.my_drawing);
  setDetailImage("partner", session.partner_drawing);

  $("[data-calendar-grid]").hidden = true;
  $("[data-calendar-nav]").hidden = true;
  $("[data-calendar-weekdays]").hidden = true;
  $("[data-archive-detail]").hidden = false;
}

function setDetailImage(who, drawing) {
  const imgEl = $(`[data-archive-detail-${who}]`);
  const fallbackEl = $(`[data-archive-detail-${who}-fallback]`);

  if (drawing && drawing.status !== "deleted") {
    imgEl.src = drawing.file_url;
    imgEl.hidden = false;
    fallbackEl.hidden = true;
  } else {
    imgEl.removeAttribute("src");
    imgEl.hidden = true;
    fallbackEl.textContent = drawing?.status === "deleted" ? "삭제됨" : "그림이 없어요";
    fallbackEl.hidden = false;
  }
}

async function saveDisplayName(event) {
  event.preventDefault();
  const displayName = new FormData(event.currentTarget).get("display_name");
  const payload = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({ display_name: displayName }),
  });
  appState.user = payload.user;
  showToast("이름을 저장했어요.");
}

function fillInviteCode(code) {
  const output = $("[data-invite-code]");
  const row = $("[data-invite-code-row]");
  const createButton = $('[data-action="create-invite"]');
  output.textContent = code;
  row.hidden = false;
  if (createButton) createButton.hidden = true;
}

async function createInvite() {
  const payload = await api("/api/invites", {
    method: "POST",
    body: JSON.stringify({}),
  });
  fillInviteCode(payload.invite.code);
  appState.waitingForPartner = true;
  startPolling(pollWaitingRoom);
  showToast("초대 코드가 준비됐어요. 상대가 들어오면 자동으로 연결돼요.");
}

async function copyInviteCode() {
  const code = $("[data-invite-code]")?.textContent?.trim();

  if (!code) {
    showToast("먼저 초대 코드를 만들어 주세요.");
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(code);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = code;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("초대 코드를 복사했어요.");
}

async function acceptInvite(event) {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get("invite_code");
  await api("/api/invites/accept", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  showToast("둘만의 방이 연결됐어요.");
  await loadToday();
}

async function pokePartner() {
  await api("/api/poke", {
    method: "POST",
    body: JSON.stringify({}),
  });
  showToast("상대에게 콕 찔렀어요.");
}

async function openArchive() {
  stopPolling();
  const payload = await api("/api/archive");
  appState.archive = payload.sessions;
  renderArchive();
  showScreen("archive");
}

async function deleteDrawing() {
  if (!window.confirm("오늘 그림을 삭제할까요? 상대에게는 삭제됨으로 보여요.")) return;

  await api("/api/drawings/delete", {
    method: "POST",
    body: JSON.stringify({}),
  });
  showToast("그림을 삭제했어요.");
  await loadToday();
}

function setupCanvas() {
  const canvas = $("[data-canvas]");
  if (!canvas || canvas.dataset.ready === "true") {
    loadDraft();
    redrawCanvas();
    return;
  }

  canvas.dataset.ready = "true";
  canvas.addEventListener("pointerdown", startStroke);
  canvas.addEventListener("pointermove", moveStroke);
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  loadDraft();
  redrawCanvas();
}

function draftKey() {
  return appState.today?.session?.session_id ? `doodle_draft_${appState.today.session.session_id}` : "";
}

function saveDraft() {
  const key = draftKey();

  if (!key) return;

  localStorage.setItem(key, JSON.stringify(appState.strokes));
}

function loadDraft() {
  const key = draftKey();

  if (!key || appState.strokes.length) return;

  try {
    const legacyKey = key.replace("doodle_draft_", ["ping", "pong_draft_"].join(""));
    const storedDraft = localStorage.getItem(key) || localStorage.getItem(legacyKey) || "[]";
    const draft = JSON.parse(storedDraft);

    if (Array.isArray(draft)) {
      appState.strokes = draft;
      if (!localStorage.getItem(key) && localStorage.getItem(legacyKey)) {
        localStorage.setItem(key, storedDraft);
        localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    appState.strokes = [];
  }
}

function clearDraft() {
  const key = draftKey();

  if (key) localStorage.removeItem(key);
  if (key) localStorage.removeItem(key.replace("doodle_draft_", ["ping", "pong_draft_"].join("")));
}

function canvasPoint(event) {
  const canvas = $("[data-canvas]");
  const rect = canvas.getBoundingClientRect();

  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function startStroke(event) {
  event.preventDefault();
  const canvas = event.currentTarget;
  canvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event);
  appState.activeStroke = {
    color: appState.color,
    width: appState.width,
    points: [point],
  };
  appState.strokes.push(appState.activeStroke);
  redrawCanvas();
}

function moveStroke(event) {
  if (!appState.activeStroke) return;
  event.preventDefault();
  appState.activeStroke.points.push(canvasPoint(event));
  redrawCanvas();
}

function endStroke() {
  appState.activeStroke = null;
  saveDraft();
}

function redrawCanvas() {
  const canvas = $("[data-canvas]");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.lineCap = "round";
  context.lineJoin = "round";

  appState.strokes.forEach((stroke) => {
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;

    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      context.beginPath();
      context.arc(point.x, point.y, stroke.width / 2, 0, Math.PI * 2);
      context.fillStyle = stroke.color;
      context.fill();
      return;
    }

    context.beginPath();
    stroke.points.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();
  });
}

async function submitDrawing() {
  const today = appState.today;
  const submitButton = $('[data-action="submit-drawing"]');

  if (appState.submitting) {
    showToast("이미 저장 중이에요.");
    return;
  }

  if (today.my_drawing?.status && !today.my_drawing.can_modify) {
    showToast("오늘 수정 가능 시간이 지났어요.");
    return;
  }

  if (!appState.strokes.length) {
    showToast("작은 낙서라도 남겨주세요.");
    return;
  }

  appState.submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = "보내는 중...";

  const canvas = $("[data-canvas]");
  const requestId = crypto.randomUUID();

  try {
    const imageData = canvas.toDataURL("image/png");
    const payload = await api("/api/drawings/submit", {
      method: "POST",
      body: JSON.stringify({
        request_id: requestId,
        image_data: imageData,
        strokes: appState.strokes,
      }),
    });
    showToast(payload.drawing.modify_count > 0 ? "수정 저장했어요." : "그림을 제출했어요.");
    appState.strokes = [];
    clearDraft();
    await loadToday();
  } finally {
    appState.submitting = false;
    submitButton.disabled = false;
    submitButton.textContent = "그림 보내기";
  }
}

function wireEvents() {
  $('[data-action="open-join"]').addEventListener("click", () => openPairing("join"));
  $('[data-action="open-create"]').addEventListener("click", safe(async () => {
    openPairing("create");
    await createInvite();
  }));
  $('[data-action="back-welcome"]').addEventListener("click", () => {
    appState.waitingForPartner = false;
    stopPolling();
    showScreen("welcome");
  });
  $$('[data-action="back-today"]').forEach((button) => {
    button.addEventListener("click", () => {
      clearArchiveCellTimers();
      renderToday();
      showScreen("today");
      startPolling(refreshTodaySilently);
    });
  });
  $('[data-action="create-invite"]').addEventListener("click", safe(createInvite));
  $('[data-action="copy-invite"]').addEventListener("click", safe(copyInviteCode));
  $('[data-action="refresh"]').addEventListener("click", safe(loadToday));
  $('[data-action="poke"]').addEventListener("click", safe(pokePartner));
  $('[data-action="open-archive"]').addEventListener("click", safe(openArchive));
  $('[data-action="archive-prev-month"]').addEventListener("click", () => changeArchiveMonth(-1));
  $('[data-action="archive-next-month"]').addEventListener("click", () => changeArchiveMonth(1));
  $("[data-today-primary-row]").addEventListener("click", safe(async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    if (button.dataset.action === "open-draw") {
      stopPolling();
      appState.strokes = [];
      $("[data-draw-prompt]").textContent = appState.today.prompt?.text_ko || "";
      showScreen("draw");
    } else if (button.dataset.action === "delete-drawing") {
      await deleteDrawing();
    }
  }));
  $('[data-action="undo"]').addEventListener("click", () => {
    appState.strokes.pop();
    saveDraft();
    redrawCanvas();
  });
  $('[data-action="clear-canvas"]').addEventListener("click", () => {
    appState.strokes = [];
    clearDraft();
    redrawCanvas();
  });
  $('[data-action="submit-drawing"]').addEventListener("click", safe(submitDrawing));
  const nameForm = $('[data-form="name"]');
  if (nameForm) nameForm.addEventListener("submit", safe(saveDisplayName));
  $('[data-form="accept"]').addEventListener("submit", safe(acceptInvite));
  $$("[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.color = button.dataset.color;
      $$("[data-color]").forEach((item) => item.classList.toggle("is-selected", item === button));
    });
  });
}

wireEvents();
bootstrap();
