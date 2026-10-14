// Câmera virtual: lê a PIXY pelo PipeWire (sem travar o device) e manda os quadros, em
// I420, para o processo principal escrever no v4l2loopback via ffmpeg. Com o efeito
// ligado, recorta a pessoa com o selfie segmenter do MediaPipe e desfoca o fundo; com
// ele desligado, só repassa a imagem. A troca é ao vivo, sem reabrir nada.
import { FilesetResolver, ImageSegmenter } from "../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";

// Qualidade escolhida no app, passada na URL quando a janela abre (trocar reabre ela):
// cw x ch @ fps é o modo pedido à câmera; W x H é a saída da câmera virtual.
const q = new URLSearchParams(location.search);
const CW = Number(q.get("cw")) || 1280;
const CH = Number(q.get("ch")) || 720;
const FPS = Number(q.get("fps")) || 30;
const W = Number(q.get("w")) || 1280;
const H = Number(q.get("h")) || 720;
// O modelo trabalha em 256x256 por dentro: entregar mais que isso só encarece a leitura
// da máscara. Ela é esticada para a saída com suavização, o que já dá borda macia.
const MW = 256;
const MH = 144;
const PREVIEW_W = 640; // cópia reduzida para o preview do app, só enquanto ele está aberto
const PREVIEW_H = Math.round((640 * H) / W / 2) * 2;

// Ajustáveis pela janela principal, ao vivo.
let blurPx = 18;
let edge = 0.55; // centro do recorte: maior = recorta mais justo, menor = leva mais do entorno
let previewOn = false;
let effect = true;
// Modo privacidade: a câmera física manda preto; aqui a saída vira uma imagem escolhida
// (ou um cartão padrão). Os quadros pretos continuam chegando e servem de relógio.
let privacy = false;
let privacyImage = null; // ImageBitmap da imagem escolhida; null = cartão padrão
function applyConfig(c) {
  if (c.effect != null) effect = Boolean(c.effect);
  if (c.privacy != null) privacy = Boolean(c.privacy);
  if (c.privacyImage !== undefined) {
    privacyImage = null;
    if (c.privacyImage) {
      createImageBitmap(new Blob([c.privacyImage]))
        .then((bmp) => (privacyImage = bmp))
        .catch((e) => console.warn(`imagem da privacidade inválida: ${e.message}`));
    }
  }
  if (c.blur != null) blurPx = Math.max(2, Math.min(60, Number(c.blur)));
  if (c.edge != null) edge = Math.max(0.2, Math.min(0.85, Number(c.edge)));
  if (c.preview != null) previewOn = Boolean(c.preview);
}
window.pixyBlur.onConfig(applyConfig);

const out = new OffscreenCanvas(W, H);
const outCtx = out.getContext("2d");
const person = new OffscreenCanvas(W, H);
const personCtx = person.getContext("2d");
const small = new OffscreenCanvas(MW, MH);
const smallCtx = small.getContext("2d", { willReadFrequently: false });
const mask = new OffscreenCanvas(MW, MH);
const maskCtx = mask.getContext("2d");
const maskImage = new ImageData(MW, MH);
const preview = new OffscreenCanvas(PREVIEW_W, PREVIEW_H);
const previewCtx = preview.getContext("2d");
let previewBusy = false;

// JPEG pequeno a cada quadro (pulando quando o anterior ainda não saiu): barato no IPC.
async function sendPreview() {
  if (!previewOn || previewBusy) return; // um JPEG por vez; se o anterior não saiu, pula
  previewBusy = true;
  try {
    previewCtx.drawImage(out, 0, 0, PREVIEW_W, PREVIEW_H);
    const blob = await preview.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    window.pixyBlur.preview(await blob.arrayBuffer());
  } finally {
    previewBusy = false;
  }
}

// Converte o quadro final para I420 (YUV 4:2:0, BT.601 faixa limitada, o mesmo do
// ffmpeg) na GPU e lê já no formato que o v4l2loopback recebe: 1,38 MB por quadro em
// vez de 3,6 MB de RGBA, e o ffmpeg não precisa converter nada na CPU.
// Layout: textura RGBA de (W/4) x (H*1.5); cada texel são 4 bytes seguidos do buffer
// I420 — linhas 0..H-1 o plano Y, depois U (H/4 linhas) e V (H/4 linhas).
class I420Reader {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.canvas = new OffscreenCanvas(w / 4, (h * 3) / 2);
    const gl = (this.gl = this.canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false }));
    if (!gl) throw new Error("sem WebGL2");
    const vs = `#version 300 es
      in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
    const fs = `#version 300 es
      precision highp float;
      uniform sampler2D src;
      uniform int W; uniform int H;
      out vec4 o;
      float luma(ivec2 c) { vec3 v = texelFetch(src, c, 0).rgb; return 0.0625 + dot(v, vec3(0.257, 0.504, 0.098)); }
      vec3 avg(ivec2 c) {
        return 0.25 * (texelFetch(src, c, 0).rgb + texelFetch(src, c + ivec2(1, 0), 0).rgb
                     + texelFetch(src, c + ivec2(0, 1), 0).rgb + texelFetch(src, c + ivec2(1, 1), 0).rgb);
      }
      float chroma(int idx, bool isU) {
        int cw = W / 2;
        ivec2 c = ivec2((idx % cw) * 2, (idx / cw) * 2);
        vec3 v = avg(c);
        return 0.5 + (isU ? dot(v, vec3(-0.148, -0.291, 0.439)) : dot(v, vec3(0.439, -0.368, -0.071)));
      }
      void main() {
        int x = int(gl_FragCoord.x), r = int(gl_FragCoord.y);
        int rowBytes = W;           // cada linha da textura = W bytes (W/4 texels)
        vec4 b;
        if (r < H) {
          for (int i = 0; i < 4; i++) b[i] = luma(ivec2(4 * x + i, r));
        } else {
          int qr = H / 4;           // linhas da textura por plano de croma
          bool isU = r < H + qr;
          int base = (r - H - (isU ? 0 : qr)) * rowBytes + 4 * x;
          for (int i = 0; i < 4; i++) b[i] = chroma(base + i, isU);
        }
        o = b;
      }`;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(prog, "W"), w);
    gl.uniform1i(gl.getUniformLocation(prog, "H"), h);
    gl.uniform1i(gl.getUniformLocation(prog, "src"), 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.viewport(0, 0, w / 4, (h * 3) / 2);
    this.out = new Uint8Array((w * h * 3) / 2);
    // Leitura assíncrona: o quadro vai para um buffer da GPU com uma cerca, e é recolhido
    // no ciclo seguinte, já pronto. Assim a CPU não fica parada esperando a GPU terminar
    // (era ~10 ms por quadro). Custa um quadro de atraso.
    this.pbos = [gl.createBuffer(), gl.createBuffer()];
    for (const b of this.pbos) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.out.byteLength, gl.STREAM_READ);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pending = null; // { pbo, fence }
    this.turn = 0;
  }

  // Envia o quadro atual para a GPU e devolve o anterior (ou null no primeiro).
  read(source) {
    const gl = this.gl;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const pbo = this.pbos[this.turn++ % 2];
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, this.w / 4, (this.h * 3) / 2, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const prev = this.pending;
    this.pending = { pbo, fence };
    if (!prev) return null;
    // O anterior teve um quadro inteiro (~33 ms) para ficar pronto; se ainda não ficou,
    // espera só o que falta.
    gl.clientWaitSync(prev.fence, 0, 0);
    gl.deleteSync(prev.fence);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prev.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return this.out;
  }
}

const CARD = q.get("card") || "EMEET PIXY"; // nome da câmera selecionada no app

// Escolhe a câmera pelo nome que o Chromium mostra ("<nome> (V4L2)"). Câmeras com dois
// sensores de mesmo nome (webcams de notebook: o comum e o infravermelho) ficam com o de
// maior resolução, que é o comum.
async function pickCamera(list) {
  const matches = list.filter((d) => d.kind === "videoinput" && d.label.startsWith(CARD) && !/remota|blur|virtual/i.test(d.label));
  if (matches.length < 2) return matches[0];
  const width = (d) => {
    const cap = typeof d.getCapabilities === "function" ? d.getCapabilities() : null;
    return (cap && cap.width && cap.width.max) || 0;
  };
  return matches.sort((a, b) => width(b) - width(a))[0];
}

async function findCamera() {
  let dev = await pickCamera(await navigator.mediaDevices.enumerateDevices());
  if (!dev) {
    // Rótulos só aparecem depois de uma permissão concedida. A sondagem já pede 720p:
    // se a câmera padrão for a selecionada, o formato aberto aqui é reaproveitado.
    const probe = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: CW }, height: { ideal: CH } } });
    probe.getTracks().forEach((t) => t.stop());
    dev = await pickCamera(await navigator.mediaDevices.enumerateDevices());
  }
  if (!dev) throw new Error(`${CARD} não aparece na lista de câmeras`);
  return dev;
}

async function openCamera() {
  const dev = await findCamera();
  return navigator.mediaDevices.getUserMedia({
    // Modo nativo exato, sem recorte nem redimensionamento: com "ideal" + fps o Chromium
    // escolhia o 1280x960 da PIXY e recortava, e esse modo só rende ~20 fps.
    video: {
      deviceId: { exact: dev.deviceId },
      width: { exact: CW },
      height: { exact: CH },
      frameRate: { ideal: FPS, max: FPS },
      resizeMode: "none",
    },
  });
}

async function createSegmenter() {
  const fileset = await FilesetResolver.forVisionTasks("../node_modules/@mediapipe/tasks-vision/wasm");
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: "../assets/selfie_segmenter.tflite", delegate },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    return await ImageSegmenter.createFromOptions(fileset, options("GPU"));
  } catch {
    // Sem WebGL (driver da GPU fora de sincronia, por exemplo): mais lento, mas funciona.
    return ImageSegmenter.createFromOptions(fileset, options("CPU"));
  }
}

function updateMask(confidence) {
  const px = maskImage.data;
  for (let i = 0, j = 3; i < confidence.length; i++, j += 4) {
    // smoothstep numa faixa de 0.4 em volta do recorte: corta o ruído do fundo sem
    // serrilhar o contorno
    const t = Math.min(1, Math.max(0, (confidence[i] - (edge - 0.2)) / 0.4));
    px[j] = 255 * t * t * (3 - 2 * t);
  }
  maskCtx.putImageData(maskImage, 0, 0);
}

// Cartão padrão da privacidade: escuro, com o aviso centralizado.
function drawPrivacyCard() {
  outCtx.fillStyle = "#15171c";
  outCtx.fillRect(0, 0, W, H);
  const k = H / 720;
  outCtx.fillStyle = "#2a2e36";
  outCtx.beginPath();
  outCtx.arc(W / 2, H / 2 - 50 * k, 70 * k, 0, Math.PI * 2);
  outCtx.fill();
  outCtx.fillStyle = "#ef5f5f";
  outCtx.fillRect(W / 2 - 55 * k, H / 2 - 55 * k, 110 * k, 10 * k); // risco sobre a "lente"
  outCtx.fillStyle = "#e6e8eb";
  outCtx.font = `600 ${Math.round(40 * k)}px system-ui, sans-serif`;
  outCtx.textAlign = "center";
  outCtx.fillText("Câmera em pausa", W / 2, H / 2 + 80 * k);
}

// Imagem escolhida, cobrindo a saída inteira sem distorcer (corta as sobras).
function drawPrivacyImage() {
  const img = privacyImage;
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  outCtx.fillStyle = "#000";
  outCtx.fillRect(0, 0, W, H);
  outCtx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function composite(src) {
  outCtx.filter = `blur(${blurPx}px)`;
  // Desenha um pouco maior para o blur não escurecer as bordas do quadro.
  outCtx.drawImage(src, -blurPx, -blurPx, W + 2 * blurPx, H + 2 * blurPx);
  outCtx.filter = "none";
  personCtx.globalCompositeOperation = "copy";
  personCtx.drawImage(src, 0, 0, W, H);
  personCtx.globalCompositeOperation = "destination-in";
  personCtx.imageSmoothingQuality = "high";
  personCtx.drawImage(mask, 0, 0, W, H);
  outCtx.drawImage(person, 0, 0);
}

async function main() {
  applyConfig(await window.pixyBlur.getConfig());
  const [stream, segmenter] = await Promise.all([
    openCamera().then((s) => (console.warn("blur: câmera aberta"), s)),
    createSegmenter().then((s) => (console.warn("blur: segmentador pronto"), s)),
  ]);
  // Quadros direto do track, sem passar pela renderização: a janela do blur é oculta e
  // o Chromium espaça os callbacks de vídeo de janelas que não aparecem (chegou a 1 fps).
  // maxBufferSize 1: se o processamento atrasar, pega sempre o quadro mais novo.
  const track = stream.getVideoTracks()[0];
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  // Device aberto direto por outro processo: o PipeWire não consegue iniciar e nenhum
  // quadro chega. Avisa em vez de ficar parado em "Iniciando…".
  let first = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 8000))]);
  if (!first) {
    window.pixyBlur.status({ running: false, noFrames: true });
    first = await reader.read();
  }
  window.pixyBlur.status({ running: true, label: track.label });

  const i420 = new I420Reader(W, H);
  let segTick = 0;
  let frames = 0;
  let srcFrames = 0;
  let last = performance.now();
  let lastTotal = track.stats ? track.stats.totalFrames : null;
  const t = { seg: 0, comp: 0, read: 0, send: 0 };
  let next = first;
  while (!next.done) {
    const frame = next.value;
    srcFrames++;
    try {
      let t0 = performance.now();
      // Recorte a cada dois quadros: a silhueta quase não muda em 33 ms e a inferência
      // é a etapa mais cara; no quadro do meio a máscara anterior é reaproveitada.
      if (!privacy && effect && segTick++ % 2 === 0) {
        smallCtx.drawImage(frame, 0, 0, MW, MH);
        segmenter.segmentForVideo(small, performance.now(), (result) => {
          const m = result.confidenceMasks && result.confidenceMasks[0];
          if (m) updateMask(m.getAsFloat32Array());
        });
      }
      let t1 = performance.now(); t.seg += t1 - t0; t0 = t1;
      if (privacy) privacyImage ? drawPrivacyImage() : drawPrivacyCard();
      else if (effect) composite(frame);
      else outCtx.drawImage(frame, 0, 0, W, H); // sem efeito: só ajusta ao tamanho de saída
      t1 = performance.now(); t.comp += t1 - t0; t0 = t1;
      const yuv = i420.read(out);
      t1 = performance.now(); t.read += t1 - t0; t0 = t1;
      if (yuv) window.pixyBlur.frame(yuv);
      sendPreview();
      t.send += performance.now() - t0;
      frames++;
    } finally {
      frame.close(); // VideoFrame segura memória da GPU até ser fechado
    }
    const now = performance.now();
    if (now - last >= 5000) {
      const secs = (now - last) / 1000;
      const ms = (v) => Math.round((v / Math.max(frames, 1)) * 10) / 10;
      const st = track.getSettings();
      // Total de quadros que a câmera entregou ao track (inclui os descartados por atraso).
      const total = track.stats ? track.stats.totalFrames : null;
      const camFps = total != null && lastTotal != null ? Math.round((total - lastTotal) / secs) : null;
      lastTotal = total;
      window.pixyBlur.status({
        running: true,
        fps: Math.round(frames / secs),
        srcFps: camFps ?? Math.round(srcFrames / secs),
        src: `${st.width}x${st.height}@${st.frameRate}`,
        ms: { seg: ms(t.seg), comp: ms(t.comp), read: ms(t.read), send: ms(t.send) },
      });
      frames = 0;
      srcFrames = 0;
      last = now;
      Object.keys(t).forEach((k) => (t[k] = 0));
    }
    next = await reader.read();
  }
  window.pixyBlur.status({ running: false, error: "A câmera parou de mandar imagem." });
}

main().catch((e) => window.pixyBlur.status({ running: false, error: String(e.message || e) }));
