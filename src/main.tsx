import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

// NOTE: intentionally not wrapped in <StrictMode>. xterm keeps imperative
// resources (renderer, viewport, PTY listeners) that do not survive React's
// dev-only double mount, and the duplicate listeners caused spurious PTY writes.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
