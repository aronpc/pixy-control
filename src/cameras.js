// Classifica as câmeras conectadas contra a lista de homologadas (cameras.json).
const { homologadas } = require("./cameras.json");

function classify(cameras, list = homologadas) {
  return cameras.map((c) => {
    const h = list.find((m) => m.vendor === c.vendor && m.product === c.product);
    const status = !h ? "nao-suportada" : h.firmwares.includes(c.firmware) ? "homologada" : "firmware-nao-testado";
    return { ...c, status, homologada: h ? { nome: h.nome, firmwares: h.firmwares, testado_em: h.testado_em, recursos: h.recursos } : null };
  });
}

module.exports = { classify, homologadas };
