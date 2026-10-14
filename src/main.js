const {
  app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, protocol, session, shell, Tray,
} = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const shortcuts = require("./shortcuts");

// Câmera via PipeWire (portal xdg): o preview e o blur dividem o stream com qualquer
// outro app que também use PipeWire, em vez de travar o /dev/video da PIXY só para si.
app.commandLine.appendSwitch("enable-features", "WebRtcPipeWireCamera");

// Código e páginas: a pasta do projeto, ou o app.asar quando empacotado (servidos pelo
// protocolo app://). Helper Python e pixy-toggle ficam fora do asar (o Python não lê
// de dentro dele): extraResources no pacote.
const ROOT = path.join(__dirname, "..");
const RES = app.isPackaged ? process.resourcesPath : ROOT;
const HELPER = path.join(RES, "helper", "pixyd.py");
const ASSETS = path.join(ROOT, "assets");
const OPS = new Set([
  "status", "list", "set", "state", "mode", "target", "gesture", "feature",
  "audio", "privacy_delay", "speed", "jog", "stop", "position", "goto", "holders",
]);
// Ajustes que o app lembra e reaplica: tudo o que a interface muda na câmera.
const HID_PREF_OPS = new Set(["gesture", "audio", "target", "privacy_delay"]);
// Atalhos globais: ver shortcuts.js. Os rótulos atuais ficam aqui para o menu do tray.
let shortcutLabels = {};
const SOCKET = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "pixy-control.sock");

// O MediaPipe busca o .wasm e o modelo com fetch, que não funciona em file://.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
  ".tflite": "application/octet-stream", ".png": "image/png", ".css": "text/css",
};

if (!app.requestSingleInstanceLock()) app.exit(0);

// Erro solto não derruba o app em silêncio: vai para o log.
process.on("uncaughtException", (err) => logLine("main", `erro não tratado: ${err.stack || err}`));
process.on("unhandledRejection", (err) => logLine("main", `promise rejeitada: ${(err && err.stack) || err}`));
app.on("child-process-gone", (_e, d) => logLine("main", `subprocesso ${d.type}${d.name ? ` (${d.name})` : ""} saiu: ${d.reason} (${d.exitCode})`));

let win = null;
let tray = null;
let quitting = false;

// --- IPC: só das páginas do próprio app ------------------------------------------------
// Cada canal tem dono: os da câmera virtual só aceitam a janela oculta dela, o resto só
// a janela principal — e sempre o frame principal, nunca um iframe.
const VIRTUAL_CHANNELS = new Set(["blur:frame", "blur:status", "blur:preview", "blur:config"]);
function trustedSender(channel, e) {
  const owner = VIRTUAL_CHANNELS.has(channel) ? blurWin : win;
  return Boolean(owner && !owner.isDestroyed() && e.sender === owner.webContents && e.senderFrame === e.sender.mainFrame);
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trustedSender(channel, e)) {
      logLine("ipc", `recusado: ${channel}`);
      throw new Error("origem não autorizada");
    }
    return fn(e, ...args);
  });
}
function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!trustedSender(channel, e)) return logLine("ipc", `recusado: ${channel}`);
    fn(e, ...args);
  });
}
const isOurPage = (wc) => Boolean(wc) && [win, blurWin].some((w) => w && !w.isDestroyed() && w.webContents === wc);

// --- Helper Python: um processo vivo, uma requisição JSON por linha -------------
let helper = null;
let helperMissing = false;
let nextId = 1;
const pending = new Map();

function startHelper() {
  helper = spawn("python3", ["-u", HELPER], { stdio: ["pipe", "pipe", "inherit"] });
  helper.stdin.on("error", () => {}); // python3 ausente: escrever num processo que não subiu
  readline.createInterface({ input: helper.stdout }).on("line", (line) => {
    let res;
    try {
      res = JSON.parse(line);
    } catch {
      return;
    }
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    const { id: _id, ok, error, ...data } = res; // id e ok são do protocolo, não da resposta
    ok ? p.resolve(data) : p.reject(new Error(error));
  });
  // python3 ausente: o spawn falha antes de existir processo; vira item do diagnóstico.
  helper.on("error", (e) => {
    helperMissing = e.code === "ENOENT";
    logLine("helper", `não iniciou: ${e.message}`);
    // quem já estava esperando não espera os 10 s do limite
    for (const p of pending.values()) p.reject(new Error("helper não iniciou (python3 ausente?)"));
    pending.clear();
    helper = null;
    if (helperMissing) runDiagnose().catch(() => {});
  });
  helper.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error(`helper saiu (${code})`));
    pending.clear();
    helper = null;
  });
}

function call(req) {
  if (helperMissing) return Promise.reject(new Error("python3 não encontrado: o app não fala com a câmera"));
  if (!helper) startHelper();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Resposta que nunca chega não pode travar quem espera (vigias, fila de modo).
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`helper sem resposta para ${req.op}`));
    }, 10000);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    helper.stdin.write(JSON.stringify({ ...req, id }) + "\n");
  });
}

// O joystick manda ~20 comandos/s: segura só o mais recente enquanto um está em voo,
// para a fila nunca crescer e a câmera seguir a mão sem atraso acumulado.
let jogBusy = false;
let jogNext = null;
async function jog(req) {
  if (jogBusy) {
    jogNext = req;
    return;
  }
  jogBusy = true;
  try {
    await call(req);
  } catch {
    // o watchdog do helper para a câmera; o renderer vê o erro no próximo poll
  } finally {
    jogBusy = false;
    if (jogNext) {
      const n = jogNext;
      jogNext = null;
      jog(n);
    }
  }
}

handle("pixy", async (_e, req) => {
  if (!req || !OPS.has(req.op)) throw new Error(`op não permitida: ${req && req.op}`);
  if (req.op === "jog") return jog(req);
  const res = await call(req);
  if (res && "mode" in res) onReadback(res.mode);
  rememberPref(req);
  return res;
});

// --- Preferências da câmera: salvas a cada ajuste, reaplicadas quando ela volta --------
// A câmera pode esquecer zoom e ajustes ao perder energia ou reiniciar; o app guarda o
// que foi escolhido na interface e reaplica ao abrir e sempre que ela reaparece no USB.
const AUTO_FIRST = ["white_balance_automatic", "auto_exposure", "focus_automatic_continuous"];
const cameraPrefs = () => ({ v4l2: {}, hid: {}, ...readJson("settings.json", {}).camera });

function rememberPref(req) {
  const prefs = cameraPrefs();
  if (req.op === "set" && !/^(pan|tilt)_absolute$/.test(req.name)) prefs.v4l2[req.name] = Number(req.value);
  else if (req.op === "goto" && req.zoom != null) prefs.v4l2.zoom_absolute = Math.round(Number(req.zoom));
  else if (req.op === "feature") prefs.hid[req.name] = Boolean(req.value);
  else if (HID_PREF_OPS.has(req.op)) prefs.hid[req.op] = req.value;
  else return;
  writeJson("settings.json", { ...readJson("settings.json", {}), camera: prefs });
}

// Primeira execução com esta função: o que está na câmera agora vira a referência.
async function snapshotCameraPrefs(controls) {
  const v4l2 = {};
  for (const c of controls) {
    if (!c.readonly && !/^(pan|tilt)_absolute$|^zoom_continuous$/.test(c.name) && c.value != null) v4l2[c.name] = c.value;
  }
  const st = await call({ op: "state" }).catch(() => ({}));
  const hid = {};
  for (const k of ["gesture", "audio", "target", "privacy_delay", "hflip", "vflip", "autorotate"]) if (st[k] != null) hid[k] = st[k];
  writeJson("settings.json", { ...readJson("settings.json", {}), camera: { v4l2, hid } });
  logLine("prefs", "primeira execução: ajustes atuais da câmera salvos como preferência");
}

async function applyCameraPrefs() {
  await call({ op: "reopen" });
  const { controls } = await call({ op: "list" });
  if (!readJson("settings.json", {}).camera) return snapshotCameraPrefs(controls);
  const prefs = cameraPrefs();
  const applied = [];
  const applyV4l2 = async (list, names) => {
    const byName = Object.fromEntries(list.map((c) => [c.name, c]));
    for (const name of names) {
      const c = byName[name];
      // Inativo = o automático correspondente está ligado e a câmera recusa o valor manual.
      if (!c || c.inactive || c.value === prefs.v4l2[name]) continue;
      try {
        await call({ op: "set", name, value: prefs.v4l2[name] });
        applied.push(name);
      } catch (e) {
        logLine("prefs", `${name}: ${e.message}`);
      }
    }
  };
  // Automáticos antes; depois relê, porque eles decidem quais manuais ficam ativos.
  const names = Object.keys(prefs.v4l2);
  await applyV4l2(controls, names.filter((n) => AUTO_FIRST.includes(n)));
  await applyV4l2((await call({ op: "list" })).controls, names.filter((n) => !AUTO_FIRST.includes(n)));
  const state = await call({ op: "state" }).catch(() => ({}));
  for (const [key, value] of Object.entries(prefs.hid)) {
    if (state[key] === value) continue;
    const req = ["hflip", "vflip", "autorotate"].includes(key) ? { op: "feature", name: key, value } : { op: key, value };
    try {
      await call(req);
      applied.push(key);
    } catch (e) {
      logLine("prefs", `${key}: ${e.message}`);
    }
  }
  if (applied.length) logLine("prefs", `reaplicado: ${applied.join(", ")}`);
  runDiagnose().catch(() => {}); // a câmera voltou: permissões e devices podem ter mudado
  if (win && !win.isDestroyed()) win.webContents.send("app:camera-reset");
}

// Câmera sumiu e voltou (identidade USB nova) ou o app acabou de abrir: reaplica.
let cameraId; // undefined = ainda não vista
let applyingPrefs = false;
async function watchCamera() {
  let id = null;
  try {
    id = (await call({ op: "status" })).device;
  } catch {}
  if (id && id !== cameraId && !applyingPrefs) {
    applyingPrefs = true;
    if (cameraId !== undefined) await sleep(1500); // dá tempo de a câmera terminar de subir
    try {
      await applyCameraPrefs();
      cameraId = id;
    } catch (e) {
      logLine("prefs", `falhou: ${e.message}`); // tenta de novo no próximo ciclo
    } finally {
      applyingPrefs = false;
    }
  } else if (!id && cameraId) {
    cameraId = null;
  }
}

// --- Modo da câmera: o que ela diz e o que o usuário quer ----------------------------
// A PIXY só tem modo de verdade enquanto algum app transmite: ociosa ela responde 03
// ("standby") e ignora pedidos de tracking, e ao acordar volta sempre para standard.
// Por isso o app guarda o modo desejado e o reaplica quando o vídeo abre.
// Privacidade é a exceção: vale mesmo ociosa.
let real = null; // última leitura: standard | tracking | privacy | standby
let desired = "standard"; // standard | tracking (carregado do settings.json no início)
const streaming = (m) => m === "standard" || m === "tracking";
const isTracking = () => desired === "tracking" && real !== "privacy";

function appState() {
  return { mode: real, desired, idle: real === "standby", blur: blurState, blurConfig: blurConfig(), video: videoConfig() };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send("app:state", appState());
  updateTray();
}

function setDesired(mode) {
  if (mode === desired) return;
  desired = mode;
  writeJson("settings.json", { ...readJson("settings.json", {}), desired });
}

// Comandos de modo passam por uma fila: dois toques rápidos no atalho viram duas
// alternâncias em sequência, cada uma decidida sobre o estado já confirmado.
let busy = false; // app mudando o modo: leituras do poll são ignoradas
let modeQueue = Promise.resolve();
let pendingGesture = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onReadback(mode) {
  if (!mode || busy) return;
  if (streaming(mode) && !streaming(real) && real !== "privacy" && mode !== desired) {
    // vídeo acabou de abrir e a câmera acordou no padrão: reaplica o desejado
    applyMode(() => desired);
  } else if (streaming(mode) && streaming(real) && mode !== real) {
    pendingGesture = mode; // talvez gesto; talvez o vídeo fechando (tracking → standard → ociosa)
  } else if (pendingGesture && mode === pendingGesture) {
    setDesired(mode); // continuou assim com o vídeo aberto: foi gesto
    pendingGesture = null;
  } else if (!streaming(mode)) {
    pendingGesture = null;
  }
  if (mode === real) return;
  real = mode;
  pushState();
}

function notifyMode() {
  const text = real === "privacy"
    ? "Privacidade ligada"
    : desired === "tracking"
      ? real === "standby" ? "Tracking ligado (começa quando o vídeo abrir)" : "Tracking ligado"
      : "Tracking desligado";
  if (Notification.isSupported()) new Notification({ title: "PIXY", body: text, silent: true }).show();
}

// A câmera demora a refletir o pedido (a lente se move): lê até bater ou estourar o prazo.
const accepts = (mode, got) => (mode === "privacy" ? got === "privacy" : got === mode || got === "standby");
async function confirmMode(mode, ms) {
  let got = null;
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) {
    got = (await call({ op: "mode" })).mode;
    if (accepts(mode, got)) break;
  }
  return got;
}

async function doApply(mode, notify) {
  if (mode !== "privacy") setDesired(mode);
  busy = true;
  try {
    await call({ op: "mode", value: mode });
    let got = await confirmMode(mode, mode === "tracking" ? 1200 : 2500);
    if (mode === "tracking" && got === "privacy") {
      // Câmera ociosa ignora o pedido de tracking, inclusive para sair da privacidade.
      // Standard ela aceita; o tracking segue como desejado e volta quando o vídeo abrir.
      await call({ op: "mode", value: "standard" });
      got = await confirmMode("standard", 2500);
    }
    real = got;
    pendingGesture = null;
    pushState();
    if (notify) notifyMode();
  } catch (e) {
    if (notify && Notification.isSupported()) new Notification({ title: "PIXY", body: e.message, silent: true }).show();
  } finally {
    busy = false;
  }
  return appState();
}

// mode pode ser uma função: o alvo é decidido quando chega a vez na fila.
function applyMode(mode, notify = false) {
  const run = modeQueue.then(() => doApply(typeof mode === "function" ? mode() : mode, notify));
  modeQueue = run.catch(() => {});
  return run;
}
// Privacidade alterna e devolve o modo de antes (standard ou tracking).
const togglePrivacy = (notify) => applyMode(() => (real === "privacy" ? desired : "privacy"), notify);
const toggleTracking = (notify) => applyMode(() => (desired === "tracking" && real !== "privacy" ? "standard" : "tracking"), notify);

handle("app:mode", (_e, mode) => applyMode(mode));
handle("app:toggle", (_e, what) => (what === "privacy" ? togglePrivacy(false) : toggleTracking(false)));
handle("app:get", () => appState());
handle("app:blur", (_e, on) => setEffect(on));

// --- Log: avisos e erros das janelas vão para o userData (o toast some em 4 s) -----
const LOG_MAX = 1024 * 1024; // passou de 1 MB: guarda só a metade mais nova
const LOG_NOISE = /^(performance warning:|WebGL: too many errors)/; // avisos do Chromium sem ação possível
// Escrita em fila, fora do caminho do processo principal; o tamanho é conferido de vez em quando.
let logQueue = Promise.resolve();
let logCount = 0;
function logLine(source, msg) {
  if (LOG_NOISE.test(String(msg))) return;
  const line = `${new Date().toISOString()} [${source}] ${msg}\n`;
  logQueue = logQueue
    .then(async () => {
      const file = dataFile("pixy-control.log");
      await fs.promises.appendFile(file, line);
      if (++logCount % 200 === 0 && (await fs.promises.stat(file)).size > LOG_MAX) {
        await fs.promises.writeFile(file, (await fs.promises.readFile(file, "utf8")).slice(-LOG_MAX / 2));
      }
    })
    .catch(() => {});
}
function logConsole(source, wc) {
  wc.on("console-message", (e) => {
    if (e.level === "warning" || e.level === "error") logLine(source, e.message);
  });
  wc.on("render-process-gone", (_e, d) => logLine(source, `renderer morreu: ${d.reason}`));
}

// --- Configurações e presets no userData ------------------------------------------
const dataFile = (name) => path.join(app.getPath("userData"), name);
function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), "utf8"));
  } catch {
    return fallback;
  }
}
// Grava num temporário e troca de uma vez: queda no meio não deixa o arquivo pela metade.
function writeJson(name, value) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const file = dataFile(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
handle("presets:load", () => readJson("presets.json", {}));
handle("presets:save", (_e, presets) => writeJson("presets.json", presets));

// Texto para o usuário quando a câmera não entrega imagem: quem está com ela aberta.
async function whoHoldsCamera() {
  try {
    const { holders } = await call({ op: "holders" });
    if (holders.some((h) => h.remote)) return "Câmera em uso por outro computador (acesso remoto por SSH): sem imagem aqui até ele soltar.";
    if (holders.length) return `Câmera aberta direto por ${holders.map((h) => h.name).join(", ")}: feche esse app para ver a imagem.`;
  } catch {}
  return "A câmera não está entregando imagem.";
}
handle("camera:holders", () => whoHoldsCamera());

// --- Câmera virtual com blur ----------------------------------------------------------
// Janela oculta (blur.html) faz a segmentação e manda frames I420 1280x720 (convertidos
// na GPU); o ffmpeg escreve no v4l2loopback "EMEET PIXY (virtual)". Ela fica sempre
// transmitindo enquanto o app roda; "blur" só liga e desliga o efeito, ao vivo, sem o
// Meet e afins perderem a câmera.
// Qualidade do vídeo (preview e blur): modo nativo da câmera, escolhido no app.
const VIDEO_DEFAULT = { width: 1280, height: 720, fps: 30 };
const videoConfig = () => ({ ...VIDEO_DEFAULT, ...readJson("settings.json", {}).video });
// Saída da câmera virtual: o modo escolhido, limitado a 1920x1080 (4K com blur não
// cabe no orçamento de um quadro) e com lados múltiplos de 4 (exigência da conversão I420).
function blurOutput(v = videoConfig()) {
  const k = Math.min(1, Math.sqrt((1920 * 1080) / (v.width * v.height)));
  const r4 = (x) => Math.max(4, Math.round(x / 4) * 4);
  return { width: r4(v.width * k), height: r4(v.height * k), fps: v.fps };
}
let blurWin = null;
let blurRetry = null;
let blurPreviewOn = false; // a janela principal está mostrando o preview com blur
const BLUR_DEFAULTS = { blur: 18, edge: 0.55 };
const blurConfig = () => ({ ...BLUR_DEFAULTS, ...readJson("settings.json", {}).blurConfig });
let ffmpeg = null;
let ffmpegBusy = false;
let blurState = { on: false, running: false, fps: null, error: null };

const VIRTUAL_LABEL = "EMEET PIXY (virtual)";
// Sinal para outros programas (ex.: um script que retransmite a câmera para outro PC):
// existe enquanto este app escreve na câmera virtual. O loopback anuncia captura sempre (exclusive_caps=0, para o PipeWire listá-lo),
// então "tem captura" não diz se há imagem; o PID do ffmpeg vivo diz.
const VIRTUAL_MARKER = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "pixy-control-virtual.json");
const clearMarker = () => fs.rmSync(VIRTUAL_MARKER, { force: true });
let virtualWanted = false; // a câmera virtual deve estar no ar (do início do app até sair)

function findBlurDevice() {
  for (const name of fs.readdirSync("/sys/class/video4linux")) {
    try {
      if (fs.readFileSync(`/sys/class/video4linux/${name}/name`, "utf8").trim() === VIRTUAL_LABEL) return `/dev/${name}`;
    } catch {}
  }
  return null;
}

function setBlurState(patch) {
  if (patch.error) logLine("blur", patch.error);
  blurState = { ...blurState, ...patch };
  pushState();
}

function startFfmpeg() {
  const dev = findBlurDevice();
  if (!dev) {
    setBlurState({ running: false, error: `v4l2loopback "${VIRTUAL_LABEL}" não existe (ver README)` });
    return;
  }
  const out = blurOutput();
  ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    // a janela do blur já entrega I420 convertido na GPU: o ffmpeg só repassa
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", `${out.width}x${out.height}`, "-framerate", String(out.fps), "-i", "-",
    "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-f", "v4l2", dev,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  fs.writeFileSync(VIRTUAL_MARKER, JSON.stringify({ device: dev, pid: ffmpeg.pid, ...out }));
  let err = "";
  ffmpeg.on("error", (e) => {
    // ffmpeg ausente: sem isto o erro escapava como "não tratado" e a câmera virtual
    // ficava parada em "Iniciando…" sem dizer por quê.
    setBlurState({ running: false, error: e.code === "ENOENT" ? "ffmpeg não está instalado (sudo apt install ffmpeg)" : `ffmpeg: ${e.message}` });
  });
  ffmpeg.stderr.on("data", (d) => (err += d));
  ffmpeg.stdin.on("error", () => {});
  ffmpeg.on("exit", (code) => {
    clearMarker();
    ffmpeg = null;
    ffmpegBusy = false;
    if (virtualWanted && code) setBlurState({ running: false, error: `ffmpeg: ${err.trim().split("\n").pop() || code}` });
  });
}

on("blur:frame", (e, buffer) => {
  if (!blurWin || e.sender !== blurWin.webContents) return;
  if (!ffmpeg) {
    logLine("blur", "primeiro frame: iniciando ffmpeg");
    startFfmpeg();
  }
  if (!ffmpeg || ffmpegBusy) return; // ffmpeg atrasado: descarta o frame em vez de acumular
  if (!ffmpeg.stdin.write(Buffer.from(buffer))) {
    ffmpegBusy = true;
    ffmpeg.stdin.once("drain", () => (ffmpegBusy = false));
  }
});
handle("video:get", async () => {
  let modes = [];
  try {
    modes = (await call({ op: "modes" })).modes;
  } catch (e) {
    logLine("video", e.message);
  }
  return { modes, current: videoConfig(), blurOutput: blurOutput() };
});
handle("video:set", async (_e, v) => {
  const next = { width: Math.round(+v.width), height: Math.round(+v.height), fps: Math.round(+v.fps) };
  if (!(next.width > 0 && next.height > 0 && next.fps > 0)) throw new Error("modo inválido");
  writeJson("settings.json", { ...readJson("settings.json", {}), video: next });
  logLine("video", `modo: ${next.width}x${next.height}@${next.fps}`);
  // A câmera virtual abriu a câmera e o v4l2loopback no tamanho antigo: reabre os dois.
  restartVirtual();
  pushState();
  return { current: next, blurOutput: blurOutput() };
});

handle("blur:config", () => ({ ...blurConfig(), preview: blurPreviewOn, effect: blurState.on }));
handle("app:blur-config", (_e, patch) => {
  const next = { ...blurConfig() };
  if (patch && Number.isFinite(+patch.blur)) next.blur = +patch.blur;
  if (patch && Number.isFinite(+patch.edge)) next.edge = +patch.edge;
  writeJson("settings.json", { ...readJson("settings.json", {}), blurConfig: next });
  if (blurWin) blurWin.webContents.send("blur:config", next);
  return next;
});
handle("app:blur-preview", (_e, on) => {
  blurPreviewOn = Boolean(on);
  if (blurWin) blurWin.webContents.send("blur:config", { preview: blurPreviewOn });
});
on("blur:preview", (e, buffer) => {
  if (blurWin && e.sender === blurWin.webContents && win && !win.isDestroyed()) win.webContents.send("blur:preview", buffer);
});

on("blur:status", async (e, s) => {
  if (!blurWin || e.sender !== blurWin.webContents) return;
  if (!s.error) logLine("blur", JSON.stringify(s));
  if (s.noFrames || s.error) {
    // Sem imagem (alguém segurando a câmera) ou erro ao abrir (ex.: preview e blur
    // pedindo a câmera ao portal no mesmo instante): mostra o motivo e tenta de novo.
    s = { ...s, error: `${s.noFrames ? await whoHoldsCamera() : s.error} Tentando de novo…` };
    // A câmera pode voltar (o acesso remoto solta, o outro app fecha): reabre a janela
    // da câmera virtual, que pede a câmera de novo.
    clearTimeout(blurRetry);
    blurRetry = setTimeout(() => virtualWanted && restartVirtual(), 5000);
  }
  setBlurState(s);
});

function startVirtual() {
  virtualWanted = true;
  if (blurWin) return blurState;
  setBlurState({ on: Boolean(readJson("settings.json", {}).blur), running: false, fps: null, error: null });
  blurWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 180,
    webPreferences: {
      preload: path.join(__dirname, "blur-preload.js"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // escondida, mas precisa rodar no fps da câmera
    },
  });
  logConsole("blur", blurWin.webContents);
  const v = videoConfig();
  const o = blurOutput(v);
  blurWin.loadURL(`app://pixy/src/blur.html?cw=${v.width}&ch=${v.height}&fps=${v.fps}&w=${o.width}&h=${o.height}`);
  const w = blurWin;
  w.on("closed", () => {
    if (blurWin === w) blurWin = null; // uma janela antiga fechando não apaga a nova
  });
  return blurState;
}

function stopVirtual() {
  virtualWanted = false;
  clearTimeout(blurRetry);
  if (blurWin) blurWin.destroy();
  blurWin = null;
  if (ffmpeg) {
    ffmpeg.stdin.end();
    ffmpeg.kill();
  }
  setBlurState({ running: false, fps: null });
}

function restartVirtual() {
  if (blurWin) blurWin.destroy();
  blurWin = null;
  if (ffmpeg) ffmpeg.kill();
  startVirtual();
}

// Liga/desliga só o efeito: a câmera virtual continua no ar, sem trocar de imagem
// para os apps que estão usando.
function setEffect(on) {
  writeJson("settings.json", { ...readJson("settings.json", {}), blur: Boolean(on) });
  if (blurWin) blurWin.webContents.send("blur:config", { effect: Boolean(on) });
  setBlurState({ on: Boolean(on) });
  return blurState;
}

// --- Como relançar o app (atalhos do GNOME, início automático) --------------------------
// No AppImage o caminho de dentro muda a cada execução; o que é estável é o próprio
// .AppImage. No .deb, o binário instalado. Em desenvolvimento, o Electron + a pasta.
function launchCommand() {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  if (app.isPackaged) return [process.execPath];
  return [process.execPath, ROOT];
}

// Cópias estáveis na pasta de configuração: o pixy-toggle (chamado pelos atalhos do GNOME)
// e o ícone (usado pelos .desktop), mais o comando de relançar para o pixy-toggle.
function installHelpers() {
  const dir = path.join(app.getPath("userData"), "bin");
  fs.mkdirSync(dir, { recursive: true });
  const toggle = path.join(dir, "pixy-toggle");
  fs.copyFileSync(path.join(RES, "bin", "pixy-toggle"), toggle);
  fs.chmodSync(toggle, 0o755);
  fs.copyFileSync(path.join(ASSETS, "tray.png"), installedIcon());
  // setup do sistema + o que ele instala (regra udev, regra do WirePlumber)
  for (const sub of ["setup", "udev", "wireplumber"]) {
    fs.cpSync(path.join(RES, sub), path.join(app.getPath("userData"), "system", sub), { recursive: true });
  }
  fs.chmodSync(SETUP(), 0o755);
  writeJson("launcher.json", { exec: launchCommand() });
  shortcuts.setToggle(toggle);
}
const installedIcon = () => path.join(app.getPath("userData"), "icon.png");

// --- Iniciar com o sistema -------------------------------------------------------------
// No Linux o setLoginItemSettings do Electron não faz nada: o padrão do GNOME (XDG) é um
// .desktop em ~/.config/autostart. Abre direto no tray (--hidden), com a câmera virtual.
const AUTOSTART = path.join(app.getPath("home"), ".config", "autostart", "pixy-control.desktop");
function autostartEnabled() {
  try {
    return !/^X-GNOME-Autostart-enabled=false/m.test(fs.readFileSync(AUTOSTART, "utf8"));
  } catch {
    return false;
  }
}
function setAutostart(on) {
  if (!on) {
    fs.rmSync(AUTOSTART, { force: true });
    return false;
  }
  fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
  fs.writeFileSync(AUTOSTART, [
    "[Desktop Entry]",
    "Type=Application",
    "Name=PIXY Control",
    "Comment=Controle da webcam EMEET PIXY (abre no tray)",
    `Exec=${launchCommand().map((a) => `"${a}"`).join(" ")} --hidden`,
    `Icon=${installedIcon()}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    // dá tempo de PipeWire, portal e tray subirem antes de pedir a câmera
    "X-GNOME-Autostart-Delay=5",
    "",
  ].join("\n"));
  return true;
}
handle("autostart:get", () => autostartEnabled());
handle("autostart:set", (_e, on) => setAutostart(Boolean(on)));

// --- Atalhos globais ---------------------------------------------------------------
const withShortcut = (text, action) => (shortcutLabels[action] ? `${text} (${shortcutLabels[action]})` : text);

async function loadShortcuts() {
  const all = await shortcuts.get();
  shortcutLabels = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.label]));
  updateTray();
  return all;
}
handle("shortcuts:get", () => loadShortcuts());
handle("shortcuts:set", async (_e, { action, accel, force }) => {
  const res = await shortcuts.set(action, accel, force);
  return { ...res, shortcuts: await loadShortcuts() };
});

function toggleBlur(notify) {
  const on = !blurState.on;
  setEffect(on);
  if (notify && Notification.isSupported()) {
    new Notification({ title: "PIXY", body: on ? "Fundo desfocado ligado" : "Fundo desfocado desligado", silent: true }).show();
  }
}

// --- Câmeras homologadas ---------------------------------------------------------------
// src/cameras.json lista os modelos testados; cada câmera conectada sai como homologada,
// modelo homologado com firmware não testado, ou não suportada.
const { classify } = require("./cameras");
const camerasStatus = async () => classify((await call({ op: "cameras" })).cameras);
handle("cameras:get", () => camerasStatus());

// --- Diagnóstico do que o app precisa do sistema --------------------------------------
// Roda ao abrir, quando a câmera reaparece e pelo botão da faixa. Cada item que falta vai
// para a janela com a correção, em vez de a parte correspondente falhar em silêncio.
// Cópia estável (installHelpers): no AppImage os recursos ficam num ponto de montagem
// que muda a cada execução.
const SETUP = () => path.join(app.getPath("userData"), "system", "setup", "pixy-control-setup");
const DIAG_INFO = {
  python3: { label: "python3", level: "erro", fix: "sudo apt install python3", impact: "nada funciona sem ele (fala com a câmera)" },
  ffmpeg: { label: "ffmpeg", level: "erro", fix: "sudo apt install ffmpeg", impact: "câmera virtual" },
  "pw-dump": { label: "pw-dump", level: "erro", fix: "sudo apt install pipewire-bin", impact: "lista de resoluções e fps" },
  "pw-cli": { label: "pw-cli", level: "erro", fix: "sudo apt install pipewire-bin", impact: "lista de resoluções e fps" },
  gsettings: { label: "gsettings (GNOME)", level: "aviso", fix: "", impact: "atalhos globais só funcionam no GNOME" },
  hid: { label: "acesso ao HID da câmera", level: "erro", fix: () => `sudo "${SETUP()}"`, impact: "privacidade, tracking, gestos, áudio, joystick" },
  v4l2loopback: { label: "câmera virtual (v4l2loopback)", level: "erro", fix: () => `sudo apt install v4l2loopback-dkms && sudo "${SETUP()}"`, impact: "câmera virtual e fundo desfocado" },
  wireplumber: { label: "regra do WirePlumber", level: "aviso", fix: () => `sudo "${SETUP()}"`, impact: "só se o preview disser que não há câmera (Ubuntu 24.04)" },
};
let diagnosis = [];

async function runDiagnose() {
  let items = [];
  if (helperMissing) {
    items = [{ id: "python3", ok: false, detail: "não encontrado no PATH" }];
  } else {
    try {
      items = (await call({ op: "diagnose" })).items.filter((i) => i.id !== "camera"); // câmera já tem a bolinha
    } catch (e) {
      items = [{ id: "python3", ok: false, detail: `helper não responde: ${e.message}` }];
    }
  }
  diagnosis = items
    .filter((i) => !i.ok && DIAG_INFO[i.id])
    .map((i) => {
      const info = DIAG_INFO[i.id];
      return { id: i.id, label: info.label, level: info.level, impact: info.impact, detail: i.detail, fix: typeof info.fix === "function" ? info.fix() : info.fix };
    });
  if (diagnosis.length) logLine("diagnostico", diagnosis.map((d) => `${d.id}: ${d.detail}`).join("; "));
  if (win && !win.isDestroyed()) win.webContents.send("app:diagnose", diagnosis);
  return diagnosis;
}
handle("diagnose:get", () => diagnosis);
handle("diagnose:run", () => runDiagnose());

// --- Atualizações (só no app empacotado) -----------------------------------------------
// AppImage: baixa sozinho e aplica ao sair. .deb: só avisa (instalar exige senha de admin).
const RELEASES_URL = "https://github.com/aronpc/pixy-control/releases/latest";
let update = null; // { version, ready }
let autoUpdater = null;
const canSelfUpdate = () => Boolean(process.env.APPIMAGE);

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: "PIXY Control", body, silent: true }).show();
}

function setupUpdates() {
  if (!app.isPackaged) return;
  ({ autoUpdater } = require("electron-updater"));
  autoUpdater.logger = { info: (m) => logLine("update", m), warn: (m) => logLine("update", m), error: (m) => logLine("update", m), debug() {} };
  autoUpdater.autoDownload = canSelfUpdate();
  autoUpdater.autoInstallOnAppQuit = canSelfUpdate();
  autoUpdater.on("update-available", (info) => {
    update = { version: info.version, ready: false };
    updateTray();
    if (!canSelfUpdate()) notify(`Versão ${info.version} disponível. Pelo menu do tray dá para abrir a página de download.`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    update = { version: info.version, ready: true };
    updateTray();
    notify(`Versão ${info.version} baixada: entra quando o app fechar (ou pelo menu do tray, agora).`);
  });
  autoUpdater.on("error", (e) => logLine("update", `erro: ${e.message}`));
  const check = () => autoUpdater.checkForUpdates().catch((e) => logLine("update", `erro: ${e.message}`));
  setTimeout(check, 30000); // depois que o app terminou de subir
  setInterval(check, 6 * 3600 * 1000);
}

function updateMenuItems() {
  if (!app.isPackaged) return [];
  if (update && update.ready) {
    return [{ label: `Reiniciar e atualizar para ${update.version}`, click: () => autoUpdater.quitAndInstall() }];
  }
  if (update && !canSelfUpdate()) {
    return [{ label: `Versão ${update.version} disponível (abrir página)`, click: () => shell.openExternal(RELEASES_URL) }];
  }
  return [{ label: "Verificar atualizações", click: () => autoUpdater.checkForUpdates().then((r) => {
    if (!r || !r.isUpdateAvailable) notify(`Você está na versão mais nova (${app.getVersion()}).`);
  }).catch((e) => notify(`Não deu para verificar: ${e.message}`)) }];
}

// --- Tray -----------------------------------------------------------------------------
function updateTray() {
  if (!tray) return;
  const icon = real === "privacy" ? "tray-privacy.png" : isTracking() ? "tray-tracking.png" : "tray.png";
  tray.setImage(nativeImage.createFromPath(path.join(ASSETS, icon)));
  const mode = real === "privacy"
    ? "privacidade"
    : `${desired === "tracking" ? "tracking" : "standard"}${real === "standby" ? " (câmera ociosa)" : ""}`;
  tray.setToolTip(`PIXY: ${mode}${blurState.running && blurState.on ? " · fundo desfocado" : ""}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Mostrar PIXY Control", click: showWindow },
    { type: "separator" },
    { label: withShortcut("Privacidade", "privacy"), type: "checkbox", checked: real === "privacy", click: () => togglePrivacy(false) },
    { label: withShortcut("Tracking", "tracking"), type: "checkbox", checked: isTracking(), click: () => toggleTracking(false) },
    {
      label: withShortcut(blurState.error ? "Fundo desfocado (câmera virtual com erro)" : "Fundo desfocado", "blur"),
      type: "checkbox",
      checked: blurState.on,
      click: (item) => setEffect(item.checked),
    },
    { type: "separator" },
    ...updateMenuItems(),
    { label: "Sair", click: () => app.quit() },
  ]));
}

// --- Janela ---------------------------------------------------------------------------
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createWindow() {
  const bounds = readJson("settings.json", {}).window || {};
  win = new BrowserWindow({
    width: bounds.width || 980,
    height: bounds.height || 720,
    ...(Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 560,
    title: "PIXY Control",
    icon: path.join(ASSETS, "tray.png"),
    backgroundColor: "#111317",
    autoHideMenuBar: true,
    show: !process.argv.includes("--hidden"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  logConsole("janela", win.webContents);
  // Pelo protocolo app:// (como a câmera virtual), e não file://: o fuse que dá
  // privilégios extras a file:// fica desligado no pacote.
  win.loadURL("app://pixy/src/index.html");
  // PIXY_SCREENSHOT=arquivo.png: captura a janela depois de carregar e sai (verificação).
  if (process.env.PIXY_SCREENSHOT) {
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      fs.writeFileSync(process.env.PIXY_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, 2500));
  }
  if (bounds.maximized) win.maximize();
  // Tamanho e posição da janela sobrevivem a fechar e reabrir o app.
  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const b = win.getNormalBounds();
      writeJson("settings.json", { ...readJson("settings.json", {}), window: { ...b, maximized: win.isMaximized() } });
    }, 400);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) win.on(ev, saveBounds);
  // Fechar esconde no tray; sair é pelo menu do tray.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // Janela perdeu o foco com tecla pressionada: não deixa a câmera andando.
  win.on("blur", () => call({ op: "stop" }).catch(() => {}));
}

function runToggle(argv) {
  const arg = argv.find((a) => a.startsWith("--toggle="));
  if (!arg) return false;
  const what = arg.slice("--toggle=".length);
  if (what === "privacy") togglePrivacy(true);
  else if (what === "tracking") toggleTracking(true);
  else if (what === "blur") toggleBlur(true);
  return true;
}

// Nenhuma página do app navega para outro lugar nem abre janela: um link ou bug que
// tentasse levaria junto a ponte de IPC.
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-navigate", (ev, url) => {
    ev.preventDefault();
    logLine("seguranca", `navegação bloqueada: ${url}`);
  });
  wc.on("will-attach-webview", (ev) => ev.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    logLine("seguranca", `janela nova bloqueada: ${url}`);
    return { action: "deny" };
  });
});

app.on("second-instance", (_e, argv) => runToggle(argv) || showWindow());

function listenToggles() {
  try {
    fs.unlinkSync(SOCKET); // sobra de uma execução anterior: o lock de instância única garante que é nosso
  } catch {}
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", (d) => {
      for (const what of d.split("\n")) if (what.trim()) runToggle([`--toggle=${what.trim()}`]);
    });
    conn.on("error", () => {});
  });
  server.on("error", (e) => console.error(`socket ${SOCKET}: ${e.message}`));
  server.listen(SOCKET);
  app.on("will-quit", () => server.close());
}

app.whenReady().then(async () => {
  protocol.handle("app", async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response("", { status: 403 });
    try {
      const body = await fs.promises.readFile(file); // o .wasm tem ~9 MB: não trava o processo principal
      return new Response(body, { headers: { "content-type": MIME[path.extname(file)] || "application/octet-stream" } });
    } catch {
      return new Response("", { status: 404 });
    }
  });
  // Preview e blur: só a câmera local, sem prompt.
  // Câmera e cópia para a área de transferência (botão "Copiar" do diagnóstico), só para
  // as páginas do app.
  const allowed = new Set(["media", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission) && isOurPage(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission) && isOurPage(wc));
  startHelper();
  createWindow();

  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, "tray.png")));
  updateTray();
  listenToggles();
  try {
    installHelpers();
    if (autostartEnabled()) setAutostart(true); // regrava: o caminho do app pode ter mudado
  } catch (e) {
    logLine("main", `instalar auxiliares: ${e.message}`);
  }
  shortcuts.ensureDefaults().catch((e) => logLine("atalhos", e.message)).finally(() => loadShortcuts().catch(() => {}));

  desired = readJson("settings.json", {}).desired === "tracking" ? "tracking" : "standard";
  // Lê o modo a cada 2 s: pega o vídeo abrindo (para reaplicar o tracking) e
  // mudanças feitas fora do app, como gestos.
  const poll = () => call({ op: "mode" }).then((s) => onReadback(s.mode)).catch(() => {});
  await poll();
  setInterval(poll, 2000);
  watchCamera();
  setInterval(watchCamera, 3000);
  runToggle(process.argv); // aberto pelo pixy-toggle com o app fechado
  startVirtual(); // câmera virtual sempre no ar, com ou sem o efeito
  setTimeout(() => runDiagnose().catch(() => {}), 1500); // dá tempo de o helper subir
  setupUpdates();
});

app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  stopVirtual();
  call({ op: "stop" }).catch(() => {});
  if (helper) helper.stdin.end();
});
// Com tray, fechar a última janela não encerra o app.
app.on("window-all-closed", () => {});
