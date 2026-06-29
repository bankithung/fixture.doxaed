import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted Inter (vendored Google Fonts files) — bundled by Vite and served
// from /assets, so the app no longer depends on the Google Fonts CDN at runtime
// (design rule: never <link> Google Fonts in production). Weights: 400 regular,
// 500 medium, 600 semibold (our "bold"/headings), 700 kept as a safety net.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./index.css";
import App from "./App";
import { useAuthStore } from "@/features/auth/authStore";

// Kick off the /me/ hydrate before render so ProtectedRoute can resolve.
void useAuthStore.getState().bootstrap();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
