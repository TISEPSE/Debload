import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// L'ordre compte : la police, puis le design system, puis ce qui est propre à
// Debload et s'appuie sur ses tokens.
import "@fontsource-variable/inter";
import "./styles/nocturne.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
