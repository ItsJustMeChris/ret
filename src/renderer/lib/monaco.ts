// Monaco (the editor inside VS Code), loaded only when a file is first opened in Ret's viewer.
// The editor's own features (find, folding, sticky scroll, minimap, bracket matching…) and
// syntax highlighting for ~80 languages; no language servers, so a file viewed on its own
// doesn't light up with "can't find module" errors.
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/features/register.all.js";
import "monaco-editor/languages/definitions/register.all.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// JSON has no grammar among the basic languages (it comes with a language server we skip).
monaco.languages.register({ id: "json", extensions: [".json", ".jsonc", ".json5", ".code-workspace"], aliases: ["JSON"] });
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
      [/\b(true|false|null)\b/, "keyword"],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/[{}[\]]/, "delimiter.bracket"],
      [/[,:]/, "delimiter"],
    ],
    comment: [
      [/\*\//, "comment", "@pop"],
      [/./, "comment"],
    ],
  },
});
monaco.languages.setLanguageConfiguration("json", {
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
  ],
});

// Ret's black theme, with VS Code's Dark+ token colours.
monaco.editor.defineTheme("ret-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0a0a0a",
    "editor.foreground": "#e4e4e4",
    "editorLineNumber.foreground": "#4a4a4a",
    "editorLineNumber.activeForeground": "#a3a3a3",
    "editor.lineHighlightBackground": "#141414",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#2b3a6b",
    "editor.inactiveSelectionBackground": "#1f2a4a",
    "editorIndentGuide.background1": "#1b1b1b",
    "editorIndentGuide.activeBackground1": "#333333",
    "editorWhitespace.foreground": "#2a2a2a",
    "editorWidget.background": "#121212",
    "editorWidget.border": "#262626",
    "editorStickyScroll.background": "#0a0a0a",
    "editorStickyScrollHover.background": "#161616",
    "minimap.background": "#0a0a0a",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff24",
    "scrollbarSlider.activeBackground": "#ffffff30",
  },
});
monaco.editor.defineTheme("ret-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#ffffff", "editor.lineHighlightBorder": "#00000000" },
});

/** Monaco's language id for a file, by its name (extension or exact file name), else plain text. */
export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
  }
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (/^(makefile|\.env.*|\.gitignore|\.gitattributes)$/.test(name)) return "shell";
  return "plaintext";
}

export { monaco };
