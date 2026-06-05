const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { MongoClient } = require("mongodb");
require("dotenv").config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN;
const API_ID      = parseInt(process.env.API_ID);
const API_HASH    = process.env.API_HASH;
const ADMIN_ID    = parseInt(process.env.ADMIN_ID);
const MONGO_URI   = process.env.MONGO_URI;

// တစ်ကောင်က တစ်ခုကို အနည်းဆုံး မိနစ်ဘယ်လောက်ကြာမှ ထပ်ပို့မလဲ
const MIN_INTERVAL_MINUTES = 59;

// ─── MONGODB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("gpbot");
  console.log("✅ MongoDB connected!");
}

async function getSettings() {
  return (await db.collection("settings").findOne({ _id: "main" })) || {};
}

async function saveSettings(data) {
  await db.collection("settings").updateOne(
    { _id: "main" },
    { $set: data },
    { upsert: true }
  );
}

async function getGPLinks() {
  const doc = await db.collection("settings").findOne({ _id: "main" });
  return doc?.gpLinks || [];
}

async function saveGPLinks(links) {
  await saveSettings({ gpLinks: links });
}

async function getAccounts() {
  return await db.collection("accounts").find({}).toArray();
}

async function getAccount(name) {
  return await db.collection("accounts").findOne({ name });
}

async function addAccount(name, sessionString) {
  await db.collection("accounts").updateOne(
    { name },
    { $set: { name, sessionString, active: true, addedAt: new Date() } },
    { upsert: true }
  );
}

async function removeAccount(name) {
  await db.collection("accounts").deleteOne({ name });
  // clean up send logs for this account
  await db.collection("sendlogs").deleteMany({ accName: name });
}

// last sent time: { accName, gpLink } → timestamp
async function getLastSent(accName, gpLink) {
  const doc = await db.collection("sendlogs").findOne({ accName, gpLink });
  return doc?.sentAt || null;
}

async function updateLastSent(accName, gpLink) {
  await db.collection("sendlogs").updateOne(
    { accName, gpLink },
    { $set: { accName, gpLink, sentAt: new Date() } },
    { upsert: true }
  );
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let autoMessage     = "";
let intervalMinutes = 0;
let schedulerTimer  = null;
let isSending       = false;

// TelegramClient pool: { name -> client }
const clientPool = {};

// pending account name waiting for session file
const pendingAccountName = {};

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
}
function adminOnly(ctx, next) {
  if (!isAdmin(ctx)) return ctx.reply("❌ Admin only.");
  return next();
}

// random delay between min~max seconds
function randomDelay(minSec = 3, maxSec = 8) {
  const ms = (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
  return new Promise((r) => setTimeout(r, ms));
}

// spin syntax: မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို → randomly pick one
function spinMessage(template) {
  return template.replace(/\{spin\}/g, () => "|").split("|").map(s => s.trim());
}

function pickSpun(template) {
  const parts = template.split("{spin}").map(s => s.trim());
  if (parts.length === 1) return template;
  // build variations: first word spins, rest stays
  // Format: word1{spin}word2{spin}word3 rest of message
  // We treat everything before first non-spin as the spinning part
  // Simple approach: split by {spin}, pick random from array, rejoin if needed
  // Actually: "ဟေး{spin}မင်္ဂလာ ညည်..." → ["ဟေး","မင်္ဂလာ ညည်..."]
  // If 2 parts: spin[0] randomly chosen, rest is parts[1]
  // If multiple {spin}: all segments random-picked as full message variants
  const idx = Math.floor(Math.random() * parts.length);
  return parts[idx];
}

// check if enough time passed since last send (per acc per gp)
async function canSend(accName, gpLink) {
  const lastSent = await getLastSent(accName, gpLink);
  if (!lastSent) return true;
  const diffMinutes = (Date.now() - new Date(lastSent).getTime()) / 60000;
  return diffMinutes >= MIN_INTERVAL_MINUTES;
}

async function buildClient(sessionString) {
  const client = new TelegramClient(
    new StringSession(sessionString),
    API_ID, API_HASH,
    { connectionRetries: 5 }
  );
  await client.connect();
  return client;
}

async function initAllClients() {
  const accounts = await getAccounts();
  for (const acc of accounts) {
    if (!clientPool[acc.name]) {
      try {
        clientPool[acc.name] = await buildClient(acc.sessionString);
        console.log(`✅ Account connected: ${acc.name}`);
      } catch (e) {
        console.error(`❌ Failed: ${acc.name} — ${e.message}`);
      }
    }
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (intervalMinutes <= 0) return;
  schedulerTimer = setInterval(async () => {
    const gpLinks = await getGPLinks();
    if (!autoMessage || gpLinks.length === 0) return;
    await sendToAllGPs();
  }, intervalMinutes * 60 * 1000);
  console.log(`⏰ Scheduler: every ${intervalMinutes} min`);
}

// ─── CORE SEND FUNCTION ───────────────────────────────────────────────────────
async function sendToAllGPs(forceSkipRateLimit = false) {
  if (isSending) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ ပို့နေဆဲ ရှိသေးသည်၊ ခဏစောင့်ပါ။");
    return;
  }

  const gpLinks  = await getGPLinks();
  const accounts = Object.keys(clientPool);

  if (!autoMessage) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ Message မသတ်မှတ်ရသေး။ /msg ကိုသုံးပါ။");
    return;
  }
  if (gpLinks.length === 0) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ GP link မရှိသေး။ /gp ကိုသုံးပါ။");
    return;
  }
  if (accounts.length === 0) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ Account မရှိသေး။ /addaccount ကိုသုံးပါ။");
    return;
  }

  isSending = true;
  let successCount = 0;
  let failCount    = 0;
  let skipCount    = 0;

  await bot.telegram.sendMessage(
    ADMIN_ID,
    `🚀 GP ${gpLinks.length} ခုဆီ ပို့မည်...\n` +
    `👤 Account ${accounts.length} ခု ရှိသည်\n` +
    `⏱ Random delay: 3~8 sec\n` +
    `🔒 Rate limit: ${MIN_INTERVAL_MINUTES} မိနစ်/တစ်ကြိမ်`
  );

  for (let i = 0; i < gpLinks.length; i++) {
    const link    = gpLinks[i];
    const num     = i + 1;
    const accName = accounts[i % accounts.length];
    const client  = clientPool[accName];

    // Rate limit check
    if (!forceSkipRateLimit) {
      const ok = await canSend(accName, link);
      if (!ok) {
        skipCount++;
        const lastSent  = await getLastSent(accName, link);
        const diffMin   = Math.floor((Date.now() - new Date(lastSent).getTime()) / 60000);
        const remaining = MIN_INTERVAL_MINUTES - diffMin;
        await bot.telegram.sendMessage(
          ADMIN_ID,
          `⏭ Skip ${num} — [${accName}]\n${link}\n⏰ ကျန်ချိန်: ${remaining} မိနစ်`
        );
        continue;
      }
    }

    // Pick spun message variant
    const msgToSend = pickSpun(autoMessage);

    try {
      const entity = await client.getEntity(link);
      await client.sendMessage(entity, { message: msgToSend });
      await updateLastSent(accName, link);
      successCount++;
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `✅ Send ${num} done — [${accName}]\n${link}`
      );
    } catch (err) {
      failCount++;
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `❌ Fail send ${num} — [${accName}]\n${link}\n⚠️ ${err.message}`
      );
    }

    // Random delay before next send (skip delay on last item)
    if (i < gpLinks.length - 1) {
      const delaySec = Math.floor(Math.random() * 6) + 3; // 3~8
      await bot.telegram.sendMessage(ADMIN_ID, `⏳ ${delaySec} sec စောင့်နေသည်...`);
      await randomDelay(3, 8);
    }
  }

  await bot.telegram.sendMessage(
    ADMIN_ID,
    `📊 ပြီးဆုံးပါပြီ။\n\n` +
    `✅ အောင်မြင်: ${successCount}\n` +
    `❌ မအောင်မြင်: ${failCount}\n` +
    `⏭ Skip (rate limit): ${skipCount}`
  );
  isSending = false;
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.start(adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  const gpLinks  = await getGPLinks();
  const connected = accounts.filter((a) => clientPool[a.name]).length;
  const sched = schedulerTimer && intervalMinutes > 0
    ? `🟢 ${intervalMinutes} မိနစ်တစ်ကြိမ်`
    : "🔴 မဖွင့်ရသေး";

  ctx.reply(
`👋 ကြိုဆိုပါတယ်! GP Auto Sender Bot 🤖

📊 လောလောဆယ် အခြေအနေ:
👤 Accounts: ${accounts.length} ခု (🟢 ${connected} connected)
🔗 GP Links: ${gpLinks.length} ခု
💬 Message: ${autoMessage ? `"${autoMessage.substring(0,30)}..."` : "⚠️ မသတ်မှတ်ရသေး"}
⏰ Scheduler: ${sched}

━━━━━━━━━━━━━━━━━━
👤 ACCOUNT Commands
━━━━━━━━━━━━━━━━━━
/accounts
  → ထည့်ထားတဲ့ account တွေစာရင်းကြည့်

/addaccount acc1
  → "acc1" ဆိုတဲ့နာမည်နဲ့ account ထည့်
  → Bot က session file တောင်းမည်
  → .txt file ပို့ရုံပဲ ✅

/removeaccount acc1
  → "acc1" account ဖျက်

/accountstatus
  → တစ်ကောင်ချင်း connected/disconnected ကြည့်

━━━━━━━━━━━━━━━━━━
🔗 GP LINK Commands
━━━━━━━━━━━━━━━━━━
/gp
  → ရှိပြီးသား GP link တွေကြည့်

/gp https://t.me/+xxx,https://t.me/+yyy
  → GP link တွေ comma ခြားပြီး တစ်ခါတည်းထည့်

/addgp https://t.me/+xxx
  → GP link တစ်ခုချင်းထပ်ထည့်

/removegp 2
  → နံပါတ် 2 GP link ဖျက်

/cleargp
  → GP link အကုန်ဖျက်

/editgp
  → edit menu ဖွင့်ကြည့်

━━━━━━━━━━━━━━━━━━
💬 MESSAGE Commands
━━━━━━━━━━━━━━━━━━
/msg မင်္ဂလာပါ ညီကိုများ ဖိတ်ပါတယ်
  → ပို့မည့် message သတ်မှတ်

/msg မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ညီကိုများ
  → {spin} ထည့်ရင် ပို့တိုင်း randomly ပြောင်းမည်
  → GP1: "မင်္ဂလာပါ ညီကိုများ"
  → GP2: "ဟေး ညီကိုများ"
  → GP3: "ဟယ်လို ညီကိုများ"
  → Spam filter မကျအောင် ✅

━━━━━━━━━━━━━━━━━━
⏰ SCHEDULER Commands
━━━━━━━━━━━━━━━━━━
/time 10min
  → 10 မိနစ်တိုင်း တစ်ကြိမ် auto ပို့
  → 24 နာရီ ပတ်လုံး အလိုအလျောက် ✅

/time stop
  → auto ပို့ ရပ်

/send
  → ချက်ချင်း တစ်ကြိမ်ပို့ (rate limit စစ်မည်)

/forcesend
  → rate limit မစစ်ဘဲ ချက်ချင်းအကုန်ပို့

/status
  → လောလောဆယ် settings + ကျန်ချိန် အကုန်ကြည့်

/ratelimit
  → GP တစ်ခုချင်း ဘယ်မိနစ်မှ ထပ်ပို့လို့ရမည် ကြည့်

━━━━━━━━━━━━━━━━━━
🛡 Spam Protection (auto)
━━━━━━━━━━━━━━━━━━
✅ Random delay: GP တိုင်းကြား 3~8 sec
✅ Rate limit: တစ်ကောင်က တစ်ခုကို ${MIN_INTERVAL_MINUTES} မိနစ်တစ်ကြိမ်
✅ Message spin: ပို့တိုင်း message ပြောင်း
✅ Round-robin: account တွေ rotate လုပ်ပို့

━━━━━━━━━━━━━━━━━━
📌 စတင်သုံးနည်း (အဆင့်)
━━━━━━━━━━━━━━━━━━
1️⃣ /addaccount acc1 → session file ပို့
2️⃣ /gp link1,link2,... → GP ထည့်
3️⃣ /msg စာသား → message သတ်မှတ်
4️⃣ /time 10min → auto ပို့ဖွင့်`
  );
});

// ─── ACCOUNT COMMANDS ─────────────────────────────────────────────────────────

bot.command("accounts", adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  if (accounts.length === 0) return ctx.reply("📭 Account မရှိသေး။\n\nထည့်ရန်: /addaccount (နာမည်)");
  const list = accounts.map((a, i) => {
    const status = clientPool[a.name] ? "🟢" : "🔴";
    return `${i + 1}. ${status} ${a.name}`;
  }).join("\n");
  ctx.reply(`👤 Accounts (${accounts.length} ခု):\n\n${list}\n\n🟢=connected 🔴=disconnected`);
});

bot.command("addaccount", adminOnly, async (ctx) => {
  const name = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!name) return ctx.reply("⚠️ Usage: /addaccount (နာမည်)\nဥပမာ: /addaccount acc1");
  pendingAccountName[ADMIN_ID] = name;
  ctx.reply(
    `📎 "${name}" အတွက် session file ပို့ပါ\n\n` +
    `get-session.js run ပြီးရတဲ့ string ကို\n` +
    `.txt file အဖြစ် save လုပ်ပြီး ဒီ chat မှာ ပို့ပါ`
  );
});

bot.command("removeaccount", adminOnly, async (ctx) => {
  const name = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!name) return ctx.reply("⚠️ Usage: /removeaccount (နာမည်)");
  const acc = await getAccount(name);
  if (!acc) return ctx.reply(`❌ "${name}" မတွေ့ပါ။`);
  if (clientPool[name]) {
    try { await clientPool[name].disconnect(); } catch (_) {}
    delete clientPool[name];
  }
  await removeAccount(name);
  ctx.reply(`🗑️ "${name}" ဖျက်ပြီးပါပြီ။`);
});

bot.command("accountstatus", adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  if (accounts.length === 0) return ctx.reply("📭 Account မရှိသေး။");
  const lines = accounts.map((a, i) => {
    const status = clientPool[a.name] ? "🟢 Connected" : "🔴 Disconnected";
    return `${i + 1}. ${a.name} — ${status}`;
  });
  ctx.reply(`📊 Account Status:\n\n${lines.join("\n")}`);
});

// ─── SESSION FILE HANDLER ─────────────────────────────────────────────────────

bot.on("document", adminOnly, async (ctx) => {
  const name = pendingAccountName[ADMIN_ID];
  if (!name) return ctx.reply("⚠️ /addaccount (နာမည်) ကို အရင်ရိုက်ပါ။");

  try {
    const fileId   = ctx.message.document.file_id;
    const fileInfo = await ctx.telegram.getFile(fileId);
    const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

    const https = require("https");
    const sessionString = await new Promise((resolve, reject) => {
      https.get(fileUrl, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data.trim()));
        res.on("error", reject);
      });
    });

    if (!sessionString || sessionString.length < 20) {
      return ctx.reply("❌ Session file မှားနေသည်။ ထပ်ကြိုးစားပါ။");
    }

    await ctx.reply(`⏳ "${name}" account ချိတ်နေသည်...`);
    const client = await buildClient(sessionString);
    clientPool[name] = client;
    await addAccount(name, sessionString);
    delete pendingAccountName[ADMIN_ID];

    ctx.reply(`✅ "${name}" connected ဖြစ်ပါပြီ! 🎉\n\n/accounts နိပ်ပြီးကြည့်နိုင်သည်။`);
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}\n\nSession string မှားနိုင်သည်။`);
  }
});

// ─── GP COMMANDS ──────────────────────────────────────────────────────────────

bot.command("gp", adminOnly, async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  const gpLinks = await getGPLinks();
  if (!args) {
    if (gpLinks.length === 0) return ctx.reply("📭 GP link မရှိသေး။\n\nထည့်ရန်: /gp link1,link2,...");
    const list = gpLinks.map((l, i) => `${i + 1}. ${l}`).join("\n");
    return ctx.reply(`📋 GP Links (${gpLinks.length} ခု):\n\n${list}`);
  }
  const newLinks = args.split(",").map((l) => l.trim()).filter(Boolean);
  await saveGPLinks(newLinks);
  const list = newLinks.map((l, i) => `${i + 1}. ${l}`).join("\n");
  ctx.reply(`✅ GP ${newLinks.length} ခု သတ်မှတ်ပြီးပါပြီ။\n\n${list}`);
});

bot.command("addgp", adminOnly, async (ctx) => {
  const link = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!link) return ctx.reply("⚠️ Usage: /addgp (link)");
  const gpLinks = await getGPLinks();
  gpLinks.push(link);
  await saveGPLinks(gpLinks);
  ctx.reply(`✅ ထည့်ပြီးပါပြီ။\n${link}\n\nစုစုပေါင်း GP: ${gpLinks.length} ခု`);
});

bot.command("removegp", adminOnly, async (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  const gpLinks = await getGPLinks();
  const idx = parseInt(arg) - 1;
  if (isNaN(idx) || idx < 0 || idx >= gpLinks.length) {
    return ctx.reply(`⚠️ Usage: /removegp (နံပါတ်)\n1 မှ ${gpLinks.length} အတွင်း`);
  }
  const removed = gpLinks.splice(idx, 1)[0];
  await saveGPLinks(gpLinks);
  ctx.reply(`🗑️ ဖျက်ပြီး:\n${removed}\n\nကျန် GP: ${gpLinks.length} ခု`);
});

bot.command("cleargp", adminOnly, async (ctx) => {
  await saveGPLinks([]);
  ctx.reply("🗑️ GP link အကုန် ဖျက်ပြီးပါပြီ။");
});

bot.command("editgp", adminOnly, async (ctx) => {
  const gpLinks = await getGPLinks();
  if (gpLinks.length === 0) return ctx.reply("📭 GP link မရှိသေး။");
  const list = gpLinks.map((l, i) => `${i + 1}. ${l}`).join("\n");
  ctx.reply(
    `📋 GP Links (${gpLinks.length} ခု):\n\n${list}\n\n` +
    `/addgp (link) — ထည့်ရန်\n` +
    `/removegp (နံပါတ်) — ဖျက်ရန်\n` +
    `/cleargp — အကုန်ဖျက်ရန်`
  );
});

// ─── MSG ──────────────────────────────────────────────────────────────────────

bot.command("msg", adminOnly, (ctx) => {
  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!text) {
    return ctx.reply(
      autoMessage
        ? `📝 လောလောဆယ် message:\n\n${autoMessage}\n\n` +
          `💡 Spin syntax: word1{spin}word2{spin}word3 rest\n` +
          `ပြောင်းရန်: /msg (message)`
        : `⚠️ Usage: /msg (message)\n\n` +
          `💡 Spin syntax ဥပမာ:\n` +
          `/msg မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ညီကိုများ ကျွန်တော်တို့ group ကိုဖိတ်ပါတယ်`
    );
  }
  autoMessage = text;

  // preview spin variants
  const parts = text.split("{spin}");
  let preview = `✅ Message သတ်မှတ်ပြီးပါပြီ:\n\n"${text}"`;
  if (parts.length > 1) {
    preview += `\n\n💡 Spin variants (${parts.length} မျိုး):\n`;
    parts.forEach((p, i) => { preview += `${i + 1}. "${p.trim()}..."\n`; });
  }
  ctx.reply(preview);
});

// ─── TIME / SEND / STATUS / RATELIMIT ─────────────────────────────────────────

bot.command("time", adminOnly, (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  if (!arg) {
    return ctx.reply(
      intervalMinutes > 0
        ? `⏰ Interval: ${intervalMinutes} မိနစ်တစ်ကြိမ် 🟢\n\nရပ်ရန်: /time stop`
        : "⚠️ Usage: /time (N)min\nဥပမာ: /time 10min"
    );
  }
  if (arg.toLowerCase() === "stop") {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    intervalMinutes = 0;
    saveSettings({ intervalMinutes: 0 }).catch(() => {});
    return ctx.reply("⏹️ Auto ပို့ ရပ်ပြီးပါပြီ။");
  }
  const match = arg.match(/^(\d+)min$/i);
  if (!match) return ctx.reply("⚠️ Format မှားသည်။ ဥပမာ: /time 10min");
  intervalMinutes = parseInt(match[1]);
  if (intervalMinutes < 1) return ctx.reply("⚠️ အနည်းဆုံး 1 မိနစ်");
  startScheduler();
  saveSettings({ intervalMinutes }).catch(() => {});
  ctx.reply(
    `✅ ${intervalMinutes} မိနစ်တိုင်း တစ်ကြိမ် auto ပို့မည် 🟢\n` +
    `🔒 Rate limit: တစ်ကောင်က တစ်ခုကို ${MIN_INTERVAL_MINUTES} မိနစ်တစ်ကြိမ်သာ\n\n` +
    `ရပ်ရန်: /time stop`
  );
});

bot.command("send", adminOnly, async (ctx) => {
  await ctx.reply("📤 GP တွေဆီ စတင်ပို့မည်... (rate limit စစ်မည်)");
  await sendToAllGPs(false);
});

bot.command("forcesend", adminOnly, async (ctx) => {
  await ctx.reply("⚡ Force send — rate limit မစစ်ဘဲ အကုန်ပို့မည်!");
  await sendToAllGPs(true);
});

bot.command("status", adminOnly, async (ctx) => {
  const gpLinks  = await getGPLinks();
  const accounts = await getAccounts();
  const connected = accounts.filter((a) => clientPool[a.name]).length;
  const accNames  = Object.keys(clientPool);

  const sched = schedulerTimer && intervalMinutes > 0
    ? `🟢 ${intervalMinutes} မိနစ်တစ်ကြိမ်`
    : "🔴 ပိတ်ထား";

  const parts = autoMessage.split("{spin}");
  const msgInfo = autoMessage
    ? `"${autoMessage.substring(0, 35)}..." (${parts.length} spin)`
    : "⚠️ မသတ်မှတ်ရသေး";

  // GP rate limit remaining per link
  let gpStatus = "";
  if (gpLinks.length > 0 && accNames.length > 0) {
    gpStatus += "\n\n━━━━━━━━━━━━━━━━━━\n📋 GP ကျန်ချိန်\n━━━━━━━━━━━━━━━━━━";
    for (let i = 0; i < gpLinks.length; i++) {
      const link     = gpLinks[i];
      const accName  = accNames[i % accNames.length];
      const lastSent = await getLastSent(accName, link);
      const shortLink = link.length > 30 ? link.substring(0, 30) + "..." : link;

      if (!lastSent) {
        gpStatus += `\n${i + 1}. ✅ အသင့်ဖြစ်ပြီ [${accName}]\n   ${shortLink}`;
      } else {
        const diffMin   = Math.floor((Date.now() - new Date(lastSent).getTime()) / 60000);
        const remaining = MIN_INTERVAL_MINUTES - diffMin;
        if (remaining <= 0) {
          gpStatus += `\n${i + 1}. ✅ အသင့်ဖြစ်ပြီ [${accName}]\n   ${shortLink}`;
        } else {
          gpStatus += `\n${i + 1}. ⏳ ${remaining} မိနစ်ကျန် [${accName}]\n   ${shortLink}`;
        }
      }
    }
  } else if (gpLinks.length === 0) {
    gpStatus = "\n\n⚠️ GP link မထည့်ရသေး — /gp link1,link2,...";
  } else {
    gpStatus = "\n\n⚠️ Account မထည့်ရသေး — /addaccount acc1";
  }

  ctx.reply(
    `📊 လောလောဆယ် Status\n\n` +
    `👤 Accounts: ${accounts.length} ခု (🟢 ${connected} connected)\n` +
    `🔗 GP Links: ${gpLinks.length} ခု\n` +
    `💬 Message: ${msgInfo}\n` +
    `⏰ Scheduler: ${sched}\n` +
    `🔒 Rate limit: ${MIN_INTERVAL_MINUTES} မိနစ်/တစ်ကြိမ်\n` +
    `⏱ Delay: 3~8 sec random\n` +
    `🔄 ပို့နေဆဲ: ${isSending ? "🔄 ဟုတ်" : "❌ မဟုတ်"}` +
    gpStatus
  );
});

bot.command("ratelimit", adminOnly, async (ctx) => {
  const gpLinks  = await getGPLinks();
  const accounts = Object.keys(clientPool);
  if (gpLinks.length === 0 || accounts.length === 0) {
    return ctx.reply("📭 GP link သို့မဟုတ် account မရှိသေး။");
  }

  let lines = [];
  for (let i = 0; i < gpLinks.length; i++) {
    const link    = gpLinks[i];
    const accName = accounts[i % accounts.length];
    const lastSent = await getLastSent(accName, link);
    if (!lastSent) {
      lines.push(`${i + 1}. [${accName}] ✅ မပို့ရသေး`);
    } else {
      const diffMin   = Math.floor((Date.now() - new Date(lastSent).getTime()) / 60000);
      const remaining = MIN_INTERVAL_MINUTES - diffMin;
      if (remaining <= 0) {
        lines.push(`${i + 1}. [${accName}] ✅ ပို့ပြီး ${diffMin} မိနစ် — အသင့်ဖြစ်ပြီ`);
      } else {
        lines.push(`${i + 1}. [${accName}] ⏳ ကျန်ချိန်: ${remaining} မိနစ်`);
      }
    }
  }
  ctx.reply(`📋 Rate Limit Status:\n\n${lines.join("\n")}`);
});

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────
const http = require("http");
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => { res.writeHead(200); res.end("GP Bot OK"); })
  .listen(PORT, () => console.log(`🌐 Health server: ${PORT}`));

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  http.get(url, (r) => console.log(`💓 ping ${r.statusCode}`)).on("error", () => {});
}, 14 * 60 * 1000);

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();

  const settings = await getSettings();
  if (settings.autoMessage)     autoMessage     = settings.autoMessage;
  if (settings.intervalMinutes) intervalMinutes = settings.intervalMinutes;

  await initAllClients();
  if (intervalMinutes > 0) startScheduler();

  await bot.launch();
  console.log("✅ Bot started!");

  await bot.telegram.sendMessage(
    ADMIN_ID,
    "✅ GP Auto Sender Bot အသင့်ဖြစ်ပြီ!\n\n/start နိပ်ပါ။"
  );

  // persist msg on every update
  bot.use(async (ctx, next) => {
    await next();
    if (autoMessage) await saveSettings({ autoMessage }).catch(() => {});
  });

  process.once("SIGINT",  () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch(console.error);
