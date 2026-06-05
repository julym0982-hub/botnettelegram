const { Telegraf, Markup } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");
require("dotenv").config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || "";
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// ─── STATE ────────────────────────────────────────────────────────────────────
let gpLinks = [];          // ["https://t.me/+xxx", ...]
let autoMessage = "";      // /msg နဲ့ set လုပ်ထားတဲ့ message
let intervalMinutes = 0;   // /time နဲ့ set လုပ်ထားတဲ့ minutes
let schedulerTimer = null; // setInterval reference
let isSending = false;     // concurrent send guard

// ─── TELEGRAF BOT ─────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── GRAMJS USER CLIENT ───────────────────────────────────────────────────────
const session = new StringSession(SESSION_STRING);
const userClient = new TelegramClient(session, API_ID, API_HASH, {
  connectionRetries: 5,
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
}

function adminOnly(ctx, next) {
  if (!isAdmin(ctx)) return ctx.reply("❌ Admin only.");
  return next();
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (intervalMinutes <= 0) return;

  schedulerTimer = setInterval(async () => {
    if (!autoMessage) return;
    if (gpLinks.length === 0) return;
    await sendToAllGPs();
  }, intervalMinutes * 60 * 1000);

  console.log(`⏰ Scheduler started: every ${intervalMinutes} min`);
}

async function sendToAllGPs() {
  if (isSending) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ ပို့နေဆဲ ရှိသေးသည်၊ ခဏစောင့်ပါ။");
    return;
  }
  if (!autoMessage) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ Message မသတ်မှတ်ရသေး။ /msg ကိုသုံးပါ။");
    return;
  }
  if (gpLinks.length === 0) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ GP link မရှိသေး။ /gp ကိုသုံးပါ။");
    return;
  }

  isSending = true;
  let successCount = 0;
  let failCount = 0;

  await bot.telegram.sendMessage(ADMIN_ID, `🚀 GP ${gpLinks.length} ခုဆီ စတင်ပို့မည်...`);

  for (let i = 0; i < gpLinks.length; i++) {
    const link = gpLinks[i];
    const num = i + 1;
    try {
      // join group if needed then send
      const entity = await userClient.getEntity(link);
      await userClient.sendMessage(entity, { message: autoMessage });
      successCount++;
      await bot.telegram.sendMessage(ADMIN_ID, `✅ Send ${num} done — ${link}`);
    } catch (err) {
      failCount++;
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `❌ Fail send ${num} — ${link}\n⚠️ Error: ${err.message}`
      );
    }

    // 2 second delay between each send (flood protection)
    if (i < gpLinks.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  await bot.telegram.sendMessage(
    ADMIN_ID,
    `📊 ပြီးဆုံးပါပြီ။\n✅ အောင်မြင်: ${successCount}\n❌ မအောင်မြင်: ${failCount}`
  );
  isSending = false;
}

// ─── BOT COMMANDS ─────────────────────────────────────────────────────────────

// /start
bot.start(adminOnly, (ctx) => {
  ctx.reply(
    `👋 GP Auto Sender Bot\n\n` +
    `📌 Commands:\n` +
    `/gp (link),(link)... — GP link သတ်မှတ်\n` +
    `/gp — ရှိပြီးသား GP link တွေကြည့်\n` +
    `/editgp — GP link တွေ edit လုပ်\n` +
    `/msg (text) — ပို့မည့် message သတ်မှတ်\n` +
    `/time (N)min — interval သတ်မှတ် (24hr ပတ်လုံး)\n` +
    `/time stop — scheduler ရပ်\n` +
    `/send — ယခုချက်ချင်း ပို့\n` +
    `/status — လောလောဆယ် settings ကြည့်`
  );
});

// /gp — view or set
bot.command("gp", adminOnly, async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();

  if (!args) {
    // view mode
    if (gpLinks.length === 0) {
      return ctx.reply("📭 GP link မရှိသေး။");
    }
    const list = gpLinks.map((l, i) => `${i + 1}. ${l}`).join("\n");
    return ctx.reply(`📋 GP Links (${gpLinks.length}):\n\n${list}`);
  }

  // set mode: /gp link1,link2,...
  const newLinks = args
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  gpLinks = newLinks;
  ctx.reply(`✅ GP ${gpLinks.length} ခု သတ်မှတ်ပြီးပါပြီ။\n\n${gpLinks.map((l, i) => `${i + 1}. ${l}`).join("\n")}`);
});

// /editgp — interactive edit
bot.command("editgp", adminOnly, async (ctx) => {
  if (gpLinks.length === 0) {
    return ctx.reply(
      "📭 GP link မရှိသေး။\n\n➕ ထည့်ရန်:\n/gp link1,link2,..."
    );
  }

  const list = gpLinks.map((l, i) => `${i + 1}. ${l}`).join("\n");
  ctx.reply(
    `📋 GP Links (${gpLinks.length}):\n\n${list}\n\n` +
    `📝 Edit Options:\n` +
    `/addgp (link) — GP link တစ်ခုထည့်\n` +
    `/removegp (number) — GP link ဖျက် (နံပါတ်ဖြင့်)\n` +
    `/cleargp — GP link အကုန်ဖျက်`
  );
});

// /addgp
bot.command("addgp", adminOnly, (ctx) => {
  const link = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!link) return ctx.reply("⚠️ Usage: /addgp (link)");
  gpLinks.push(link);
  ctx.reply(`✅ ထည့်ပြီးပါပြီ။ ယခု GP ${gpLinks.length} ခုရှိသည်။\n\n${link}`);
});

// /removegp
bot.command("removegp", adminOnly, (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  const idx = parseInt(arg) - 1;
  if (isNaN(idx) || idx < 0 || idx >= gpLinks.length) {
    return ctx.reply(`⚠️ Usage: /removegp (number) — 1 မှ ${gpLinks.length} အတွင်း`);
  }
  const removed = gpLinks.splice(idx, 1)[0];
  ctx.reply(`🗑️ ဖျက်ပြီးပါပြီ:\n${removed}\n\nကျန် GP: ${gpLinks.length} ခု`);
});

// /cleargp
bot.command("cleargp", adminOnly, (ctx) => {
  gpLinks = [];
  ctx.reply("🗑️ GP link အကုန်ဖျက်ပြီးပါပြီ။");
});

// /msg
bot.command("msg", adminOnly, (ctx) => {
  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!text) {
    return ctx.reply(
      autoMessage
        ? `📝 လောလောဆယ် message:\n\n${autoMessage}`
        : "⚠️ Usage: /msg (ပို့မည့် message)"
    );
  }
  autoMessage = text;
  ctx.reply(`✅ Message သတ်မှတ်ပြီးပါပြီ:\n\n${autoMessage}`);
});

// /time
bot.command("time", adminOnly, (ctx) => {
  const arg = ctx.message.text.split(" ")[1];

  if (!arg) {
    return ctx.reply(
      intervalMinutes > 0
        ? `⏰ လောလောဆယ် interval: ${intervalMinutes} မိနစ်တစ်ကြိမ်\n\nရပ်ရန်: /time stop`
        : "⚠️ Usage: /time (N)min  ဥပမာ: /time 5min\nရပ်ရန်: /time stop"
    );
  }

  if (arg.toLowerCase() === "stop") {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
      intervalMinutes = 0;
    }
    return ctx.reply("⏹️ Scheduler ရပ်ပြီးပါပြီ။");
  }

  const match = arg.match(/^(\d+)min$/i);
  if (!match) {
    return ctx.reply("⚠️ Format မှားသည်။ ဥပမာ: /time 5min");
  }

  intervalMinutes = parseInt(match[1]);
  if (intervalMinutes < 1) {
    return ctx.reply("⚠️ အနည်းဆုံး 1 မိနစ် ဖြစ်ရမည်။");
  }

  startScheduler();
  ctx.reply(
    `✅ ${intervalMinutes} မိနစ်တိုင်း တစ်ကြိမ် auto ပို့မည်\n` +
    `(24နာရီ ပတ်လုံး အလိုအလျောက် ပို့နေမည်)\n\n` +
    `ရပ်ရန်: /time stop`
  );
});

// /send — manual immediate send
bot.command("send", adminOnly, async (ctx) => {
  await ctx.reply("📤 ယခု GP တွေဆီ စတင်ပို့မည်...");
  await sendToAllGPs();
});

// /status
bot.command("status", adminOnly, (ctx) => {
  const schedulerStatus =
    schedulerTimer && intervalMinutes > 0
      ? `🟢 ဖွင့်ထား — ${intervalMinutes} မိနစ်တစ်ကြိမ်`
      : "🔴 ပိတ်ထား";

  ctx.reply(
    `📊 Current Status:\n\n` +
    `📋 GP Links: ${gpLinks.length} ခု\n` +
    `💬 Message: ${autoMessage ? `"${autoMessage.substring(0, 50)}${autoMessage.length > 50 ? "..." : ""}"` : "မသတ်မှတ်ရသေး"}\n` +
    `⏰ Scheduler: ${schedulerStatus}\n` +
    `🔄 ပို့နေဆဲ: ${isSending ? "ဟုတ်" : "မဟုတ်"}`
  );
});

// ─── KEEP ALIVE (Render free tier) ───────────────────────────────────────────
const http = require("http");
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

server.listen(PORT, () => console.log(`🌐 Health server on port ${PORT}`));

// self-ping every 14 minutes
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  http.get(url, (r) => console.log(`💓 Self-ping: ${r.statusCode}`)).on("error", () => {});
}, 14 * 60 * 1000);

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("🔌 Connecting user client...");
  await userClient.start({
    phoneNumber: async () => await input.text("📱 Phone number: "),
    password: async () => await input.text("🔑 2FA password (ရှိလျှင်): "),
    phoneCode: async () => await input.text("📨 OTP code: "),
    onError: (err) => console.error("UserClient error:", err),
  });

  const savedSession = userClient.session.save();
  console.log("\n✅ SESSION STRING (ဒါကို .env မှာ SESSION_STRING= ထည့်ပါ):\n");
  console.log(savedSession);
  console.log("\n");

  console.log("🤖 Starting bot...");
  await bot.launch();
  console.log("✅ Bot started!");

  await bot.telegram.sendMessage(ADMIN_ID, "✅ GP Auto Sender Bot အသင့်ဖြစ်ပြီ။");

  process.once("SIGINT", () => {
    bot.stop("SIGINT");
    userClient.disconnect();
  });
  process.once("SIGTERM", () => {
    bot.stop("SIGTERM");
    userClient.disconnect();
  });
}

main().catch(console.error);
