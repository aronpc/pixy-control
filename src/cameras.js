// Classifica as câmeras conectadas contra a lista de homologadas (cameras.json).
const { homologadas } = require("./cameras.json");

function classify(cameras, list = homologadas) {
  return cameras.map((c) => {
    const h = list.find((m) => m.vendor === c.vendor && m.product === c.product);
    const status = !h ? "nao-suportada" : h.firmwares.includes(c.firmware) ? "homologada" : "firmware-nao-testado";
    return { ...c, status, homologada: h ? { nome: h.nome, firmwares: h.firmwares, testado_em: h.testado_em, recursos: h.recursos, limitacoes: h.limitacoes || [] } : null };
  });
}

// Recursos que o modelo desativa no modo de vídeo atual: { zoom: "motivo" }.
function limits(homologada, video) {
  const out = {};
  if (!homologada || !video) return out;
  const mode = `${video.width}x${video.height}@${video.fps}`;
  for (const l of homologada.limitacoes || []) {
    if (l.modo === mode) for (const r of l.desativa) out[r] = l.motivo;
  }
  return out;
}

module.exports = { classify, limits, homologadas };
