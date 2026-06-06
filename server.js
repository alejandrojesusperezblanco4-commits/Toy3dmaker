import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const port = parseInt(process.env.PORT ?? "3000");

app.use(express.json());

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Rutas directas para las páginas legales ───────────────────────
const pages = ["privacidad", "terminos", "cookies", "envios"];
pages.forEach(p => {
  app.get(`/${p}`, (_req, res) =>
    res.sendFile(path.join(__dirname, `${p}.html`))
  );
});

// ── Fallback → index.html ─────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`[toy3dmaker] Running on port ${port}`);
});
