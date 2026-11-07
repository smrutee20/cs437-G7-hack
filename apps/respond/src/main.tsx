import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing response root element");

createRoot(root).render(<main>Response scaffold — no credential or submission features yet.</main>);
