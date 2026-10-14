const $ = (id) => document.getElementById(id);
const PAN = [-150, 150];
const TILT = [-52, 90];
const PTZ_CONTROLS = new Set(["pan_absolute", "tilt_absolute", "zoom_absolute", "zoom_continuous"]);
const LABELS = {
  brightness: "Brilho", contrast: "Contraste", saturation: "Saturação", hue: "Matiz",
  gamma: "Gama", gain: "Ganho (ISO)", sharpness: "Nitidez", backlight_compensation: "Compensação de contraluz",
  white_balance_automatic: "Balanço de branco automático", white_balance_temperature: "Temperatura (K)",
  power_line_frequency: "Anti-flicker", auto_exposure: "Exposição", exposure_time_absolute: "Tempo de exposição",
  focus_automatic_continuous: "Foco automático", focus_absolute: "Foco",
};
const MENU_LABELS = { "Manual Mode": "Manual", "Aperture Priority Mode": "Automática", Disabled: "Desligado" };

let connected = false;
let controls = [];
let presets = {};

// --- Chamadas ------------------------------------------------------------------
async function call(op, args) {
  try {
    const res = await window.pixy.call(op, args);
    setConnected(true);
    return res;
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method 'pixy': (Error: )?/, "");
    if (/não encontrad|No such device|ENODEV|Errno 19/.test(msg)) setConnected(false);
    else toast(msg);
    throw e;
  }
}

function setConnected(ok) {
  if (ok === connected) return;
  connected = ok;
  $("conn").className = "dot " + (ok ? "ok" : "off");
  $("conn").title = ok ? "PIXY conectada" : "PIXY desconectada";
  if (ok) refreshAll();
}

let toastTimer;
function toast(msg) {
  console.warn(msg);
  $("toast").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
}

// --- Estado HID ----------------------------------------------------------------
// O processo principal é a fonte do modo (janela, tray e atalhos globais).
let app = { mode: null, desired: "standard", idle: false };
const trackingOn = () => app.desired === "tracking" && app.mode !== "privacy";

// O que a câmera selecionada suporta: o resto fica apagado, com o motivo.
function applyCapabilities() {
  const cam = app.camera || {};
  const hid = Boolean(cam.vendorHid);
  const ptz = cam.ptz || {};
  const move = Boolean(ptz.pan || ptz.tilt);
  for (const b of $("modes").children) {
    b.disabled = !hid;
    b.title = hid ? "" : "Só nas câmeras homologadas";
  }
  $("vendorSection").classList.toggle("unsupported", !hid);
  $("vendorNote").hidden = hid;
  $("vendorNote").classList.toggle("unsupported", false);
  for (const el of $("vendorSection").querySelectorAll("input, select")) el.disabled = !hid;
  for (const id of ["joy", "map", "presets", "center", "speed"]) $(id).classList.toggle("unsupported", !move);
  $("speed").disabled = !move;
  $("zoom").disabled = !ptz.zoom;
  $("zoom").closest("label").classList.toggle("unsupported", !ptz.zoom);
  $("joy").title = move ? "" : "A câmera selecionada não tem pan/tilt";
}

function showMode(s) {
  app = { ...app, ...s };
  applyCapabilities();
  if (app.camera && !app.camera.vendorHid) {
    for (const b of $("modes").children) b.classList.remove("on");
    $("modeNote").textContent = app.camera.name ? `${app.camera.name}: modo, privacidade e tracking só nas câmeras homologadas.` : "";
    return;
  }
  const active = app.mode === "privacy" ? "privacy" : app.desired;
  for (const b of $("modes").children) b.classList.toggle("on", b.dataset.mode === active);
  $("modeNote").textContent = app.mode === "privacy"
    ? "Lente recolhida: o vídeo fica escuro."
    : app.idle
      ? app.desired === "tracking"
        ? "Câmera ociosa: o tracking começa quando algum app abrir o vídeo."
        : "Câmera ociosa (nenhum app usando o vídeo)."
      : "";
}

function showState(s) {
  for (const k of ["gesture", "hflip", "vflip", "autorotate"]) if (k in s && s[k] !== null) $(k).checked = s[k];
  if (s.target) $("target").value = s.target;
  if (s.audio) $("audio").value = s.audio;
  if (s.privacy_delay != null) {
    const sel = $("privacyDelay");
    if (![...sel.options].some((o) => +o.value === s.privacy_delay)) {
      sel.add(new Option(`${s.privacy_delay} s`, s.privacy_delay));
    }
    sel.value = String(s.privacy_delay);
  }
}

async function setMode(mode) {
  showMode(await window.pixy.setMode(mode));
}

$("modes").addEventListener("click", (e) => {
  const mode = e.target.dataset && e.target.dataset.mode;
  if (!mode) return;
  // Privacidade alterna: clicada de novo, volta ao modo de antes (igual ao atalho).
  if (mode === "privacy") return window.pixy.toggle("privacy").then(showMode);
  setMode(mode);
});
$("target").addEventListener("change", async (e) => showState(await call("target", { value: e.target.value })));
$("gesture").addEventListener("change", async (e) => showState(await call("gesture", { value: e.target.checked })));
for (const name of ["hflip", "vflip", "autorotate"]) {
  $(name).addEventListener("change", async (e) => showState(await call("feature", { name, value: e.target.checked })));
}
$("audio").addEventListener("change", async (e) => showState(await call("audio", { value: e.target.value })));
$("privacyDelay").addEventListener("change", async (e) => showState(await call("privacy_delay", { value: +e.target.value })));

// --- Controles de imagem (V4L2, gerados a partir do que a câmera anuncia) ---------
function renderImage() {
  const box = $("image");
  box.textContent = "";
  for (const c of controls) {
    if (PTZ_CONTROLS.has(c.name) || c.readonly) continue;
    const label = LABELS[c.name] || c.label;
    if (c.type === "bool") {
      const el = document.createElement("label");
      el.className = "toggle";
      el.innerHTML = `<input type="checkbox"><span></span>`;
      el.querySelector("span").textContent = label;
      const input = el.querySelector("input");
      input.checked = !!c.value;
      input.addEventListener("change", () => setControl(c, input.checked ? 1 : 0, true));
      box.append(el);
    } else if (c.type === "menu") {
      const el = document.createElement("div");
      el.className = "field";
      el.innerHTML = `<span></span><select></select>`;
      el.querySelector("span").textContent = label;
      const sel = el.querySelector("select");
      for (const m of c.menu) sel.add(new Option(MENU_LABELS[m.label] || m.label, m.value));
      sel.value = String(c.value);
      sel.addEventListener("change", () => setControl(c, +sel.value, true));
      box.append(el);
    } else {
      const el = document.createElement("div");
      el.className = "slider" + (c.inactive ? " inactive" : "");
      el.innerHTML = `<div class="lbl"><span></span><b></b></div><input type="range">`;
      el.querySelector("span").textContent = label;
      const out = el.querySelector("b");
      const input = el.querySelector("input");
      Object.assign(input, { min: c.min, max: c.max, step: c.step || 1, value: c.value, disabled: c.inactive });
      out.textContent = c.value;
      input.addEventListener("input", () => {
        out.textContent = input.value;
        setControlThrottled(c, +input.value);
      });
      input.addEventListener("change", () => input.blur());
      input.addEventListener("dblclick", () => {
        input.value = c.default;
        out.textContent = c.default;
        setControl(c, c.default);
      });
      input.title = `Duplo clique: padrão (${c.default})`;
      box.append(el);
    }
  }
}

async function setControl(c, value, relist = false) {
  await call("set", { name: c.name, value });
  c.value = value;
  // Ligar/desligar um automático ativa ou desativa os sliders dependentes.
  if (relist) await loadControls();
}

const throttles = new Map();
function setControlThrottled(c, value) {
  const t = throttles.get(c.name) || {};
  t.value = value;
  if (!t.timer) {
    t.timer = setTimeout(() => {
      t.timer = null;
      setControl(c, t.value).catch(() => {});
    }, 60);
  }
  throttles.set(c.name, t);
}

async function loadControls() {
  const res = await call("list");
  controls = res.controls;
  renderImage();
  const zoom = controls.find((c) => c.name === "zoom_absolute");
  if (zoom) showZoom(zoom.value);
}

$("resetImage").addEventListener("click", async () => {
  // Automáticos primeiro, para os manuais dependentes não ficarem presos.
  const order = [...controls].sort((a, b) => (b.type !== "int") - (a.type !== "int"));
  for (const c of order) {
    if (PTZ_CONTROLS.has(c.name) || c.readonly || c.value === c.default) continue;
    await call("set", { name: c.name, value: c.default }).catch(() => {});
  }
  await loadControls();
});

// --- Zoom e velocidade --------------------------------------------------------------
let zoom = 100;
function showZoom(v) {
  zoom = v;
  $("zoom").value = v;
  $("zoomVal").textContent = (v / 100).toFixed(2).replace(/0$/, "") + "×";
}
let zoomTimer;
function setZoom(v) {
  v = Math.max(100, Math.min(150, Math.round(v)));
  showZoom(v);
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => call("set", { name: "zoom_absolute", value: v }).catch(() => {}), 40);
}
$("zoom").addEventListener("input", (e) => setZoom(+e.target.value));
$("zoom").addEventListener("change", (e) => e.target.blur());
$("joy").addEventListener("wheel", (e) => {
  e.preventDefault();
  setZoom(zoom - Math.sign(e.deltaY) * 3);
}, { passive: false });

let maxSpeed = 60;
$("speed").addEventListener("input", (e) => {
  maxSpeed = +e.target.value;
  $("speedVal").textContent = `${maxSpeed}°/s`;
});
$("speed").addEventListener("change", (e) => {
  e.target.blur();
  try { localStorage.setItem("maxSpeed", maxSpeed); } catch {}
});
try {
  const saved = +localStorage.getItem("maxSpeed");
  if (saved) {
    maxSpeed = saved;
    $("speed").value = saved;
    $("speedVal").textContent = `${saved}°/s`;
  }
} catch {}

// --- Joystick ------------------------------------------------------------------------
const joy = { x: 0, y: 0, active: false };
const keys = new Set();
let fast = false;

function joyFromPointer(e) {
  const r = $("joy").getBoundingClientRect();
  const radius = r.width / 2;
  let x = (e.clientX - r.left - radius) / radius;
  let y = (e.clientY - r.top - radius) / radius;
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  joy.x = x;
  joy.y = y;
  drawKnob(x, y);
}
function drawKnob(x, y) {
  const r = $("joy").getBoundingClientRect().width / 2;
  const k = r * 0.66; // o knob para na borda do anel
  $("knob").style.transform = `translate(calc(-50% + ${x * k}px), calc(-50% + ${y * k}px))`;
}

$("joy").addEventListener("pointerdown", (e) => {
  $("joy").setPointerCapture(e.pointerId);
  $("joy").classList.add("active");
  joy.active = true;
  joyFromPointer(e);
});
$("joy").addEventListener("pointermove", (e) => joy.active && joyFromPointer(e));
for (const ev of ["pointerup", "pointercancel"]) {
  $("joy").addEventListener(ev, () => {
    joy.active = false;
    joy.x = joy.y = 0;
    $("joy").classList.remove("active");
    drawKnob(0, 0);
  });
}

const KEYMAP = {
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
};

function keyVector() {
  let x = 0, y = 0;
  for (const k of keys) {
    const v = KEYMAP[k];
    if (v) { x += v[0]; y += v[1]; }
  }
  // Teclado: ~60% da velocidade máxima (a curva é quadrática), Shift leva a 100%.
  const mag = fast ? 1 : 0.78;
  const len = Math.hypot(x, y) || 1;
  return [(x / len) * mag, (y / len) * mag];
}

let wasMoving = false;
let jogsSinceMove = 0;
setInterval(() => {
  const ptz = (app.camera && app.camera.ptz) || {};
  if (!ptz.pan && !ptz.tilt) return; // câmera sem pan/tilt
  let [x, y] = joy.active ? [joy.x, joy.y] : keyVector();
  if (!joy.active && keys.size) drawKnob(x, y);
  const moving = Math.abs(x) > 0.05 || Math.abs(y) > 0.05;
  if (moving || wasMoving) {
    // y da tela cresce para baixo; tilt positivo é para cima.
    window.pixy.call("jog", { pan: x, tilt: -y, max_speed: maxSpeed }).catch(() => {});
    // Mão no joystick: o tracking brigaria com ele.
    if (moving && app.camera && app.camera.vendorHid && trackingOn() && jogsSinceMove++ === 0) setMode("standard").catch(() => {});
  }
  if (!moving) jogsSinceMove = 0;
  wasMoving = moving;
}, 50);

function isTyping(e) {
  return e.target instanceof HTMLSelectElement || (e.target instanceof HTMLInputElement && e.target.type !== "checkbox");
}

window.addEventListener("keydown", (e) => {
  if (isTyping(e) || e.ctrlKey || e.altKey || e.metaKey) return;
  fast = e.shiftKey;
  if (KEYMAP[e.code]) {
    e.preventDefault();
    keys.add(e.code);
    return;
  }
  if (e.repeat && !["KeyQ", "KeyE", "Equal", "Minus", "NumpadAdd", "NumpadSubtract"].includes(e.code)) return;
  const digit = /^(Digit|Numpad)([1-4])$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    return e.shiftKey ? savePreset(digit[2]) : recallPreset(digit[2]);
  }
  switch (e.code) {
    case "KeyQ": case "Minus": case "NumpadSubtract": return setZoom(zoom - 2);
    case "KeyE": case "Equal": case "NumpadAdd": return setZoom(zoom + 2);
    case "KeyC": case "Home": return goto({ pan: 0, tilt: 0 });
    case "KeyT":
    case "KeyP":
      if (app.camera && !app.camera.vendorHid) return toast("A câmera selecionada não tem esse controle.");
      return window.pixy.toggle(e.code === "KeyT" ? "tracking" : "privacy").then(showMode);
    case "Space": e.preventDefault(); return call("stop");
  }
});
window.addEventListener("keyup", (e) => {
  fast = e.shiftKey;
  keys.delete(e.code);
  if (!keys.size && !joy.active) drawKnob(0, 0);
});
window.addEventListener("blur", () => {
  keys.clear();
  drawKnob(0, 0);
});

// --- Posição, mapa e presets ----------------------------------------------------------
function showPos(p) {
  if (p.pan == null) return;
  $("panVal").textContent = `${p.pan.toFixed(1)}°`;
  $("tiltVal").textContent = `${p.tilt.toFixed(1)}°`;
  const x = (p.pan - PAN[0]) / (PAN[1] - PAN[0]);
  const y = (TILT[1] - p.tilt) / (TILT[1] - TILT[0]);
  $("mapDot").style.left = `${Math.max(0, Math.min(1, x)) * 100}%`;
  $("mapDot").style.top = `${Math.max(0, Math.min(1, y)) * 100}%`;
  if (p.zoom != null && document.activeElement !== $("zoom")) showZoom(p.zoom);
}

async function goto(target) {
  if (trackingOn()) await setMode("standard");
  await call("goto", target);
}

$("map").addEventListener("click", (e) => {
  const r = $("map").getBoundingClientRect();
  const pan = PAN[0] + ((e.clientX - r.left) / r.width) * (PAN[1] - PAN[0]);
  const tilt = TILT[1] - ((e.clientY - r.top) / r.height) * (TILT[1] - TILT[0]);
  goto({ pan, tilt });
});
$("center").addEventListener("click", () => goto({ pan: 0, tilt: 0 }));

function renderPresets() {
  const box = $("presets");
  box.textContent = "";
  for (const n of ["1", "2", "3", "4"]) {
    const p = presets[n];
    const b = document.createElement("button");
    b.className = p ? "" : "empty";
    b.innerHTML = `Preset ${n}<small></small>`;
    b.querySelector("small").textContent = p
      ? `${Math.round(p.pan)}° / ${Math.round(p.tilt)}° · ${(p.zoom / 100).toFixed(1)}×`
      : "Shift+" + n + " ou botão direito salva";
    b.title = "Clique: ir · Botão direito: salvar a posição atual";
    b.addEventListener("click", () => recallPreset(n));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      savePreset(n);
    });
    box.append(b);
  }
}

async function savePreset(n) {
  const p = await call("position");
  presets[n] = { pan: p.pan, tilt: p.tilt, zoom: p.zoom };
  await window.pixy.savePresets(presets);
  renderPresets();
}
async function recallPreset(n) {
  const p = presets[n];
  if (!p) return toast(`Preset ${n} vazio: Shift+${n} salva a posição atual.`);
  showZoom(p.zoom);
  await goto(p);
}

// Posição: rápido enquanto há movimento, devagar parado.
let polling = false;
async function pollPosition() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    showPos(await call("position"));
  } catch {
    // setConnected já tratou
  } finally {
    polling = false;
  }
}
setInterval(() => (wasMoving || joy.active || keys.size) && pollPosition(), 150);
setInterval(pollPosition, 1500);

// --- Preview opcional -----------------------------------------------------------------
// Ligado, o preview insiste: se a câmera não entrega imagem (outro computador com ela pelo
// acesso remoto, outro app abrindo o device direto), mostra quem está segurando e tenta
// de novo a cada poucos segundos até a imagem voltar.
let stream = null;
let previewOn = false;
let previewTimer = null;
const PREVIEW_RETRY_MS = 4000;

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $("preview").srcObject = null;
}

function stageEmpty() {
  $("stageEmpty").hidden = previewOn;
}

function previewStatus(text) {
  $("previewStatus").textContent = text || "";
  $("previewStatus").hidden = !text;
}

async function openPreview() {
  clearTimeout(previewTimer);
  if (!previewOn || previewSource !== "original") return;
  stopStream();
  try {
    // Câmera selecionada, pelo nome que o Chromium mostra; com dois sensores de mesmo nome
    // (comum e infravermelho), o de maior resolução.
    const card = (app.camera && app.camera.card) || "EMEET PIXY";
    const width = (d) => ((typeof d.getCapabilities === "function" && d.getCapabilities().width) || {}).max || 0;
    const pick = (list) => list
      .filter((d) => d.kind === "videoinput" && d.label.startsWith(card) && !/remota|blur|virtual/i.test(d.label))
      .sort((a, b) => width(b) - width(a))[0];
    let dev = pick(await navigator.mediaDevices.enumerateDevices());
    if (!dev) {
      // Rótulos só aparecem depois de uma permissão. A sondagem já pede 720p: se a câmera
      // padrão for a PIXY, o formato aberto aqui é reaproveitado, e o padrão dela
      // (1280x960) só rende ~20 fps para todo mundo que dividir a câmera.
      const probe = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      probe.getTracks().forEach((t) => t.stop());
      dev = pick(await navigator.mediaDevices.enumerateDevices());
    }
    if (!dev) throw Object.assign(new Error("PIXY não aparece na lista de câmeras"), { name: "NoPixy" });
    // Modo nativo exato (sem recorte): com "ideal" o Chromium chegava a escolher o
    // 1280x960 da PIXY e recortar, e esse modo só rende ~20 fps.
    const s = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: dev.deviceId },
        width: { exact: video.width },
        height: { exact: video.height },
        frameRate: { ideal: video.fps, max: video.fps },
        resizeMode: "none",
      },
    });
    if (!previewOn) return s.getTracks().forEach((t) => t.stop());
    stream = s;
    const v = $("preview");
    v.srcObject = s;
    v.hidden = false;
    previewStatus("Abrindo câmera…");
    // Quando um track morre (câmera desplugada), volta a tentar.
    s.getVideoTracks()[0].addEventListener("ended", () => previewOn && retryPreview("Câmera desconectada."));
    previewTimer = setTimeout(async () => {
      if (stream !== s || !previewOn) return;
      if (v.videoWidth) return previewStatus("");
      retryPreview(await window.pixy.whoHoldsCamera());
    }, 5000);
  } catch (e) {
    const hint = {
      NotFoundError: "o PipeWire não mostrou nenhuma câmera ao app (ver README, regra do WirePlumber)",
      NotReadableError: "outro app abriu a câmera direto, sem PipeWire",
      NotAllowedError: "permissão de câmera negada no portal",
    }[e.name];
    retryPreview(hint || e.message);
  }
}

function retryPreview(reason) {
  if (!previewOn || previewSource !== "original") return;
  stopStream();
  previewStatus(`${reason} Tentando de novo…`);
  previewTimer = setTimeout(openPreview, PREVIEW_RETRY_MS);
}

$("preview").addEventListener("playing", () => previewStatus(""));
function savePreviewPref() {
  try {
    localStorage.setItem("preview", JSON.stringify({ on: previewOn, source: wantedSource }));
  } catch {}
}

$("previewBtn").addEventListener("click", () => {
  previewOn = !previewOn;
  savePreviewPref();
  $("previewBtn").textContent = previewOn ? "Desligar preview" : "Ligar preview";
  $("previewSource").hidden = !previewOn;
  stageEmpty();
  if (previewOn) return setPreviewSource(wantedSource);
  clearTimeout(previewTimer);
  stopStream();
  window.pixy.setBlurPreview(false);
  $("preview").hidden = true;
  $("blurPreview").hidden = true;
  previewStatus("");
});

// --- Qualidade do vídeo (preview e blur) ----------------------------------------------
// O máximo é o que a PIXY anuncia para o modo (60 em 1080p/720p/576p/360p).
const APP_MAX_FPS = 60;
let video = { width: 1280, height: 720, fps: 30 };
let modes = [];

const ratio = (w, h) => {
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return `${w / d}:${h / d}`;
};

function renderVideo(blurOut) {
  const res = $("videoRes");
  res.textContent = "";
  for (const m of modes) {
    const o = new Option(`${m.width}×${m.height} (${ratio(m.width, m.height)})`, `${m.width}x${m.height}`);
    res.add(o);
  }
  res.value = `${video.width}x${video.height}`;
  const mode = modes.find((m) => m.width === video.width && m.height === video.height);
  const max = Math.min(APP_MAX_FPS, mode ? Math.max(...mode.fps) : APP_MAX_FPS);
  const fps = $("videoFps");
  fps.textContent = "";
  for (const f of [60, 50, 30, 25, 24, 20, 15, 10].filter((f) => f <= max)) fps.add(new Option(`${f} fps`, f));
  fps.value = String(Math.min(video.fps, max));
  const notes = [];
  // A câmera é dividida pelo PipeWire: o formato é o de quem abriu primeiro (Meet,
  // OBS...). Se outro app já estiver com ela a 30, este modo de 60 fica em 30.
  if (video.fps > 30) notes.push("Se outro app já estiver usando a câmera em outro modo, vale o modo dele até ele soltar.");
  if (blurOut && (blurOut.width !== video.width || blurOut.height !== video.height)) {
    notes.push(`Com blur, a câmera virtual sai em ${blurOut.width}×${blurOut.height}.`);
    // Medido em 14/10/26: 4K com blur fica perto de 20 fps; 1440p e abaixo seguem em 30.
    if (video.width * video.height > 2560 * 1440) notes.push("Em 4K o blur fica perto de 20 fps (a PIXY entrega menos nesse modo e o processamento pesa); 2560×1440 ou menor mantém 30.");
  }
  $("videoNote").textContent = notes.join(" ");
  $("videoNote").hidden = !notes.length;
}

async function loadVideo() {
  const v = await window.pixy.getVideo();
  modes = v.modes;
  video = v.current;
  renderVideo(v.blurOutput);
}

async function saveVideo() {
  const [w, h] = $("videoRes").value.split("x").map(Number);
  const mode = modes.find((m) => m.width === w && m.height === h);
  const max = Math.min(APP_MAX_FPS, mode ? Math.max(...mode.fps) : APP_MAX_FPS);
  const res = await window.pixy.setVideo({ width: w, height: h, fps: Math.min(+$("videoFps").value || 30, max) });
  video = res.current;
  renderVideo(res.blurOutput);
  if (previewOn && previewSource === "original") openPreview(); // reabre no modo novo
}
$("videoRes").addEventListener("change", saveVideo);
$("videoFps").addEventListener("change", saveVideo);
loadVideo().catch(() => {});

// --- Preview: original (câmera) ou com blur (o que sai na câmera virtual) ---------------
let previewSource = "original";
let wantedSource = "original"; // escolha salva; vale quando o blur estiver ligado
let blurOn = false;
let blurFrameUrl = null;
let blurFrameTimer = null;

function setPreviewSource(src, remember = true) {
  if (src === "blur" && !blurOn) src = "original";
  previewSource = src;
  if (remember) savePreviewPref();
  for (const b of $("previewSource").children) b.classList.toggle("on", b.dataset.src === src);
  if (!previewOn) return;
  if (src === "blur") {
    clearTimeout(previewTimer);
    stopStream(); // a imagem vem da janela do blur, não precisa da câmera aqui
    $("preview").hidden = true;
    $("blurPreview").hidden = !blurFrameUrl;
    previewStatus("Aguardando a imagem do blur…");
    window.pixy.setBlurPreview(true);
  } else {
    window.pixy.setBlurPreview(false);
    $("blurPreview").hidden = true;
    openPreview();
  }
}

$("previewSource").addEventListener("click", (e) => {
  const src = e.target.dataset && e.target.dataset.src;
  if (!src) return;
  wantedSource = src;
  setPreviewSource(src);
});

// Preview como estava da última vez (ligado/desligado e qual imagem).
try {
  const saved = JSON.parse(localStorage.getItem("preview") || "{}");
  wantedSource = saved.source === "blur" ? "blur" : "original";
  previewSource = wantedSource;
  if (saved.on) setTimeout(() => $("previewBtn").click(), 500);
} catch {}

window.pixy.onBlurPreview((buffer) => {
  if (previewSource !== "blur" || !previewOn) return;
  const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
  const img = $("blurPreview");
  img.onload = () => {
    if (blurFrameUrl && blurFrameUrl !== url) URL.revokeObjectURL(blurFrameUrl);
    blurFrameUrl = url;
  };
  img.src = url;
  img.hidden = false;
  previewStatus("");
  // Sem frame novo por 3 s: o blur parou ou perdeu a câmera.
  clearTimeout(blurFrameTimer);
  blurFrameTimer = setTimeout(() => previewSource === "blur" && previewStatus("O blur parou de mandar imagem."), 3000);
});

// --- Câmera virtual com blur e estado vindo do tray/atalhos ----------------------------
function showBlur(b) {
  if (!b) return;
  $("blur").checked = b.on;
  // A visão "Virtual" do preview depende só de a câmera virtual estar no ar (com ou
  // sem efeito), não do blur.
  blurOn = b.running || previewSource === "blur";
  $("previewSource").querySelector('[data-src="blur"]').disabled = !blurOn;
  if (blurOn && wantedSource === "blur" && previewSource !== "blur") setPreviewSource("blur", false);
  const st = $("blurStatus");
  st.classList.toggle("err", Boolean(b.error));
  st.textContent = b.error
    ? b.error
    : b.running
      ? `"EMEET PIXY (virtual)" no ar${b.on ? ", com fundo desfocado" : ", sem efeito"}${b.fps ? ` · ${b.fps} fps` : ""}`
      : "Iniciando a câmera virtual…";
}
$("blur").addEventListener("change", async (e) => showBlur(await window.pixy.setBlur(e.target.checked)));
window.pixy.onAppState((s) => {
  showMode(s);
  showBlur(s.blur);
});
window.pixy.getApp().then((s) => {
  showMode(s);
  showBlur(s.blur);
  showBlurConfig(s.blurConfig);
});

// Ajustes do blur: aplicados ao vivo (com folga de 80 ms entre envios) e salvos.
function showBlurConfig(c) {
  if (!c) return;
  $("blurAmount").value = c.blur;
  $("blurAmountVal").textContent = `${c.blur}px`;
  $("blurEdge").value = c.edge;
  $("blurEdgeVal").textContent = Number(c.edge).toFixed(2);
}
let blurCfgTimer = null;
for (const [id, key] of [["blurAmount", "blur"], ["blurEdge", "edge"]]) {
  $(id).addEventListener("input", (e) => {
    const v = +e.target.value;
    if (key === "blur") $("blurAmountVal").textContent = `${v}px`;
    else $("blurEdgeVal").textContent = v.toFixed(2);
    clearTimeout(blurCfgTimer);
    blurCfgTimer = setTimeout(() => window.pixy.setBlurConfig({ [key]: v }), 80);
  });
  $(id).addEventListener("change", (e) => e.target.blur());
}

// --- Atalhos globais (gravados nos atalhos personalizados do GNOME) ---------------------
const SHORTCUT_NAMES = { privacy: "Privacidade", tracking: "Tracking", blur: "Fundo desfocado" };
// KeyboardEvent.code -> keysym do GNOME
const KEYSYMS = {
  Space: "space", Minus: "minus", Equal: "equal", Comma: "comma", Period: "period", Slash: "slash",
  Backslash: "backslash", Semicolon: "semicolon", Quote: "apostrophe", Backquote: "grave",
  BracketLeft: "bracketleft", BracketRight: "bracketright", ArrowUp: "Up", ArrowDown: "Down",
  ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "Page_Up",
  PageDown: "Page_Down", Insert: "Insert", Delete: "Delete", Pause: "Pause", PrintScreen: "Print",
  Enter: "Return", Tab: "Tab",
};
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS|Super)(Left|Right)?$|^AltGraph$/;
let recording = null; // ação sendo gravada

function keysym(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(code))) return code;
  if ((m = /^Numpad(\d)$/.exec(code))) return `KP_${m[1]}`;
  return KEYSYMS[code] || null;
}

function renderShortcuts(all, messages = {}) {
  const box = $("shortcuts");
  box.textContent = "";
  for (const [action, name] of Object.entries(SHORTCUT_NAMES)) {
    const sc = all[action] || { accel: "", label: "" };
    const row = document.createElement("div");
    row.className = "sc-row";
    const title = document.createElement("span");
    title.textContent = name;
    const key = document.createElement("button");
    key.className = "sc-key" + (recording === action ? " recording" : sc.accel ? "" : " empty");
    key.textContent = recording === action ? "pressione…" : sc.label || "nenhum";
    key.addEventListener("click", () => {
      recording = recording === action ? null : action;
      renderShortcuts(all);
    });
    const clear = document.createElement("button");
    clear.className = "sc-clear";
    clear.textContent = "×";
    clear.title = "Remover atalho";
    clear.disabled = !sc.accel;
    clear.addEventListener("click", () => saveShortcut(action, ""));
    row.append(title, key, clear);
    const msg = messages[action];
    if (msg) {
      const m = document.createElement("div");
      m.className = "sc-msg";
      m.textContent = msg.text;
      if (msg.force) {
        const b = document.createElement("button");
        b.textContent = "Usar mesmo assim";
        b.addEventListener("click", () => saveShortcut(action, msg.force, true));
        m.append(b);
      }
      row.append(m);
    }
    box.append(row);
  }
  shortcutState = all;
}
let shortcutState = {};

async function saveShortcut(action, accel, force = false) {
  recording = null;
  try {
    const res = await window.pixy.setShortcut(action, accel, force);
    const messages = {};
    if (res.conflict) messages[action] = { text: `Já usado por ${res.conflict}.`, force: accel };
    renderShortcuts(res.shortcuts, messages);
  } catch (e) {
    toast(`Não consegui gravar o atalho: ${e.message}`);
    renderShortcuts(shortcutState);
  }
}

// Captura antes de qualquer outro atalho da janela (setas, T, P...).
window.addEventListener("keydown", (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.repeat || MODIFIER_CODES.test(e.code) || MODIFIER_CODES.test(e.key)) return;
  const mods = (e.ctrlKey ? "<Primary>" : "") + (e.altKey ? "<Alt>" : "") + (e.shiftKey ? "<Shift>" : "") + (e.metaKey ? "<Super>" : "");
  if (!mods && e.code === "Escape") {
    recording = null;
    return renderShortcuts(shortcutState);
  }
  if (!mods && e.code === "Backspace") return saveShortcut(recording, "");
  const key = keysym(e.code);
  if (!key) return;
  // Sem modificador só teclas que não atrapalham a digitação (F1–F12, Pause...).
  if (!mods && !/^(F\d+|Pause|Print|Insert)$/.test(key)) {
    return renderShortcuts(shortcutState, { [recording]: { text: "Use Ctrl, Alt, Shift ou Super junto." } });
  }
  saveShortcut(recording, mods + key);
}, true);
window.addEventListener("blur", () => {
  if (recording) {
    recording = null;
    renderShortcuts(shortcutState);
  }
});
window.pixy.getShortcuts().then((all) => renderShortcuts(all)).catch(() => {});

// --- Início ---------------------------------------------------------------------------
async function refreshAll() {
  try {
    await loadControls();
    if (app.camera && app.camera.vendorHid) showState(await call("state"));
    await pollPosition();
  } catch {}
}

(async () => {
  presets = await window.pixy.loadPresets();
  renderPresets();
  try {
    const st = await window.pixy.call("status");
    setConnected(Boolean(st.video));
  } catch {
    setConnected(false);
  }
})();

// Hotplug: enquanto desconectada, tenta de novo a cada 3 s.
setInterval(async () => {
  if (connected) return;
  try {
    const st = await window.pixy.call("status");
    if (st.video) setConnected(true);
  } catch {}
}, 3000);
// Iniciar com o sistema: o .desktop em ~/.config/autostart é a própria preferência.
window.pixy.getAutostart().then((on) => ($("autostart").checked = on)).catch(() => {});
$("autostart").addEventListener("change", async (e) => {
  try {
    e.target.checked = await window.pixy.setAutostart(e.target.checked);
  } catch (err) {
    toast(`Não consegui mudar o início automático: ${err.message}`);
    e.target.checked = !e.target.checked;
  }
});

// --- Câmeras conectadas e homologação ----------------------------------------------------
const CAM_STATUS = {
  homologada: "homologada",
  "firmware-nao-testado": "firmware não testado",
  "nao-suportada": "não suportada",
};
async function loadCameras() {
  const list = $("cams");
  let cams = [];
  try {
    cams = await window.pixy.getCameras();
  } catch {}
  list.textContent = "";
  if (!cams.length) {
    const li = document.createElement("li");
    li.textContent = "Nenhuma câmera USB encontrada.";
    list.append(li);
    return;
  }
  for (const c of cams) {
    const li = document.createElement("li");
    li.classList.toggle("selected", c.selected);
    li.addEventListener("click", async () => {
      if (c.selected) return;
      li.style.opacity = ".6";
      try {
        showMode(await window.pixy.selectCamera(c.id));
      } catch (e) {
        toast(`Não consegui trocar de câmera: ${e.message}`);
      }
      loadCameras();
      loadVideo().catch(() => {});
      refreshAll();
      if (previewOn && previewSource === "original") openPreview();
    });
    const tag = document.createElement("span");
    tag.className = `tag ${c.status}`;
    tag.textContent = CAM_STATUS[c.status];
    const sub = document.createElement("small");
    sub.textContent = `${c.vendor}:${c.product} · firmware ${c.firmware}` + (
      c.status === "firmware-nao-testado" ? ` (testado: ${c.homologada.firmwares.join(", ")}); pode funcionar, mas sem garantia`
        : c.status === "nao-suportada" ? "; o app controla só os modelos homologados" : "");
    li.append(tag, document.createTextNode(c.name), sub);
    if (c.homologada) li.title = `Testado em ${c.homologada.testado_em}: ${c.homologada.recursos.join(", ")}`;
    list.append(li);
  }
}
loadCameras();

// --- Diagnóstico: o que falta no sistema, com a correção --------------------------------
function showDiagnosis(items) {
  const box = $("diag");
  box.textContent = "";
  box.hidden = !items || !items.length;
  if (box.hidden) return;
  box.classList.toggle("only-warn", items.every((i) => i.level === "aviso"));
  const head = document.createElement("div");
  head.className = "diag-head";
  const title = document.createElement("b");
  const errors = items.filter((i) => i.level === "erro").length;
  title.textContent = errors ? `Falta configurar ${errors === 1 ? "1 item" : `${errors} itens`} no sistema` : "Avisos do sistema";
  const again = document.createElement("button");
  again.textContent = "Verificar de novo";
  again.addEventListener("click", async () => showDiagnosis(await window.pixy.runDiagnosis()));
  head.append(title, again);
  box.append(head);
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "diag-item";
    const lvl = document.createElement("span");
    lvl.className = `lvl ${it.level}`;
    lvl.textContent = it.level;
    const text = document.createElement("span");
    text.textContent = `${it.label}: ${it.detail}. Afeta: ${it.impact}.`;
    if (it.fix) {
      const code = document.createElement("code");
      code.textContent = it.fix;
      text.append(" ", code);
    }
    row.append(lvl, text);
    if (it.fix) {
      const copy = document.createElement("button");
      copy.textContent = "Copiar";
      copy.addEventListener("click", () => navigator.clipboard.writeText(it.fix).then(() => (copy.textContent = "Copiado")));
      row.append(copy);
    } else {
      row.append(document.createElement("span"));
    }
    box.append(row);
  }
}
window.pixy.onDiagnosis(showDiagnosis);
window.pixy.getDiagnosis().then(showDiagnosis).catch(() => {});

// O app reaplicou os ajustes salvos (abriu, ou a câmera voltou): mostra os valores reais.
window.pixy.onCameraReset(() => {
  refreshAll();
  loadCameras();
});
window.addEventListener("focus", () => connected && call("state").then(showState).catch(() => {}));
