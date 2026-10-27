import React from "react";
import ReactDOM from "react-dom/client";
import "@/styles.css";
import App from "./App";
import { registerServiceWorker } from "./push";

const container = document.getElementById("root");
if (!container) throw new Error("AuraUI could not find its #root element.");

/*
 * The service worker is registered before the first render, not after.
 *
 * Push subscriptions are created against `navigator.serviceWorker.ready`, and a registration
 * that starts late makes the first "turn notifications on" tap fail for a reason that has
 * nothing to do with the tap. Nothing waits on it here: the app renders from the pairing it
 * already has, and the worker lands when it lands.
 */
void registerServiceWorker(import.meta.env.BASE_URL);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
