import { Router } from "express";
import multer   from "multer";
import path     from "node:path";
import fs       from "node:fs";
import { randomUUID } from "node:crypto";
import Stripe   from "stripe";
import db, { uploadsDir } from "../db.js";

const router = Router();

// ── Multer: guarda el STL en disco ──────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || ".stl";
    const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
    cb(null, `${Date.now()}_${safe}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const ok = [".stl", ".obj", ".3mf"].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error("Solo se aceptan archivos STL, OBJ o 3MF"), ok);
  },
});

function now() { return new Date().toISOString(); }
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key, { apiVersion: "2024-12-18.acacia" }) : null;
}
function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next(); // sin secret → acceso libre (dev)
  const token = req.headers["x-admin-secret"] || req.query.secret;
  if (token !== secret) return res.status(401).json({ error: "No autorizado" });
  next();
}

const STATUS_EMAILS = {
  pagado:      { subject: "✅ Pago confirmado — Toy3DMaker", msg: "¡Tu pago se ha confirmado! Tu pedido está en cola." },
  en_cola:     { subject: "📋 Pedido en cola — Toy3DMaker", msg: "Tu pedido está en la cola de impresión. Te avisamos cuando empiece." },
  imprimiendo: { subject: "🖨️ ¡Imprimiendo! — Toy3DMaker", msg: "¡Tu figura ya está en la impresora!" },
  listo:       { subject: "🎉 ¡Tu pedido está listo! — Toy3DMaker", msg: "Tu figura está lista para recoger o enviar. Nos ponemos en contacto contigo." },
  entregado:   { subject: "📦 Pedido entregado — Toy3DMaker", msg: "Tu pedido ha sido entregado. ¡Gracias por confiar en nosotros!" },
  cancelado:   { subject: "❌ Pedido cancelado — Toy3DMaker", msg: "Tu pedido ha sido cancelado. Contacta con nosotros si tienes dudas." },
};

async function sendStatusEmail(order, newStatus) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !order.email) return;
  const info = STATUS_EMAILS[newStatus];
  if (!info) return;
  const base = process.env.PUBLIC_URL ?? "https://toy3dmaker-production.up.railway.app";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Toy3DMaker <pedidos@toy3dmaker.com>",
      to:   [order.email],
      subject: info.subject,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:auto">
        <h2 style="color:#00a89d">Toy3DMaker</h2>
        <p>Hola <strong>${order.name}</strong>,</p>
        <p>${info.msg}</p>
        <p><a href="${base}/pedido-ok?order=${order.id}" style="background:#0055DD;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Ver mi pedido</a></p>
        <p style="color:#888;font-size:12px">Ref: ${order.id}</p>
      </div>`,
    }),
  });
}

// ── POST /api/orders ─────────────────────────────────────────────────
// Crea un pedido. Acepta multipart (con STL) o JSON (sin archivo).
router.post("/api/orders", upload.single("stl"), (req, res) => {
  try {
    const body = req.body;
    if (!body.name || !body.email)
      return res.status(400).json({ error: "name y email son obligatorios" });

    const id = randomUUID();
    const ts = now();
    const stmt = db.prepare(`
      INSERT INTO orders
        (id, created_at, updated_at, name, email, phone, description,
         material, quality, size_cm, quantity, stl_filename, stl_path,
         price_estimate, status)
      VALUES
        (@id, @ts, @ts, @name, @email, @phone, @description,
         @material, @quality, @size_cm, @quantity, @stl_filename, @stl_path,
         @price_estimate, 'pendiente_pago')
    `);
    stmt.run({
      id, ts,
      name:           body.name,
      email:          body.email,
      phone:          body.phone          ?? null,
      description:    body.description    ?? null,
      material:       body.material       ?? "PLA",
      quality:        body.quality        ?? "estandar",
      size_cm:        body.size_cm        ?? null,
      quantity:       parseInt(body.quantity ?? "1"),
      stl_filename:   req.file?.originalname ?? null,
      stl_path:       req.file?.filename     ?? null,
      price_estimate: body.price_estimate ? parseFloat(body.price_estimate) : null,
    });

    res.status(201).json({ id, status: "pendiente_pago" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/orders/checkout ────────────────────────────────────────
// Crea sesión Stripe Checkout para un pedido existente.
router.post("/api/orders/checkout", async (req, res) => {
  const stripe = getStripe();
  if (!stripe)
    return res.status(500).json({ error: "STRIPE_SECRET_KEY no configurada" });

  const { order_id, success_url, cancel_url } = req.body;
  if (!order_id) return res.status(400).json({ error: "Falta order_id" });

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(order_id);
  if (!order) return res.status(404).json({ error: "Pedido no encontrado" });

  const base = process.env.PUBLIC_URL ?? "https://toy3dmaker-production.up.railway.app";
  const price = Math.round((order.price_final ?? order.price_estimate ?? 10) * 100); // céntimos

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: order.email,
      line_items: [{
        price_data: {
          currency: "eur",
          unit_amount: price,
          product_data: {
            name: `Impresión 3D — ${order.material} · ${order.quantity} ud.`,
            description: order.description ?? order.stl_filename ?? "Pedido Toy3dMaker",
          },
        },
        quantity: 1,
      }],
      metadata: { order_id },
      success_url: success_url ?? `${base}/pedido-ok?order=${order_id}`,
      cancel_url:  cancel_url  ?? `${base}/#cotizador`,
    });

    db.prepare("UPDATE orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?")
      .run(session.id, now(), order_id);

    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /api/stripe/webhook ─────────────────────────────────────────
// Stripe llama aquí cuando se confirma el pago. Usa express.raw().
router.post("/api/stripe/webhook",
  (req, res, next) => {
    // Re-buffer si ya fue parseado (precaución)
    if (req.rawBody) { req.body = req.rawBody; }
    next();
  },
  (req, res) => {
    const stripe = getStripe();
    const sig    = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = secret
        ? stripe.webhooks.constructEvent(req.body, sig, secret)
        : JSON.parse(req.body.toString());
    } catch (e) {
      return res.status(400).send(`Webhook error: ${e.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session  = event.data.object;
      const order_id = session.metadata?.order_id;
      if (order_id) {
        db.prepare(`
          UPDATE orders
          SET status = 'pagado', stripe_payment_id = ?, updated_at = ?
          WHERE id = ?
        `).run(session.payment_intent, now(), order_id);
        console.log(`[webhook] Pedido ${order_id} marcado como pagado`);
      }
    }

    res.json({ received: true });
  }
);

// ── GET /api/orders/:id/status ────────────────────────────────────────
// Público — no requiere autenticación. El cliente usa esto para ver su pedido.
router.get("/api/orders/:id/status", (req, res) => {
  const order = db.prepare(`
    SELECT id, status, name, material, quality, quantity,
           price_estimate, price_final, created_at, updated_at
    FROM orders WHERE id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
  res.json(order);
});

// ── GET /api/orders/stats ────────────────────────────────────────────
// IMPORTANTE: debe ir ANTES de /:id para que "stats" no sea capturado como ID
router.get("/api/orders/stats", adminAuth, (_req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*)                                           AS total,
      SUM(CASE WHEN status = 'pagado'      THEN 1 END)  AS pagados,
      SUM(CASE WHEN status = 'imprimiendo' THEN 1 END)  AS imprimiendo,
      SUM(CASE WHEN status = 'listo'       THEN 1 END)  AS listos,
      SUM(price_final)                                  AS facturado
    FROM orders
  `).get();
  res.json(stats);
});

// ── GET /api/orders ──────────────────────────────────────────────────
router.get("/api/orders", adminAuth, (_req, res) => {
  const orders = db.prepare(`
    SELECT id, created_at, updated_at, name, email, phone,
           material, quality, quantity, stl_filename,
           price_estimate, price_final, status, printer, notes
    FROM orders ORDER BY created_at DESC
  `).all();
  res.json(orders);
});

// ── GET /api/orders/:id ──────────────────────────────────────────────
router.get("/api/orders/:id", adminAuth, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido no encontrado" });
  res.json(order);
});

// ── PATCH /api/orders/:id ────────────────────────────────────────────
router.patch("/api/orders/:id", adminAuth, (req, res) => {
  const allowed = ["status", "notes", "printer", "price_final"];
  const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: "Nada que actualizar" });

  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Pedido no encontrado" });

  const set = fields.map(f => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE orders SET ${set}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...req.body, updated_at: now(), id: req.params.id });

  if (req.body.status && req.body.status !== existing.status) {
    sendStatusEmail(existing, req.body.status).catch(e => console.warn("[email]", e));
  }

  res.json({ ok: true });
});

// ── GET /api/orders/:id/file ─────────────────────────────────────────
router.get("/api/orders/:id/file", adminAuth, (req, res) => {
  const order = db.prepare("SELECT stl_path, stl_filename FROM orders WHERE id = ?")
    .get(req.params.id);
  if (!order?.stl_path)
    return res.status(404).json({ error: "Sin archivo" });

  const filePath = path.join(uploadsDir, order.stl_path);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "Archivo no encontrado en disco" });

  res.download(filePath, order.stl_filename ?? "modelo.stl");
});

// ── (stats moved above /:id — see top of GET routes) ─────────────────

export default router;
