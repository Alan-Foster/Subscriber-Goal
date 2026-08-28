import "../index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SubscribeOnlyApp } from "./SubscribeOnlyApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SubscribeOnlyApp />
  </StrictMode>,
);
