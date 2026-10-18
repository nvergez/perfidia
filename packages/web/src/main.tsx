// First: Zod must see its `jitless` flag before the protocol's schemas load (see the module).
// oxlint-disable-next-line import/no-unassigned-import -- imported for its effect, before Zod loads
import "./zod-jitless.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

// The spectator app's entry: React 19 on `#root`.

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
