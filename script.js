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

  const drawButton = $('[data-action="open-draw"]');
  if (today.my_drawing?.status && today.my_drawing.status !== "deleted") {
    drawButton.textContent = today.my_drawing.can_modify ? "오늘 그림 고치기" : "수정 마감";
    drawButton.disabled = !today.my_drawing.can_modify;
  } else {
    drawButton.textContent = "오늘 주제 그리기";
    drawButton.disabled = false;
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

  if (label === "나") {
    const deleteButton = document.createElement("button");
    deleteButton.className = "tool-button";
    deleteButton.type = "button";
    deleteButton.textContent = "삭제";
    deleteButton.addEventListener("click", deleteDrawing);
    card.append(deleteButton);
  }

  return card;
}

function renderArchive() {
  const list = $("[data-archive-list]");
  list.innerHTML = "";

  if (!appState.archive.length) {
    const empty = document.createElement("article");
    empty.className = "archive-item";
    empty.textContent = "아직 그림일기가 없어요. 오늘 주제에 답하면 여기에 차곡차곡 쌓여요.";
    list.append(empty);
    return;
  }

  appState.archive.forEach((item) => {
    const row = document.createElement("article");
    row.className = "archive-item";
    row.innerHTML = `
      <p class="archive-item__meta">${item.date} · ${item.revealed ? "공개됨" : "대기 중"}</p>
      <h3>${item.prompt?.text_ko || "주제 없음"}</h3>
      <p class="muted">나 ${statusLabel(item.my_drawing?.status)} · 상대 ${statusLabel(item.partner_drawing?.status)}</p>
    `;
    list.append(row);
  });
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
  $('[data-action="open-draw"]').addEventListener("click", () => {
    stopPolling();
    appState.strokes = [];
    $("[data-draw-prompt]").textContent = appState.today.prompt?.text_ko || "";
    showScreen("draw");
  });
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
