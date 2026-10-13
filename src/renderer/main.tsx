import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrap } from "./state/actions";
import { startExternalWatcher } from "./state/external";
import "./styles/app.css";

bootstrap();
startExternalWatcher();

if (import.meta.env.DEV) {
  // Handy for poking at state from devtools.
  void Promise.all([import("./state/threads"), import("./state/ui"), import("./state/conn"), import("./rpc/client"), import("./state/actions")]).then(
    ([threads, ui, conn, client, actions]) =>
      Object.assign(window, { __ret: { useThreads: threads.useThreads, useUI: ui.useUI, useConn: conn.useConn, clients: client.clients, actions } }),
  );
}
createRoot(document.getElementById("root")!).render(<App />);
