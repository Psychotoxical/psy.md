import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/content.css";

import { App } from "./app";
import { ipc } from "./ipc";

async function boot(): Promise<void> {
  const state = await ipc.loadState();
  const app = new App(state);
  // Development builds expose the controller for state tests; release builds
  // drop this branch entirely.
  if (import.meta.env.DEV) Object.assign(window, { __psymd: app });
  await app.bindShell();
  await app.start(state.startupFile);
}

boot().catch((e) => {
  console.error("psy.md failed to start", e);
  void ipc.frontendReady();
});
