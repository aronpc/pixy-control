// Atalhos: a forma canônica que detecta conflito e o texto mostrado na tela e no tray.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalize, label } = require("../src/shortcuts");

test("Primary e Control são a mesma tecla, em qualquer ordem", () => {
  assert.equal(normalize("<Primary><Alt><Shift>p"), normalize("<Shift><Control><Alt>P"));
  assert.equal(normalize("<Ctrl><Alt>v"), normalize("<Control><Alt>v"));
});

test("modificadores diferentes não conflitam", () => {
  assert.notEqual(normalize("<Primary><Alt>p"), normalize("<Primary><Alt><Shift>p"));
  assert.notEqual(normalize("<Super>p"), normalize("<Alt>p"));
});

test("vazio é vazio", () => {
  assert.equal(normalize(""), "");
  assert.equal(label(""), "");
});

test("rótulo legível", () => {
  assert.equal(label("<Primary><Alt><Shift>p"), "Ctrl+Alt+Shift+P");
  assert.equal(label("<Super>Page_Up"), "Super+Page Up");
  assert.equal(label("<Primary><Shift><Alt>F12"), "Ctrl+Shift+Alt+F12");
});
