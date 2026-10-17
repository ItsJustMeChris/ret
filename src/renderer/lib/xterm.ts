// xterm.js and its addons, loaded the first time a terminal shows (it's a few hundred KB nobody
// without a terminal needs at startup).
import "@xterm/xterm/css/xterm.css";
export { Terminal } from "@xterm/xterm";
export { FitAddon } from "@xterm/addon-fit";
export { WebLinksAddon } from "@xterm/addon-web-links";
export { Unicode11Addon } from "@xterm/addon-unicode11";
