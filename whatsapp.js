import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode";

const ENABLED = process.env.WA_ENABLED === "true";

let client = null;
let waStatus = "disabled"; // disabled | initializing | qr_pending | ready | auth_failure
let currentQR = null;

export function getWAStatus() {
  return { status: waStatus, qr: currentQR };
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0034")) return digits.slice(2);
  if (digits.startsWith("34") && digits.length >= 11) return digits;
  if (digits.length === 9) return `34${digits}`;
  return digits;
}

export async function sendWA(phone, message) {
  if (waStatus !== "ready" || !phone) return false;
  try {
    const chatId = `${normalizePhone(phone)}@c.us`;
    await client.sendMessage(chatId, message);
    return true;
  } catch (e) {
    console.warn("[whatsapp] sendMessage error:", e.message);
    return false;
  }
}

export function initWhatsApp() {
  if (!ENABLED) return;

  const dataPath = process.env.DATA_DIR ?? "./data";

  client = new Client({
    authStrategy: new LocalAuth({ dataPath }),
    puppeteer: {
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    },
  });

  waStatus = "initializing";

  client.on("qr", async (qr) => {
    waStatus = "qr_pending";
    currentQR = await qrcode.toDataURL(qr);
    console.log("[whatsapp] QR generado — escanéalo desde el panel admin");
  });

  client.on("ready", () => {
    waStatus = "ready";
    currentQR = null;
    console.log("[whatsapp] Cliente listo ✓");
  });

  client.on("auth_failure", () => {
    waStatus = "auth_failure";
    console.warn("[whatsapp] Fallo de autenticación");
  });

  client.on("disconnected", (reason) => {
    waStatus = "initializing";
    console.warn("[whatsapp] Desconectado:", reason, "— reiniciando...");
    client.initialize().catch(e => console.error("[whatsapp] reinicio fallido:", e));
  });

  client.initialize().catch(e => console.error("[whatsapp] init error:", e));
}
