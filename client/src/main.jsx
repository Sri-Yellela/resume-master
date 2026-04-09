// REVAMP v1 — main.jsx
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./styles/theme.jsx";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
