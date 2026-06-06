import express      from "express";
import path         from "node:path";
import { fileURLToPath } from "node:url";
import ordersRouter from "./routes/orders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const port = parseInt(process.env.PORT ?? "3000");

// ── Stripe webhook necesita raw body ANTES de express.json ──────────
app.use("/api/stripe/webhook", express.raw({ type: "*/*" }));

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname)));

// ── Rutas HTML sin extensión ────────────────────────────────────────
["privacidad","terminos","cookies","envios","visualizador","admin"].forEach(p =>
  app.get(`/${p}`, (_req, res) =>
    res.sendFile(path.join(__dirname, `${p}.html`))
  )
);
app.get("/pedido-ok", (_req, res) => res.sendFile(path.join(__dirname, "pedido-ok.html")));

// ── Pedidos + Stripe ────────────────────────────────────────────────
app.use(ordersRouter);

// ── /api/setup-status  GET ──────────────────────────────────────────
app.get("/api/setup-status", (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.headers["x-admin-secret"] !== secret)
    return res.status(401).json({ error: "No autorizado" });
  res.json({
    stripe:  !!(process.env.STRIPE_SECRET_KEY),
    webhook: !!(process.env.STRIPE_WEBHOOK_SECRET),
    volume:  !!(process.env.RAILWAY_VOLUME_MOUNT_PATH),
    meshy:   !!(process.env.MESHY_API_KEY),
  });
});

// ── /api/generate-3d  POST ──────────────────────────────────────────
app.post("/api/generate-3d", async (req, res) => {
  const apiKey = (process.env.MESHY_API_KEY || "").trim();
  if (!apiKey) return res.status(500).json({ error: "MESHY_API_KEY no configurada." });
  const image = (req.body?.image || "").trim();
  if (!image.startsWith("data:image"))
    return res.status(400).json({ error: "Falta campo image como data URI base64." });
  try {
    const r = await fetch("https://api.meshy.ai/openapi/v1/image-to-3d", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: image, ai_model: "latest",
        should_texture: true, enable_pbr: true, hd_texture: true,
        should_remesh: true, topology: "quad", target_polycount: 30000,
        target_formats: ["glb","obj","stl"],
      }),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: `Meshy ${r.status}`, detail: text });
    res.json({ taskId: JSON.parse(text).result });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── /api/poll-3d  GET ───────────────────────────────────────────────
app.get("/api/poll-3d", async (req, res) => {
  const apiKey = (process.env.MESHY_API_KEY || "").trim();
  if (!apiKey) return res.status(500).json({ error: "MESHY_API_KEY no configurada." });
  const { taskId } = req.query;
  if (!taskId) return res.status(400).json({ error: "Falta taskId" });
  try {
    const r = await fetch(`https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: `Meshy ${r.status}` });
    const data = await r.json();
    if (data.status === "SUCCEEDED") {
      const base = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `http://localhost:${port}`;
      const proxy = u => u ? `${base}/api/proxy-glb?url=${encodeURIComponent(u)}` : null;
      return res.json({ status:"SUCCEEDED", glbUrl:proxy(data.model_urls?.glb),
        objUrl:data.model_urls?.obj??null, thumbnail:data.thumbnail_url??null,
        glbDirect:data.model_urls?.glb??null });
    }
    if (data.status === "FAILED")
      return res.json({ status:"FAILED", error:data.task_error?.message??"Error desconocido" });
    res.json({ status:data.status, progress:data.progress??0 });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── /api/proxy-glb  GET ─────────────────────────────────────────────
app.get("/api/proxy-glb", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Falta url" });
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    res.setHeader("Content-Type","model/gltf-binary");
    res.setHeader("Access-Control-Allow-Origin","*");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── /api/gallery-save  POST ─────────────────────────────────────────
app.post("/api/gallery-save", async (req, res) => {
  const { taskId, thumbnail, glbDirect, glbProxy, objUrl, name } = req.body || {};
  if (!taskId || !glbDirect)
    return res.status(400).json({ error: "taskId y glbDirect son requeridos" });
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    return res.json({ ok:true, persisted:false });
  try {
    const { put } = await import("@vercel/blob");
    const entry = { taskId, thumbnail:thumbnail||null, glbDirect, glbProxy:glbProxy||null,
      objUrl:objUrl||null, name:name||`Modelo ${new Date().toLocaleDateString("es-ES")}`,
      createdAt:new Date().toISOString() };
    await put(`gallery/${taskId}.json`, JSON.stringify(entry),
      { access:"public", contentType:"application/json", addRandomSuffix:false });
    res.json({ ok:true, persisted:true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── /api/gallery-load  GET ──────────────────────────────────────────
app.get("/api/gallery-load", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.json([]);
  const limit = Math.min(parseInt(req.query.limit||"24"),48);
  try {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix:"gallery/", limit:100 });
    const entries = await Promise.all(
      blobs.sort((a,b)=>new Date(b.uploadedAt)-new Date(a.uploadedAt)).slice(0,limit)
        .map(async b => { try { return await (await fetch(b.url)).json(); } catch { return null; } })
    );
    res.setHeader("Cache-Control","public, max-age=30, stale-while-revalidate=60");
    res.json(entries.filter(Boolean));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Fallback → index.html ───────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`[toy3dmaker] Running on port ${port}`);
});