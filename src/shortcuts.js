// Atalhos globais do app guardados como atalhos personalizados do GNOME.
// O GNOME dispara `bin/pixy-toggle <ação>`, que avisa o app pelo socket. Fica no GNOME,
// e não no globalShortcut do Electron, porque no X11 o grab do Electron não casa
// quando o layout de teclado ativo não é o primeiro da lista.
const { execFile } = require("node:child_process");
const path = require("node:path");

const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";
// Caminho do pixy-toggle: o app instala uma cópia estável na pasta de configuração (no
// AppImage o caminho dos recursos muda a cada execução) e informa aqui.
let TOGGLE = path.join(__dirname, "..", "bin", "pixy-toggle");
const setToggle = (p) => (TOGGLE = p);

const ACTIONS = {
  privacy: { name: "PIXY: alternar privacidade", default: "<Primary><Alt><Shift>p" },
  tracking: { name: "PIXY: alternar tracking", default: "<Primary><Alt><Shift>t" },
  blur: { name: "PIXY: alternar fundo desfocado", default: "" },
};

// Esquemas do GNOME onde um atalho pode já estar em uso.
const SYSTEM_SCHEMAS = [
  "org.gnome.desktop.wm.keybindings",
  "org.gnome.shell.keybindings",
  "org.gnome.mutter.keybindings",
  "org.gnome.mutter.wayland.keybindings",
  MEDIA_KEYS,
];

function gsettings(...args) {
  return new Promise((resolve, reject) => {
    execFile("gsettings", args, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())));
  });
}

// Valores do gsettings vêm em sintaxe GVariant: 'texto', ['a', 'b'] ou @as [].
function parseStrings(value) {
  return [...value.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
}
const quote = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const entryPath = (action) => `${CUSTOM_PATH}pixy-${action}/`;
const entrySchema = (action) => `${MEDIA_KEYS}.custom-keybinding:${entryPath(action)}`;

// Forma canônica para comparar: <Primary> e <Control> são a mesma tecla, e a ordem
// dos modificadores não importa.
function normalize(accel) {
  if (!accel) return "";
  const mods = new Set();
  const key = accel.replace(/<([^>]+)>/g, (_m, mod) => {
    const m = mod.toLowerCase();
    mods.add(m === "primary" || m === "ctrl" || m === "control" ? "control" : m);
    return "";
  });
  return [...[...mods].sort(), key.toLowerCase()].join("+");
}

// "<Primary><Alt><Shift>p" -> "Ctrl+Alt+Shift+P", para mostrar na tela e no tray.
function label(accel) {
  if (!accel) return "";
  const names = { primary: "Ctrl", control: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super", meta: "Meta" };
  const mods = [];
  const key = accel.replace(/<([^>]+)>/g, (_m, mod) => {
    mods.push(names[mod.toLowerCase()] || mod);
    return "";
  });
  const pretty = key.length === 1 ? key.toUpperCase() : key.replace(/_/g, " ");
  return [...mods, pretty].join("+");
}

async function customList() {
  return parseStrings(await gsettings("get", MEDIA_KEYS, "custom-keybindings"));
}

async function get() {
  const out = {};
  for (const action of Object.keys(ACTIONS)) {
    let accel = "";
    try {
      accel = parseStrings(await gsettings("get", entrySchema(action), "binding"))[0] || "";
    } catch {}
    out[action] = { accel, label: label(accel) };
  }
  return out;
}

// Quem já usa este atalho no GNOME (fora a própria ação), ou null.
async function findConflict(accel, action) {
  const want = normalize(accel);
  for (const schema of SYSTEM_SCHEMAS) {
    let listing = "";
    try {
      listing = await gsettings("list-recursively", schema);
    } catch {
      continue;
    }
    for (const line of listing.split("\n")) {
      const [, key, value] = line.match(/^\S+ (\S+) (.*)$/) || [];
      if (key && key !== "custom-keybindings" && parseStrings(value || "").some((a) => normalize(a) === want)) {
        return `${key} (${schema.replace("org.gnome.", "")})`;
      }
    }
  }
  for (const p of await customList()) {
    if (p === entryPath(action)) continue;
    const schema = `${MEDIA_KEYS}.custom-keybinding:${p}`;
    try {
      const binding = parseStrings(await gsettings("get", schema, "binding"))[0];
      if (binding && normalize(binding) === want) {
        return `"${parseStrings(await gsettings("get", schema, "name"))[0] || p}" (atalho personalizado)`;
      }
    } catch {}
  }
  return null;
}

// Grava o atalho (accel vazio desliga). Com conflito e sem force, não grava e devolve
// quem está usando a combinação.
async function set(action, accel, force = false) {
  if (!ACTIONS[action]) throw new Error(`ação desconhecida: ${action}`);
  if (accel && !force) {
    const conflict = await findConflict(accel, action);
    if (conflict) return { conflict };
  }
  const list = await customList();
  if (!list.includes(entryPath(action))) {
    list.push(entryPath(action));
    await gsettings("set", MEDIA_KEYS, "custom-keybindings", `[${list.map(quote).join(", ")}]`);
  }
  await gsettings("set", entrySchema(action), "name", ACTIONS[action].name);
  await gsettings("set", entrySchema(action), "command", `${TOGGLE} ${action}`);
  await gsettings("set", entrySchema(action), "binding", accel);
  return { ok: true };
}

// Primeira execução: cria os atalhos padrão que ainda não existem. Nas seguintes, só
// atualiza o comando dos que existem (o app pode ter mudado de lugar: dev, .deb, AppImage).
async function ensureDefaults() {
  const current = await get();
  const list = await customList();
  for (const [action, def] of Object.entries(ACTIONS)) {
    if (!list.includes(entryPath(action))) {
      if (!current[action].accel && def.default) await set(action, def.default, true);
      continue;
    }
    const cmd = `${TOGGLE} ${action}`;
    const now = parseStrings(await gsettings("get", entrySchema(action), "command"))[0];
    if (now !== cmd) await gsettings("set", entrySchema(action), "command", cmd);
  }
}

module.exports = { ACTIONS, get, set, label, normalize, ensureDefaults, setToggle };
