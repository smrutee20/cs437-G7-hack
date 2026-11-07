import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing portal root element");

createRoot(root).render(<main>Portal scaffold — no sign-in or poll features yet.</main>);
