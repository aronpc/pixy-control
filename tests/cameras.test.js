// Homologação: modelo + firmware testados, modelo com firmware novo, modelo desconhecido.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classify } = require("../src/cameras");

const pixy = { name: "EMEET PIXY", vendor: "328f", product: "00c0", firmware: "20.04" };

test("PIXY no firmware testado é homologada", () => {
  const [c] = classify([pixy]);
  assert.equal(c.status, "homologada");
  assert.equal(c.homologada.nome, "EMEET PIXY");
});

test("PIXY em firmware não testado", () => {
  assert.equal(classify([{ ...pixy, firmware: "21.01" }])[0].status, "firmware-nao-testado");
});

test("outra câmera não é suportada", () => {
  const [c] = classify([{ name: "Integrated_Webcam_HD", vendor: "0bda", product: "554b", firmware: "14.12" }]);
  assert.equal(c.status, "nao-suportada");
  assert.equal(c.homologada, null);
});
