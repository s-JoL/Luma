import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { App } from "./app.tsx";
import { ThemeProvider, ToastHost } from "./ui.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastHost>
        <App />
      </ToastHost>
    </ThemeProvider>
  </StrictMode>,
);
