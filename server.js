// ============================================================
// draw-report-relay  (v2 — com botao "Banir" no Discord)
// Fluxo:
//   Roblox  -> POST /report (secret)         -> posta a denuncia no canal (com botao Banir)
//   Discord -> POST /interactions (assinado) -> no clique, bane o autor via Roblox Open Cloud
//
// O Roblox NAO posta direto no Discord (por isso este relay). E o botao precisa
// de uma APLICACAO/BOT (webhook nao recebe clique). Requer Node 18+.
// ============================================================
import express from "express";
import { Resvg } from "@resvg/resvg-js";
import nacl from "tweetnacl";

const PORT = process.env.PORT || 8080;

// --- Roblox -> relay ---
const RELAY_SECRET = process.env.RELAY_SECRET;

// --- relay -> Discord (bot) ---
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;            // verifica as interacoes
const MOD_ROLE_IDS = (process.env.MOD_ROLE_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;          // fallback (sem botao) se nao houver bot

// --- relay -> Roblox (Open Cloud ban) ---
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_UNIVERSE_ID = process.env.ROBLOX_UNIVERSE_ID;
const BAN_DURATION_SECONDS = parseInt(process.env.BAN_DURATION_SECONDS || "0", 10); // 0 = permanente
const BAN_DISPLAY_REASON = process.env.BAN_DISPLAY_REASON || "Banido pela moderacao.";

const DISCORD_API = "https://discord.com/api/v10";
const app = express();

app.get("/", (_req, res) => res.send("draw-report-relay v2 ok"));

// ------------------------------------------------------------
// /report : Roblox manda os tracos; renderizamos e postamos no canal
// ------------------------------------------------------------
app.post("/report", express.json({ limit: "8mb" }), async (req, res) => {
  try {
    const { secret, report = {}, strokes = [] } = req.body || {};
    if (!RELAY_SECRET || secret !== RELAY_SECRET) return res.status(401).json({ error: "bad secret" });
    if (!Array.isArray(strokes) || strokes.length === 0) return res.status(400).json({ error: "no strokes" });

    const built = buildSvg(strokes);
    if (!built) return res.status(400).json({ error: "empty drawing" });
    const png = new Resvg(built.svg, { fitTo: { mode: "original" } }).render().asPng();

    const ts = Number(report.timestamp) || Math.floor(Date.now() / 1000);
    const authorId = String(report.authorUserId ?? "0");
    const authorName = String(report.authorName ?? "?").slice(0, 40);
    const embed = {
      title: "🚩 Denuncia de desenho",
      color: 0xed4245,
      fields: [
        { name: "Autor", value: `${authorName} (\`${authorId}\`)`, inline: true },
        { name: "Motivo", value: String(report.reason ?? "?"), inline: true },
        { name: "Total", value: String(report.total ?? 1), inline: true },
        { name: "Denunciante", value: `${report.reporterName ?? "?"} (\`${report.reporterUserId ?? "?"}\`)`, inline: true },
        { name: "Place", value: String(report.placeId ?? "?"), inline: true },
        { name: "Servidor (jobId)", value: report.jobId ? `\`${report.jobId}\`` : "—", inline: false },
      ],
      image: { url: "attachment://denuncia.png" },
      footer: { text: `${built.W}x${built.H}px · ${strokes.length} tracos` },
      timestamp: new Date(ts * 1000).toISOString(),
    };

    let ok;
    if (BOT_TOKEN && CHANNEL_ID) {
      const components = [{
        type: 1,
        components: [{ type: 2, style: 4, label: "🔨 Banir autor", custom_id: `ban:${authorId}:${authorName}`.slice(0, 100) }],
      }];
      ok = await postViaBot({ embeds: [embed], components }, png);
    } else if (WEBHOOK_URL) {
      ok = await postViaWebhook({ username: "Moderacao", embeds: [embed] }, png); // sem botao
    } else {
      return res.status(500).json({ error: "no discord target configured" });
    }
    if (!ok) return res.status(502).json({ error: "discord post failed" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[relay] /report erro", e);
    res.status(500).json({ error: "internal" });
  }
});

// ------------------------------------------------------------
// /interactions : Discord chama aqui no clique do botao (precisa de raw body p/ assinatura)
// ------------------------------------------------------------
app.post("/interactions", express.raw({ type: "*/*" }), async (req, res) => {
  const sig = req.get("X-Signature-Ed25519");
  const ts = req.get("X-Signature-Timestamp");
  const raw = req.body; // Buffer
  if (!sig || !ts || !PUBLIC_KEY) return res.status(401).send("missing signature");
  let verified = false;
  try {
    verified = nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(ts), raw]),
      Buffer.from(sig, "hex"),
      Buffer.from(PUBLIC_KEY, "hex"),
    );
  } catch { verified = false; }
  if (!verified) return res.status(401).send("invalid signature");

  const interaction = JSON.parse(raw.toString("utf8"));
  if (interaction.type === 1) return res.json({ type: 1 }); // PING -> PONG

  if (interaction.type === 3) { // clique de componente
    const customId = interaction.data?.custom_id || "";
    if (!customId.startsWith("ban:")) return res.json({ type: 4, data: { flags: 64, content: "Acao desconhecida." } });

    const roles = interaction.member?.roles || [];
    const clicker = interaction.member?.user?.id || interaction.user?.id || "?";
    const allowed = MOD_ROLE_IDS.length > 0 && roles.some(r => MOD_ROLE_IDS.includes(r));
    if (!allowed) return res.json({ type: 4, data: { flags: 64, content: "❌ Voce nao tem permissao pra banir." } });

    const parts = customId.split(":");
    const userId = parts[1];
    const name = parts.slice(2).join(":") || userId;
    const result = await banRobloxUser(userId, `Denuncia no Discord (mod ${clicker})`);
    if (result.ok) {
      return res.json({ type: 4, data: { content: `🔨 **${name}** (\`${userId}\`) foi **banido** por <@${clicker}>.` } });
    }
    return res.json({ type: 4, data: { flags: 64, content: `⚠️ Falha ao banir (HTTP ${result.status}): ${result.detail}`.slice(0, 1800) } });
  }

  return res.json({ type: 4, data: { flags: 64, content: "Interacao nao tratada." } });
});

// ------------------------------------------------------------ helpers
async function postViaBot(payload, png) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: "denuncia.png" }] }));
  form.append("files[0]", new Blob([png], { type: "image/png" }), "denuncia.png");
  const r = await fetch(`${DISCORD_API}/channels/${CHANNEL_ID}/messages`, {
    method: "POST", headers: { Authorization: `Bot ${BOT_TOKEN}` }, body: form,
  });
  if (!r.ok) { console.error("[relay] bot post", r.status, (await r.text().catch(() => "")).slice(0, 400)); return false; }
  return true;
}

async function postViaWebhook(payload, png) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", new Blob([png], { type: "image/png" }), "denuncia.png");
  const r = await fetch(WEBHOOK_URL, { method: "POST", body: form });
  if (!r.ok) { console.error("[relay] webhook post", r.status); return false; }
  return true;
}

async function banRobloxUser(userId, privateReason) {
  if (!ROBLOX_API_KEY || !ROBLOX_UNIVERSE_ID) return { ok: false, status: 0, detail: "ROBLOX_API_KEY/UNIVERSE_ID nao configurados" };
  const gameJoinRestriction = {
    active: true,
    privateReason: String(privateReason).slice(0, 400),
    displayReason: String(BAN_DISPLAY_REASON).slice(0, 400),
    excludeAltAccounts: false,
  };
  if (BAN_DURATION_SECONDS > 0) gameJoinRestriction.duration = `${BAN_DURATION_SECONDS}s`;
  const url = `https://apis.roblox.com/cloud/v2/universes/${ROBLOX_UNIVERSE_ID}/user-restrictions/${userId}?updateMask=gameJoinRestriction`;
  try {
    const r = await fetch(url, {
      method: "PATCH",
      headers: { "x-api-key": ROBLOX_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ gameJoinRestriction }),
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) { console.error("[relay] roblox ban", r.status, text.slice(0, 400)); return { ok: false, status: r.status, detail: text.slice(0, 280) }; }
    return { ok: true, status: r.status, detail: "" };
  } catch (e) {
    console.error("[relay] roblox ban exception", e);
    return { ok: false, status: -1, detail: String(e).slice(0, 200) };
  }
}

function buildSvg(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0;
  for (const s of strokes) {
    const w = Number(s.width) || 0; if (w > maxW) maxW = w;
    const p = s.pts || [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return null;
  const span = Math.max(maxX - minX, maxY - minY);
  const pad = maxW * 0.5 + span * 0.04 + 2;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const wStuds = Math.max(1e-3, maxX - minX);
  const hStuds = Math.max(1e-3, maxY - minY);
  const TARGET = 1024;
  const scale = TARGET / Math.max(wStuds, hStuds);
  const W = Math.max(16, Math.round(wStuds * scale));
  const H = Math.max(16, Math.round(hStuds * scale));
  const mx = (x) => ((x - minX) * scale).toFixed(2);
  const my = (y) => ((y - minY) * scale).toFixed(2);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];
  for (const s of strokes) {
    const c = s.color || [0, 0, 0];
    const col = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    const op = s.opacity == null ? 1 : Number(s.opacity);
    const sw = Math.max(0.6, (Number(s.width) || 0.5) * scale);
    const p = s.pts || [];
    if (p.length < 2) continue;
    if (p.length === 2) { out.push(`<circle cx="${mx(p[0])}" cy="${my(p[1])}" r="${(sw / 2).toFixed(2)}" fill="${col}" fill-opacity="${op}"/>`); continue; }
    let pts = "";
    for (let i = 0; i + 1 < p.length; i += 2) pts += `${mx(p[i])},${my(p[i + 1])} `;
    if (s.fill) out.push(`<polygon points="${pts.trim()}" fill="${col}" fill-opacity="${op}"/>`);
    else out.push(`<polyline points="${pts.trim()}" fill="none" stroke="${col}" stroke-opacity="${op}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  out.push(`</svg>`);
  return { svg: out.join(""), W, H };
}

app.listen(PORT, () => console.log(`[relay] v2 ouvindo na porta ${PORT}`));
