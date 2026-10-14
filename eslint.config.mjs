import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "dist/", "release/"] },
  js.configs.recommended,
  {
    // processo principal, preloads e módulos Node
    files: ["src/main.js", "src/shortcuts.js", "src/cameras.js", "src/*preload.js", "tests/**/*.js", "build/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    // janela principal: script clássico, só o que o preload expõe
    files: ["src/renderer.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
  },
  {
    // janela da câmera virtual: módulo ES (importa o MediaPipe)
    files: ["src/blur.js"],
    languageOptions: { sourceType: "module", globals: { ...globals.browser, MediaStreamTrackProcessor: "readonly" } },
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
