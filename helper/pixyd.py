#!/usr/bin/env python3
"""Ponte entre o app e a EMEET PIXY (328f:00c0).

Dois caminhos de controle:
- V4L2 (UVC padrão, via ioctl): imagem, foco, exposição e PTZ absoluto.
- HID do fabricante (/dev/hidrawN, relatórios de 32 bytes, ID 0x09): modo
  (standard/tracking/privacidade), gestos, flip, áudio e velocidade dos motores.

Modo servidor (padrão): um comando JSON por linha no stdin, uma resposta JSON
por linha no stdout. Modo CLI para depurar: `pixyd.py list`, `pixyd.py state`,
`pixyd.py set pan_absolute 0`, `pixyd.py hid "09 05 00 04"`.

Protocolo HID conferido no hardware em 14/10/26, a partir do trabalho de
engenharia reversa do PixyDeck (dalu951/pixydeck) e do emeet-pixyd.
"""
import ctypes, fcntl, glob, json, os, re, select, struct, subprocess, sys, time

# --- V4L2 ----------------------------------------------------------------------
def _iowr(nr, size):
    return (3 << 30) | (size << 16) | (ord("V") << 8) | nr


class QueryCtrl(ctypes.Structure):
    _fields_ = [("id", ctypes.c_uint32), ("type", ctypes.c_uint32), ("name", ctypes.c_char * 32),
                ("minimum", ctypes.c_int32), ("maximum", ctypes.c_int32), ("step", ctypes.c_int32),
                ("default_value", ctypes.c_int32), ("flags", ctypes.c_uint32),
                ("reserved", ctypes.c_uint32 * 2)]


class Control(ctypes.Structure):
    _fields_ = [("id", ctypes.c_uint32), ("value", ctypes.c_int32)]


class QueryMenu(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("id", ctypes.c_uint32), ("index", ctypes.c_uint32), ("name", ctypes.c_char * 32),
                ("reserved", ctypes.c_uint32)]


VIDIOC_G_CTRL = _iowr(27, ctypes.sizeof(Control))
VIDIOC_S_CTRL = _iowr(28, ctypes.sizeof(Control))
VIDIOC_QUERYCTRL = _iowr(36, ctypes.sizeof(QueryCtrl))
VIDIOC_QUERYMENU = _iowr(37, ctypes.sizeof(QueryMenu))
FLAG_NEXT_CTRL = 0x80000000
FLAG_DISABLED, FLAG_READ_ONLY, FLAG_INACTIVE = 0x1, 0x4, 0x10
TYPES = {1: "int", 2: "bool", 3: "menu"}

ARCSEC = 3600  # pan/tilt do V4L2 em segundos de arco; o motor fala em graus
PAN_LIMIT = 150
TILT_MIN, TILT_MAX = -52, 90  # abaixo de -52° a PIXY só aponta para a própria base


def snake(name):
    out = "".join(c.lower() if c.isalnum() else "_" for c in name)
    while "__" in out:
        out = out.replace("__", "_")
    return out.strip("_")


# Câmeras com o HID do fabricante (as homologadas): só nelas o helper manda relatórios HID.
HID_MODELS = {("328f", "00c0")}  # EMEET PIXY
selected = None  # /dev/v4l/by-id/... escolhido no app; None = a PIXY, ou a primeira câmera


def by_id_cameras():
    return sorted(glob.glob("/dev/v4l/by-id/*-video-index0"))


def find_video():
    if selected:
        return os.path.realpath(selected) if os.path.exists(selected) else None  # escolhida, mas desconectada
    hits = [p for p in by_id_cameras() if "EMEET_PIXY" in p] or by_id_cameras()
    return os.path.realpath(hits[0]) if hits else None


def usb_device(dev):
    """Pasta sysfs do aparelho USB de um /dev/videoN (onde ficam idVendor, bcdDevice...)."""
    if not dev:
        return None
    path = os.path.realpath(f"/sys/class/video4linux/{os.path.basename(dev)}/device")
    while path != "/" and not os.path.exists(os.path.join(path, "idVendor")):
        path = os.path.dirname(path)
    return None if path == "/" else path


def usb_attr(usb, name, default=""):
    try:
        with open(os.path.join(usb, name)) as f:
            return f.read().strip()
    except OSError:
        return default


def has_vendor_hid(dev=None):
    usb = usb_device(dev or find_video())
    return bool(usb) and (usb_attr(usb, "idVendor"), usb_attr(usb, "idProduct")) in HID_MODELS


def device_id():
    """Identidade da conexão USB (barramento-dispositivo): muda quando a câmera some e
    volta (desplugada, reiniciada, PC acordando), que é quando ela pode ter esquecido
    os ajustes."""
    dev = find_video()
    if not dev:
        return None
    path = os.path.realpath(f"/sys/class/video4linux/{os.path.basename(dev)}/device")
    while path != "/":
        try:
            with open(os.path.join(path, "busnum")) as b, open(os.path.join(path, "devnum")) as d:
                usb = f"{b.read().strip()}-{d.read().strip()}"
            # O nó /dev/video é recriado quando a câmera reinicializa mesmo sem trocar de
            # número USB: entra na identidade junto com a hora em que foi criado.
            return f"{usb}:{os.path.basename(dev)}:{int(os.stat(dev).st_ctime)}"
        except OSError:
            path = os.path.dirname(path)
    return None


def pipewire_node():
    """Nó PipeWire da câmera selecionada (o objeto do pw-dump), ou None."""
    raw = subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=10).stdout.strip()
    objs = json.JSONDecoder().raw_decode(raw)[0] if raw else []
    dev = find_video()
    return next((o for o in objs if ((o.get("info") or {}).get("props") or {}).get("api.v4l2.path") == dev
                 and ((o.get("info") or {}).get("props") or {}).get("media.class") == "Video/Source"), None)


def video_modes():
    """Modos MJPEG que a câmera selecionada anuncia (resolução e fps), pelo nó do PipeWire:
    é por ele que o preview e o blur abrem a câmera."""
    node = pipewire_node()
    if not node:
        return []
    txt = subprocess.run(["pw-cli", "enum-params", str(node["id"]), "EnumFormat"], capture_output=True, text=True, timeout=10).stdout
    return parse_enum_format(txt)


def parse_enum_format(txt):
    """Modos MJPEG de uma saída de `pw-cli enum-params <nó> EnumFormat`, do maior ao menor."""
    modes = {}
    for block in txt.split("Object: size")[1:]:
        if "MediaSubtype:mjpg" not in block:
            continue
        size = re.search(r"Rectangle (\d+)x(\d+)", block)
        if not size:
            continue
        w, h = int(size.group(1)), int(size.group(2))
        fps = {int(x) for x in re.findall(r"Fraction (\d+)/1", block)}
        modes.setdefault((w, h), set()).update(fps)
    return [{"width": w, "height": h, "fps": sorted(f, reverse=True)} for (w, h), f in sorted(modes.items(), key=lambda m: -m[0][0] * m[0][1])]


def card_name(dev):
    """Nome que o PipeWire/Chromium mostra: o do V4L2 até o ":" ("EMEET PIXY: EMEET PIXY")."""
    try:
        with open(f"/sys/class/video4linux/{os.path.basename(dev)}/name") as f:
            return f.read().split(":")[0].strip()
    except OSError:
        return ""


def usb_cameras():
    """Câmeras USB conectadas, uma por aparelho (o by-id index0), com o que identifica o
    modelo: vendor:product, nome, firmware (bcdDevice) e qual está selecionada."""
    current = find_video()
    out = []
    for by_id in by_id_cameras():
        dev = os.path.realpath(by_id)
        usb = usb_device(dev)
        if not usb:
            continue  # loopback, sem aparelho USB
        bcd = usb_attr(usb, "bcdDevice", "0000")
        out.append({
            "id": by_id,
            "name": usb_attr(usb, "product") or card_name(dev),
            "card": card_name(dev),
            "vendor": usb_attr(usb, "idVendor"),
            "product": usb_attr(usb, "idProduct"),
            "firmware": f"{int(bcd[:2], 16):x}.{bcd[2:]}" if len(bcd) == 4 else bcd,
            "device": dev,
            "vendor_hid": has_vendor_hid(dev),
            "selected": dev == current,
        })
    return out


def find_hidraw():
    """HID do fabricante da câmera SELECIONADA: só se ela for de um modelo com HID e o
    hidraw for do mesmo aparelho USB (nunca o de outra câmera conectada)."""
    dev = find_video()
    if not has_vendor_hid(dev):
        return None
    usb = usb_device(dev)
    for path in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        if os.path.realpath(os.path.join(path, "device")).startswith(usb + "/"):
            return "/dev/" + os.path.basename(path)
    return None


class Camera:
    def __init__(self):
        self.fd = None
        self.device = None
        self.by_name = {}

    def open(self):
        if self.fd is not None:
            return
        dev = find_video()
        if not dev:
            raise RuntimeError("PIXY não encontrada em /dev/v4l/by-id")
        # Sem stream: os controles funcionam mesmo com outro app capturando.
        self.fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK)
        self.device = dev
        self.list()

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
        self.fd = None
        self.by_name = {}  # os controles eram da câmera que fechou

    def list(self):
        # Do zero: depois de trocar de câmera, sobravam controles da anterior (pan da PIXY
        # na webcam do notebook) e cada leitura deles dava EINVAL.
        self.by_name = {}
        ctrls, qc = [], QueryCtrl(id=FLAG_NEXT_CTRL)
        while True:
            try:
                fcntl.ioctl(self.fd, VIDIOC_QUERYCTRL, qc)
            except OSError:
                break
            if not qc.flags & FLAG_DISABLED and qc.type in TYPES:
                c = {"name": snake(qc.name.decode()), "label": qc.name.decode(), "id": qc.id,
                     "type": TYPES[qc.type], "min": qc.minimum, "max": qc.maximum,
                     "step": qc.step, "default": qc.default_value,
                     "readonly": bool(qc.flags & FLAG_READ_ONLY),
                     "inactive": bool(qc.flags & FLAG_INACTIVE)}
                if qc.type == 3:
                    c["menu"] = self._menu(qc)
                try:
                    c["value"] = self._get(qc.id)
                except OSError:
                    c["value"] = None
                ctrls.append(c)
                self.by_name[c["name"]] = c
            qc = QueryCtrl(id=qc.id | FLAG_NEXT_CTRL)
        return ctrls

    def _menu(self, qc):
        items = []
        for i in range(qc.minimum, qc.maximum + 1):
            qm = QueryMenu(id=qc.id, index=i)
            try:
                fcntl.ioctl(self.fd, VIDIOC_QUERYMENU, qm)
                items.append({"value": i, "label": qm.name.decode(errors="replace")})
            except OSError:
                pass
        return items

    def _id(self, name):
        if name not in self.by_name:
            raise KeyError(f"controle desconhecido: {name}")
        return self.by_name[name]["id"]

    def _get(self, cid):
        c = Control(id=cid)
        fcntl.ioctl(self.fd, VIDIOC_G_CTRL, c)
        return c.value

    def get(self, name):
        return self._get(self._id(name))

    def set(self, name, value):
        c = Control(id=self._id(name), value=int(value))
        try:
            fcntl.ioctl(self.fd, VIDIOC_S_CTRL, c)
        except PermissionError:
            # EACCES no V4L2 = controle inativo (o automático dele está ligado) ou só leitura
            raise PermissionError(f"{name} está desativado na câmera (o automático correspondente está ligado)") from None
        return c.value


# --- HID -----------------------------------------------------------------------
REPORT_LEN = 32
HID_TIMEOUT = 0.5
# Grupos que o app nunca envia: energia, firmware/RTC, cartão SD; e os heads de
# factory reset e identidade do aparelho (mesma lista do PixyDeck).
FORBIDDEN_GROUPS = {0x00, 0x09, 0x0A}
FORBIDDEN_HEADS = {(0x09, 0x01, 0x00, 0x05), (0x09, 0x01, 0x00, 0x08),
                   (0x09, 0x01, 0x00, 0x0D), (0x09, 0x01, 0x00, 0x0F)}

SET_MODE, GET_MODE = (0x09, 0x01, 0x01, 0x00), (0x09, 0x01, 0x01, 0x01)
SET_PRIVACY_DELAY, GET_PRIVACY_DELAY = (0x09, 0x02, 0x01, 0x00), (0x09, 0x02, 0x01, 0x01)
GET_MOTOR_POS = (0x09, 0x03, 0x01, 0x01)    # [eixo] -> [eixo][alvo:f32][real:f32]
SET_MOTOR_SPEED = (0x09, 0x03, 0x01, 0x02)  # [eixo][graus/s:f32]
GET_MOTOR_SPEED = (0x09, 0x03, 0x01, 0x03)  # [eixo] -> [eixo][graus/s:f32][limite:f32]
GET_FEATURE, SET_FEATURE = (0x09, 0x04, 0x00, 0x07), (0x09, 0x04, 0x00, 0x08)
SET_TARGET, GET_TARGET = (0x09, 0x04, 0x01, 0x00), (0x09, 0x04, 0x01, 0x01)
SET_GESTURE, GET_GESTURE = (0x09, 0x04, 0x02, 0x00), (0x09, 0x04, 0x02, 0x01)
SET_AUDIO, GET_AUDIO = (0x09, 0x05, 0x00, 0x03), (0x09, 0x05, 0x00, 0x04)

# 03 é o que a câmera reporta quando o modo pedido é tracking mas nenhum app
# está com o stream aberto: ela só segue alguém enquanto transmite.
MODES = {"standard": 0x00, "tracking": 0x01, "privacy": 0x02}
MODE_NAMES = {0x00: "standard", 0x01: "tracking", 0x02: "privacy", 0x03: "standby"}
TARGETS = {"auto": 0x00, "face": 0x01, "upper-body": 0x02}  # 03 (corpo todo) o firmware recusa
AUDIO = {"nc": 0x01, "live": 0x02, "original": 0x03}
FEATURES = {"hflip": 0x01, "vflip": 0x02, "autorotate": 0x04}
GESTURE_TYPE = 0x02
AXES = {"pan": 0x01, "tilt": 0x02}
SPEED_MIN, SPEED_MAX = 1.0, 240.0


def frame(head, body=()):
    """Relatório V2: head de 4 bytes, `00 len 00 len` e o payload. Head sozinho é consulta."""
    body = list(body)
    return list(head) + ([0, len(body), 0, len(body)] + body if body else [])


def check_report(data):
    data = bytes(data)
    if len(data) > REPORT_LEN:
        raise ValueError("relatório HID maior que 32 bytes")
    head = (data[0], data[1] & 0x1F, data[2], data[3]) if len(data) >= 4 else None
    if data[0] != 0x09 or not head or head[1] in FORBIDDEN_GROUPS or head in FORBIDDEN_HEADS:
        raise PermissionError(f"comando HID recusado: {data[:4].hex(' ')}")
    return data.ljust(REPORT_LEN, b"\0")


class Hid:
    def __init__(self):
        self.fd = None

    def open(self):
        if self.fd is not None:
            return
        dev = find_hidraw()
        if not dev:
            raise RuntimeError("a câmera selecionada não tem os controles do fabricante (HID)")
        try:
            self.fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK)
        except PermissionError:
            raise PermissionError(f"sem permissão em {dev}: instale udev/70-emeet-pixy.rules") from None

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
        self.fd = None

    def _drain(self):
        # A câmera também empurra relatórios de estado sem ser perguntada.
        for _ in range(64):
            if not select.select([self.fd], [], [], 0)[0]:
                return
            try:
                if not os.read(self.fd, 64):
                    return
            except BlockingIOError:
                return

    def send(self, data):
        self.open()
        try:
            os.write(self.fd, check_report(data))
        except OSError:
            self.close()
            raise

    def query(self, data, timeout=HID_TIMEOUT):
        """Envia e devolve o payload (offset 8) da resposta com o mesmo head."""
        self.open()
        self._drain()
        self.send(data)
        deadline = time.monotonic() + timeout
        while (left := deadline - time.monotonic()) > 0:
            if not select.select([self.fd], [], [], left)[0]:
                break
            try:
                reply = os.read(self.fd, 64)
            except BlockingIOError:
                continue
            if len(reply) >= 9 and reply[1] & 0x1F == data[1] & 0x1F and reply[2:4] == bytes(data[2:4]):
                return reply[8:8 + min(reply[5], len(reply) - 8)]
        return None

    def raw(self, frames, read_ms=150):
        """Só para o CLI: envia e coleta tudo o que chegar."""
        self.open()
        replies = []
        for data in frames:
            self.send(data)
            while select.select([self.fd], [], [], read_ms / 1000)[0]:
                try:
                    replies.append(os.read(self.fd, 64).hex(" "))
                except BlockingIOError:
                    break
        return replies


def _name(table, value):
    return next((k for k, v in table.items() if v == value), None)


# --- Estado da câmera -----------------------------------------------------------
cam, hid = Camera(), Hid()


def hid_state():
    s = {}
    p = hid.query(GET_MODE)
    s["mode"] = MODE_NAMES.get(p[0]) if p else None
    p = hid.query(GET_TARGET)
    s["target"] = _name(TARGETS, p[0]) if p else None
    p = hid.query(frame(GET_GESTURE, [GESTURE_TYPE]))
    s["gesture"] = bool(p[1]) if p and len(p) > 1 else None
    p = hid.query(GET_AUDIO)
    s["audio"] = _name(AUDIO, p[0]) if p else None
    p = hid.query(GET_PRIVACY_DELAY)
    s["privacy_delay"] = struct.unpack_from("<I", p)[0] if p and len(p) >= 4 else None
    for name, code in FEATURES.items():
        p = hid.query(frame(GET_FEATURE, [code]))
        s[name] = bool(p[1]) if p and len(p) > 1 else None
    p = hid.query(frame(GET_MOTOR_SPEED, [AXES["pan"]]))
    s["speed"] = round(struct.unpack_from("<f", p, 1)[0]) if p and len(p) >= 5 else None
    return s


def set_and_read(set_frame, get_frame):
    hid.send(set_frame)
    time.sleep(0.2)  # a câmera precisa desse intervalo entre o set e a leitura
    return hid.query(get_frame)


def position(axis):
    """Posição em graus: o motor da PIXY pelo HID, ou o controle UVC absoluto (arcseg)."""
    if has_vendor_hid():
        return motor_pos(axis)
    name = f"{axis}_absolute"
    return cam.get(name) / ARCSEC if name in cam.by_name else None


def motor_pos(axis):
    p = hid.query(frame(GET_MOTOR_POS, [AXES[axis]]))
    if not p or len(p) < 9:
        return None
    return struct.unpack_from("<f", p, 5)[0]  # posição real, em graus


def set_speed(speed):
    speed = min(max(float(speed), SPEED_MIN), SPEED_MAX)
    for code in AXES.values():
        hid.send(frame(SET_MOTOR_SPEED, [code, *struct.pack("<f", speed)]))
    return speed


# --- Joystick ---------------------------------------------------------------------
class Jog:
    """Movimento contínuo: o motor recebe como alvo o limite do eixo e a velocidade
    proporcional à deflexão; ao soltar, o alvo vira a posição real (com uma pequena
    antecipação para não voltar depois da frenagem). Sem comando por WATCHDOG
    segundos, para sozinho — se o app travar, a câmera não sai girando até o limite."""
    WATCHDOG = 0.4
    LEAD = 0.06  # segundos de antecipação na parada

    def __init__(self):
        self.base_speed = 60.0
        self.axes = {"pan": {"dir": 0, "speed": 0.0}, "tilt": {"dir": 0, "speed": 0.0}}
        self.last = 0.0
        self.generic_pos = {}

    @property
    def moving(self):
        return any(a["dir"] for a in self.axes.values())

    def update(self, pan, tilt, max_speed):
        now = time.monotonic()
        if not has_vendor_hid():
            return self._generic(now, pan, tilt, max_speed)
        self.last = now
        for axis, v in (("pan", pan), ("tilt", tilt)):
            v = max(-1.0, min(1.0, float(v)))
            if abs(v) < 0.05:
                self._stop(axis)
            else:
                self._drive(axis, v, max_speed)

    def _drive(self, axis, v, max_speed):
        st = self.axes[axis]
        # Curva quadrática: precisão perto do centro, velocidade nas bordas.
        speed = max(SPEED_MIN, (v * v) * max_speed)
        if abs(speed - st["speed"]) >= 1.5:
            hid.send(frame(SET_MOTOR_SPEED, [AXES[axis], *struct.pack("<f", speed)]))
            st["speed"] = speed
        direction = 1 if v > 0 else -1
        if direction != st["dir"]:
            lo, hi = (-PAN_LIMIT, PAN_LIMIT) if axis == "pan" else (TILT_MIN, TILT_MAX)
            cam.set(f"{axis}_absolute", (hi if direction > 0 else lo) * ARCSEC)
            st["dir"] = direction

    def _stop(self, axis):
        st = self.axes[axis]
        if not st["dir"]:
            return
        pos = motor_pos(axis)
        if pos is not None:
            lo, hi = (-PAN_LIMIT, PAN_LIMIT) if axis == "pan" else (TILT_MIN, TILT_MAX)
            target = min(max(pos + st["dir"] * st["speed"] * self.LEAD, lo), hi)
            cam.set(f"{axis}_absolute", round(target) * ARCSEC)
        hid.send(frame(SET_MOTOR_SPEED, [AXES[axis], *struct.pack("<f", self.base_speed)]))
        st.update(dir=0, speed=0.0)

    def _generic(self, now, pan, tilt, max_speed):
        """Câmera sem o motor da PIXY: anda por posição absoluta UVC (pan/tilt_absolute,
        em segundos de arco), em passos proporcionais ao tempo desde o comando anterior."""
        dt = min(now - self.last, 0.2) if self.last else 0.05
        self.last = now
        for axis, v in (("pan", pan), ("tilt", tilt)):
            name = f"{axis}_absolute"
            c = cam.by_name.get(name)
            v = max(-1.0, min(1.0, float(v)))
            if not c or abs(v) < 0.05:
                self.generic_pos.pop(axis, None)
                continue
            pos = self.generic_pos.get(axis)
            if pos is None:
                pos = cam.get(name)
            pos += (1 if v > 0 else -1) * v * v * max_speed * ARCSEC * dt
            pos = max(c["min"], min(c["max"], pos))
            self.generic_pos[axis] = pos
            step = c["step"] or 1
            cam.set(name, int(round(pos / step) * step))

    def stop(self):
        self.generic_pos.clear()
        if not has_vendor_hid():
            return
        for axis in self.axes:
            self._stop(axis)

    def tick(self):
        if self.moving and has_vendor_hid() and time.monotonic() - self.last > self.WATCHDOG:
            self.stop()


jog = Jog()


def video_holders():
    """Processos com a PIXY aberta, fora o próprio helper e o PipeWire (que divide o stream)."""
    dev = find_video()
    out = []
    if not dev:
        return out
    for pid in filter(str.isdigit, os.listdir("/proc")):
        if int(pid) == os.getpid():
            continue
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
            if not any(os.path.realpath(f"/proc/{pid}/fd/{fd}") == dev for fd in fds):
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
            name = os.path.basename(cmd.split(" ", 1)[0])
            if name in ("pipewire", "wireplumber") or "pixyd.py" in cmd:
                continue
            ppid = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1]
            with open(f"/proc/{ppid}/cmdline", "rb") as f:
                parent = f.read().replace(b"\0", b" ").decode(errors="replace")
            remote = "tailscaled" in parent or "sshd" in parent
            out.append({"pid": int(pid), "name": name, "remote": remote})
        except OSError:
            continue
    return out


def diagnose():
    """O que o app precisa do sistema, item a item: {"id", "ok", "detail"}. Roda no início
    para a interface dizer o que falta em vez de falhar em silêncio."""
    import shutil
    out = []

    def item(key, ok, detail=""):
        out.append({"id": key, "ok": bool(ok), "detail": detail})

    for tool in ("ffmpeg", "pw-dump", "pw-cli", "gsettings", "gst-launch-1.0"):
        item(tool, shutil.which(tool), "" if shutil.which(tool) else "não encontrado no PATH")

    video, hid_dev = find_video(), find_hidraw()
    item("camera", video, video or "câmera não conectada")
    if video and not has_vendor_hid(video):
        item("hid", True)  # câmera sem o HID do fabricante: nada a configurar
    elif hid_dev:
        item("hid", os.access(hid_dev, os.R_OK | os.W_OK), "" if os.access(hid_dev, os.R_OK | os.W_OK) else f"sem permissão em {hid_dev} (regra udev)")
    else:
        item("hid", not video, "" if not video else "HID da câmera não apareceu")

    virtual = None
    for d in glob.glob("/sys/class/video4linux/video*"):
        try:
            if open(f"{d}/name").read().strip() == "EMEET PIXY (virtual)":
                virtual = "/dev/" + os.path.basename(d)
        except OSError:
            pass
    item("v4l2loopback", virtual, virtual or 'device "EMEET PIXY (virtual)" não existe')

    rule = os.path.expanduser("~/.config/wireplumber/main.lua.d/52-portal-camera-host-apps.lua")
    item("wireplumber", os.path.exists(rule), "" if os.path.exists(rule) else "regra da câmera pelo portal não instalada")
    return out


# --- Protocolo ----------------------------------------------------------------------
def handle(req):
    op = req.get("op")
    if op == "status":
        return {"video": find_video(), "hid": find_hidraw(), "device": device_id(), "vendor_hid": has_vendor_hid()}
    if op == "select":
        global selected
        selected = req.get("camera") or None  # não "id": esse é o número da requisição
        reset_on_error()  # fecha os devices da câmera anterior
        return {"video": find_video(), "hid": find_hidraw(), "device": device_id(), "vendor_hid": has_vendor_hid()}
    if op == "cameras":
        return {"cameras": usb_cameras()}
    if op == "diagnose":
        return {"items": diagnose()}
    if op == "node":
        node = pipewire_node()
        return {"node": node["info"]["props"]["node.name"] if node else None}
    if op == "modes":
        return {"modes": video_modes()}
    if op == "reopen":
        reset_on_error()
        return {}
    if op == "holders":
        return {"holders": video_holders()}
    if op == "list":
        cam.open()
        return {"device": cam.device, "controls": cam.list()}
    if op == "set":
        cam.open()
        return {"value": cam.set(req["name"], req["value"])}
    if op == "state":
        return hid_state()
    if op == "mode":
        if "value" not in req:
            p = hid.query(GET_MODE)
        else:
            p = set_and_read(frame(SET_MODE, [MODES[req["value"]]]), GET_MODE)
        return {"mode": MODE_NAMES.get(p[0]) if p else None}
    if op == "target":
        hid.send(frame(SET_TARGET, [TARGETS[req["value"]], *bytes(20)]))
        p = hid.query(GET_TARGET)
        return {"target": _name(TARGETS, p[0]) if p else None}
    if op == "gesture":
        p = set_and_read(frame(SET_GESTURE, [GESTURE_TYPE, int(bool(req["value"]))]),
                         frame(GET_GESTURE, [GESTURE_TYPE]))
        return {"gesture": bool(p[1]) if p and len(p) > 1 else None}
    if op == "feature":
        code = FEATURES[req["name"]]
        p = set_and_read(frame(SET_FEATURE, [code, int(bool(req["value"]))]), frame(GET_FEATURE, [code]))
        return {req["name"]: bool(p[1]) if p and len(p) > 1 else None}
    if op == "audio":
        p = set_and_read(frame(SET_AUDIO, [AUDIO[req["value"]]]), GET_AUDIO)
        return {"audio": _name(AUDIO, p[0]) if p else None}
    if op == "privacy_delay":
        seconds = max(0, min(int(req["value"]), 3600))
        p = set_and_read(frame(SET_PRIVACY_DELAY, list(struct.pack("<I", seconds))), GET_PRIVACY_DELAY)
        return {"privacy_delay": struct.unpack_from("<I", p)[0] if p and len(p) >= 4 else None}
    if op == "speed":
        if not has_vendor_hid():
            jog.base_speed = float(req["value"])
            return {"speed": round(jog.base_speed)}
        jog.base_speed = set_speed(req["value"])
        return {"speed": round(jog.base_speed)}
    if op == "jog":
        cam.open()
        jog.update(req.get("pan", 0), req.get("tilt", 0), float(req.get("max_speed", jog.base_speed)))
        return {}
    if op == "stop":
        cam.open()
        jog.stop()
        return {"pan": position("pan"), "tilt": position("tilt")}
    if op == "position":
        cam.open()
        zoom = cam.get("zoom_absolute") if "zoom_absolute" in cam.by_name else None
        return {"pan": position("pan"), "tilt": position("tilt"), "zoom": zoom}
    if op == "goto":
        cam.open()
        jog.stop()
        for name in ("pan", "tilt", "zoom"):
            ctrl = "zoom_absolute" if name == "zoom" else f"{name}_absolute"
            if req.get(name) is None or ctrl not in cam.by_name:
                continue  # câmera sem esse eixo
            cam.set(ctrl, req[name] if name == "zoom" else round(float(req[name])) * ARCSEC)
        return {}
    raise ValueError(f"op desconhecida: {op}")


def reset_on_error():
    # Câmera desplugada ou reenumerada: reabre tudo na próxima chamada.
    cam.close()
    hid.close()
    for st in jog.axes.values():
        st.update(dir=0, speed=0.0)


def response(req, data):
    """Resposta ao app: o id da requisição sempre vence um campo "id" que o dado traga
    (um "id" no status já sobrescreveu o da requisição e travou o app esperando)."""
    return {**data, "id": req.get("id"), "ok": True}


def serve():
    buf = b""
    stdin = sys.stdin.buffer.raw
    while True:
        ready = select.select([stdin], [], [], 0.1)[0]
        try:
            jog.tick()
        except Exception:  # noqa: BLE001
            reset_on_error()
        if not ready:
            continue
        chunk = os.read(stdin.fileno(), 65536)
        if not chunk:
            try:
                jog.stop()
            except Exception:  # noqa: BLE001
                pass
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            req = {}
            try:
                req = json.loads(line)
                res = response(req, handle(req))
            except Exception as e:  # noqa: BLE001 — o erro volta para o app e o servidor segue vivo
                if isinstance(e, OSError):
                    reset_on_error()
                res = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}
            try:
                sys.stdout.write(json.dumps(res) + "\n")
                sys.stdout.flush()
            except BrokenPipeError:  # o app fechou no meio da resposta
                return


def cli(args):
    if args[0] == "list":
        for c in handle({"op": "list"})["controls"]:
            print(f'{c["name"]:32} {c["type"]:5} {c["min"]}..{c["max"]} step {c["step"]} '
                  f'def {c["default"]} = {c["value"]}' + (" (inactive)" if c["inactive"] else ""))
    elif args[0] == "set":
        print(handle({"op": "set", "name": args[1], "value": int(args[2])}))
    elif args[0] == "hid":
        print(hid.raw([[int(b, 16) for b in f.split()] for f in args[1:]]))
    else:
        req = {"op": args[0]}
        if len(args) > 1:
            req["value"] = args[1]
        print(handle(req))


if __name__ == "__main__":
    cli(sys.argv[1:]) if len(sys.argv) > 1 else serve()
