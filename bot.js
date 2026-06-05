const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { ConnectionTCPMTProxyAbridged } = require("telegram/network/connection/TCPMTProxy");
const { MongoClient } = require("mongodb");
require("dotenv").config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID    = parseInt(process.env.API_ID);
const API_HASH  = process.env.API_HASH;
const ADMIN_ID  = parseInt(process.env.ADMIN_ID);
const MONGO_URI = process.env.MONGO_URI;

// ─── MONGODB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("gpbot");
  console.log("✅ MongoDB connected!");
}

// Settings (global)
async function getGlobalSettings() {
  return (await db.collection("settings").findOne({ _id: "main" })) || {};
}
async function saveGlobalSettings(data) {
  await db.collection("settings").updateOne({ _id: "main" }, { $set: data }, { upsert: true });
}

// Accounts
async function getAccounts() {
  return await db.collection("accounts").find({}).sort({ order: 1, addedAt: 1 }).toArray();
}
async function getAccount(name) {
  return await db.collection("accounts").findOne({ name });
}
async function saveAccount(name, data) {
  await db.collection("accounts").updateOne({ name }, { $set: data }, { upsert: true });
}
async function deleteAccount(name) {
  await db.collection("accounts").deleteOne({ name });
  await db.collection("sendlogs").deleteMany({ accName: name });
}

// GP links per account
async function getAccGPs(accName) {
  const acc = await getAccount(accName);
  return acc?.gpLinks || [];
}
async function saveAccGPs(accName, links) {
  await saveAccount(accName, { gpLinks: links });
}

// Message per account (fallback to global)
async function getAccMsg(accName, globalMsg) {
  const acc = await getAccount(accName);
  return acc?.customMsg || globalMsg || "";
}

// Send log (rate limit)
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
let globalMsg        = "";
let intervalMinutes  = 59;  // default 59 min
let schedulerTimer   = null;
let isSending        = false;
let sendDelaySeconds = 6;   // delay between each GP send

const clientPool = {};           // { accName -> TelegramClient }
const pendingAdd = {};           // { adminId -> accName } waiting session file

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

function isAdmin(ctx) { return ctx.from?.id === ADMIN_ID; }
function adminOnly(ctx, next) {
  if (!isAdmin(ctx)) return ctx.reply("❌ Admin only.");
  return next();
}

function pickSpun(template) {
  const parts = template.split("{spin}").map(s => s.trim());
  return parts[Math.floor(Math.random() * parts.length)];
}

async function buildClient(sessionString) {
  const client = new TelegramClient(
    new StringSession(sessionString), API_ID, API_HASH,
    {
      connectionRetries: 10,
      retryDelay: 2000,
      autoReconnect: true,
      useWSS: false,
      timeout: 30,
      requestRetries: 5,
      floodSleepThreshold: 60,
    }
  );
  await client.connect();

  // Keep alive ping every 60s to prevent TIMEOUT disconnect
  const keepAliveInterval = setInterval(async () => {
    try {
      if (client.connected) {
        await client.getMe();
      }
    } catch (e) {
      console.log(`[keepalive] reconnecting...`);
      try { await client.connect(); } catch (_) {}
    }
  }, 60 * 1000);

  client._keepAliveInterval = keepAliveInterval;
  return client;
}

async function initAllClients() {
  const accounts = await getAccounts();
  for (const acc of accounts) {
    if (!clientPool[acc.name]) {
      try {
        clientPool[acc.name] = await buildClient(acc.sessionString);
        console.log(`✅ Connected: ${acc.name}`);
      } catch (e) {
        console.error(`❌ Failed: ${acc.name} — ${e.message}`);
      }
    }
  }
}

function sleep(sec) {
  return new Promise(r => setTimeout(r, sec * 1000));
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (intervalMinutes <= 0) return;
  schedulerTimer = setInterval(async () => {
    if (!isSending) await sendAllAccounts(false);
  }, intervalMinutes * 60 * 1000);
  console.log(`⏰ Scheduler: every ${intervalMinutes} min`);
}

// ─── CORE SEND ────────────────────────────────────────────────────────────────
async function sendAllAccounts(force = false) {
  if (isSending) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ ပို့နေဆဲ ရှိသေးသည်၊ ခဏစောင့်ပါ။");
    return;
  }

  const accounts = await getAccounts();
  const activeAccs = accounts.filter(a => clientPool[a.name]);

  if (activeAccs.length === 0) {
    await bot.telegram.sendMessage(ADMIN_ID, "⚠️ Connected account မရှိသေး။");
    return;
  }

  isSending = true;
  let totalSuccess = 0, totalFail = 0, totalSkip = 0;

  await bot.telegram.sendMessage(ADMIN_ID,
    `🚀 ပို့မည်...\n👤 Active accounts: ${activeAccs.length} ခု\n⏱ Delay: ${sendDelaySeconds}s`
  );

  for (const acc of activeAccs) {
    const client  = clientPool[acc.name];
    const gpLinks = await getAccGPs(acc.name);
    const msg     = await getAccMsg(acc.name, globalMsg);

    if (gpLinks.length === 0) {
      await bot.telegram.sendMessage(ADMIN_ID,
        `⏭ [${acc.name}] GP link မရှိသေး — skip`
      );
      continue;
    }
    if (!msg) {
      await bot.telegram.sendMessage(ADMIN_ID,
        `⏭ [${acc.name}] Message မသတ်မှတ်ရသေး — skip`
      );
      continue;
    }

    await bot.telegram.sendMessage(ADMIN_ID,
      `\n▶️ [${acc.name}] GP ${gpLinks.length} ခုဆီ ပို့မည်...`
    );

    let accSuccess = 0, accFail = 0, accSkip = 0;

    for (let i = 0; i < gpLinks.length; i++) {
      const link = gpLinks[i];
      const num  = i + 1;

      // rate limit check
      if (!force) {
        const lastSent = await getLastSent(acc.name, link);
        if (lastSent) {
          const diffMin = (Date.now() - new Date(lastSent).getTime()) / 60000;
          if (diffMin < intervalMinutes) {
            const remaining = Math.ceil(intervalMinutes - diffMin);
            accSkip++;
            await bot.telegram.sendMessage(ADMIN_ID,
              `⏭ Skip ${num} — [${acc.name}]\n⏳ ကျန်ချိန်: ${remaining} မိနစ်`
            );
            if (i < gpLinks.length - 1) await sleep(1);
            continue;
          }
        }
      }

      const msgToSend = pickSpun(msg);

      try {
        const entity = await client.getEntity(link);
        await client.sendMessage(entity, { message: msgToSend });
        await updateLastSent(acc.name, link);
        accSuccess++;
        totalSuccess++;
        await bot.telegram.sendMessage(ADMIN_ID,
          `✅ Send ${num} done — [${acc.name}]`
        );
      } catch (err) {
        accFail++;
        totalFail++;
        await bot.telegram.sendMessage(ADMIN_ID,
          `❌ Fail ${num} — [${acc.name}]\n⚠️ ${err.message}`
        );
      }

      if (i < gpLinks.length - 1) {
        await bot.telegram.sendMessage(ADMIN_ID, `⏳ ${sendDelaySeconds}s စောင့်နေသည်...`);
        await sleep(sendDelaySeconds);
      }
    }

    await bot.telegram.sendMessage(ADMIN_ID,
      `📊 [${acc.name}] ပြီး — ✅${accSuccess} ❌${accFail} ⏭${accSkip}`
    );
  }

  await bot.telegram.sendMessage(ADMIN_ID,
    `\n🏁 အကုန်ပြီးပါပြီ\n✅ ${totalSuccess}  ❌ ${totalFail}  ⏭ ${totalSkip}`
  );
  isSending = false;
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  const connected = accounts.filter(a => clientPool[a.name]).length;
  const sched = schedulerTimer ? `🟢 ${intervalMinutes} မိနစ်တစ်ကြိမ်` : "🔴 ပိတ်";

  ctx.reply(
`👋 GP Auto Sender Bot 🤖

📊 အခြေအနေ:
👤 Accounts: ${accounts.length} (🟢${connected} connected)
💬 Global msg: ${globalMsg ? `"${globalMsg.substring(0,25)}..."` : "⚠️ မသတ်မှတ်ရသေး"}
⏰ Scheduler: ${sched}
⏱ Delay: ${sendDelaySeconds}s | 🔒 Interval: ${intervalMinutes} မိနစ်

━━━━━━━━━━━━━━━━━━
👤 ACCOUNT
━━━━━━━━━━━━━━━━━━
/accounts — စာရင်းကြည့်
/addaccount acc1 — account ထည့် (session file ပို့ရမည်)
/removeaccount acc1 — ဖျက်
/accountstatus — connected status

━━━━━━━━━━━━━━━━━━
🔗 GP (per account)
━━━━━━━━━━━━━━━━━━
/checkaccount1 — acc1 ရဲ့ GP, msg, ကျန်ချိန် ကြည့်
/acc1gp link1,link2 — acc1 ရဲ့ GP သတ်မှတ်
/acc1addgp link — acc1 ကို GP တစ်ခုထည့်
/acc1removegp 2 — acc1 ရဲ့ နံပါတ် 2 GP ဖျက်
/acc1cleargp — acc1 ရဲ့ GP အကုန်ဖျက်

━━━━━━━━━━━━━━━━━━
💬 MESSAGE
━━━━━━━━━━━━━━━━━━
/msg စာသား — global msg (account အကုန်သုံး)
/acc1msg စာသား — acc1 သီးသန့် msg
  💡 Spin: မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ညည်...

━━━━━━━━━━━━━━━━━━
⚙️ SETTINGS
━━━━━━━━━━━━━━━━━━
/setinterval 59min — rate limit ပြောင်း (e.g. 2hr, 30min)
/setdelay 6 — GP တိုင်းကြား delay seconds ပြောင်း

━━━━━━━━━━━━━━━━━━
📤 SEND
━━━━━━━━━━━━━━━━━━
/send — rate limit စစ်ပြီးပို့
/forcesend — rate limit မစစ်ဘဲ အကုန်ပို့
/time 60min — scheduler ဖွင့်
/time stop — scheduler ရပ်
/status — လောလောဆယ် status အကုန်

━━━━━━━━━━━━━━━━━━
🤝 GP JOIN
━━━━━━━━━━━━━━━━━━
/joingp link1,link2,... — account အကုန် join
/joingp acc1 link1,link2 — acc1 တစ်ကောင်တည်း join
  (join တိုင်းကြား 3s delay ပါမည်)

━━━━━━━━━━━━━━━━━━
📌 စတင်သုံးနည်း
━━━━━━━━━━━━━━━━━━
1️⃣ /addaccount acc1 → file ပို့
2️⃣ /joingp link1,link2 → GP join
3️⃣ /acc1gp link1,link2 → GP send list ထည့်
4️⃣ /msg မင်္ဂလာပါ (သို့) /acc1msg ...
5️⃣ /time 60min → scheduler ဖွင့်`
  );
});

// ─── ACCOUNT COMMANDS ─────────────────────────────────────────────────────────
bot.command("accounts", adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  if (accounts.length === 0) return ctx.reply("📭 Account မရှိသေး။\n/addaccount acc1");
  const list = accounts.map((a, i) => {
    const st = clientPool[a.name] ? "🟢" : "🔴";
    const gps = (a.gpLinks || []).length;
    const hasMsg = a.customMsg ? "💬" : "";
    return `${i+1}. ${st} ${a.name} — GP:${gps} ${hasMsg}`;
  }).join("\n");
  ctx.reply(`👤 Accounts (${accounts.length}):\n\n${list}\n\n🟢=on 🔴=off 💬=custom msg`);
});

bot.command("addaccount", adminOnly, async (ctx) => {
  const name = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!name) return ctx.reply("⚠️ Usage: /addaccount acc1");
  pendingAdd[ADMIN_ID] = name;
  ctx.reply(`📎 "${name}" အတွက် session .txt file ပို့ပါ`);
});

bot.command("removeaccount", adminOnly, async (ctx) => {
  const name = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!name) return ctx.reply("⚠️ Usage: /removeaccount acc1");
  if (!(await getAccount(name))) return ctx.reply(`❌ "${name}" မတွေ့ပါ။`);
  if (clientPool[name]) {
    try {
      if (clientPool[name]._keepAliveInterval) clearInterval(clientPool[name]._keepAliveInterval);
      await clientPool[name].disconnect();
    } catch(_){}
    delete clientPool[name];
  }
  await deleteAccount(name);
  ctx.reply(`🗑️ "${name}" ဖျက်ပြီးပါပြီ။`);
});

bot.command("accountstatus", adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  if (accounts.length === 0) return ctx.reply("📭 Account မရှိသေး။");
  const lines = accounts.map((a, i) =>
    `${i+1}. ${a.name} — ${clientPool[a.name] ? "🟢 Connected" : "🔴 Disconnected"}`
  );
  ctx.reply(`📊 Account Status:\n\n${lines.join("\n")}`);
});

// session file upload
bot.on("document", adminOnly, async (ctx) => {
  const name = pendingAdd[ADMIN_ID];
  if (!name) return ctx.reply("⚠️ /addaccount acc1 ကို အရင်ရိုက်ပါ။");
  try {
    const info = await ctx.telegram.getFile(ctx.message.document.file_id);
    const url  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
    const https = require("https");
    const sessionStr = await new Promise((res, rej) => {
      https.get(url, r => {
        let d = ""; r.on("data", c => d += c); r.on("end", () => res(d.trim())); r.on("error", rej);
      });
    });
    if (!sessionStr || sessionStr.length < 20) return ctx.reply("❌ File မှားနေသည်။");
    await ctx.reply(`⏳ "${name}" ချိတ်နေသည်...`);
    const client = await buildClient(sessionStr);
    clientPool[name] = client;
    const accounts = await getAccounts();
    await saveAccount(name, {
      name, sessionString: sessionStr, active: true,
      gpLinks: [], customMsg: "", order: accounts.length, addedAt: new Date()
    });
    delete pendingAdd[ADMIN_ID];
    ctx.reply(`✅ "${name}" connected! 🎉\n\n/acc${name.replace(/\D/g,'')}gp link1,link2 နဲ့ GP ထည့်ပါ`);
  } catch(err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

// ─── DYNAMIC ACCOUNT COMMANDS ─────────────────────────────────────────────────
// Handles: /check<name>, /acc<name>gp, /acc<name>addgp, /acc<name>removegp,
//          /acc<name>cleargp, /acc<name>msg, /acc<name>clearmsg

bot.on("text", adminOnly, async (ctx) => {
  if (!ctx.message?.text) return;
  const raw  = ctx.message.text.trim();
  // strip bot username if present e.g. /cmd@BotName
  const text = raw.replace(/@\w+/, "");

  // skip known static commands so bot.command() can handle them
  const knownCmds = [
    "/start","/accounts","/addaccount","/removeaccount","/accountstatus",
    "/msg","/setinterval","/setdelay","/time","/send","/forcesend",
    "/status","/joingp","/ratelimit"
  ];
  const base = text.split(" ")[0].toLowerCase();
  if (knownCmds.includes(base)) {
    console.log(`[text handler] skip known cmd: ${base}`);
    return;
  }

  console.log(`[text handler] received: ${text}`);

  const accounts = await getAccounts();

  for (const acc of accounts) {
    const n = acc.name; // e.g. "acc1"

    // ── /check<name>  e.g. /checkacc1
    if (text === `/check${n}`) {
      console.log(`[text handler] matched /check${n}`);
      const gpLinks  = await getAccGPs(n);
      const accDoc   = await getAccount(n);
      const msg      = await getAccMsg(n, globalMsg);
      const st       = clientPool[n] ? "🟢 Connected" : "🔴 Disconnected";
      let gpStatus   = gpLinks.length === 0
        ? "\n📭 GP link မရှိသေး"
        : `\n\n━━━━━━━━━━━━━━━━━━\n📋 GP List & ကျန်ချိန်\n━━━━━━━━━━━━━━━━━━`;

      for (let i = 0; i < gpLinks.length; i++) {
        const link     = gpLinks[i];
        const lastSent = await getLastSent(n, link);
        const short    = link.length > 35 ? link.substring(0,35)+"..." : link;
        if (!lastSent) {
          gpStatus += `\n${i+1}. ✅ ${short}`;
        } else {
          const diffMin   = (Date.now() - new Date(lastSent).getTime()) / 60000;
          const remaining = Math.ceil(intervalMinutes - diffMin);
          gpStatus += remaining <= 0
            ? `\n${i+1}. ✅ ${short}`
            : `\n${i+1}. ⏳ ${remaining}မိနစ်ကျန် ${short}`;
        }
      }
      return ctx.reply(
        `👤 [${n}] Status\n\n${st}\n` +
        `🔗 GP: ${gpLinks.length} ခု\n` +
        `💬 Msg: ${accDoc?.customMsg ? `"${accDoc.customMsg.substring(0,40)}" (custom)` : msg ? `"${msg.substring(0,40)}" (global)` : "⚠️ မသတ်မှတ်ရသေး"}` +
        gpStatus +
        `\n\n📝 Edit:\n/acc${n}gp link1,link2\n/acc${n}addgp link\n/acc${n}removegp 1\n/acc${n}msg စာသား`
      );
    }

    // ── /acc<name>gp <links>  e.g. /accacc1gp link1,link2
    if (text.startsWith(`/acc${n}gp `)) {
      console.log(`[text handler] matched /acc${n}gp set`);
      const args  = text.slice(`/acc${n}gp `.length).trim();
      const links = args.split(",").map(l => l.trim()).filter(Boolean);
      if (!links.length) return ctx.reply("⚠️ link ထည့်ပါ");
      await saveAccGPs(n, links);
      return ctx.reply(`✅ [${n}] GP ${links.length} ခု:\n\n${links.map((l,i)=>`${i+1}. ${l}`).join("\n")}`);
    }

    // ── /acc<name>gp alone — view
    if (text === `/acc${n}gp`) {
      console.log(`[text handler] matched /acc${n}gp view`);
      const links = await getAccGPs(n);
      if (!links.length) return ctx.reply(`📭 [${n}] GP မရှိသေး\n/acc${n}gp link1,link2`);
      return ctx.reply(`📋 [${n}] GP (${links.length}):\n\n${links.map((l,i)=>`${i+1}. ${l}`).join("\n")}`);
    }

    // ── /acc<name>addgp <link>
    if (text.startsWith(`/acc${n}addgp `)) {
      console.log(`[text handler] matched /acc${n}addgp`);
      const link  = text.slice(`/acc${n}addgp `.length).trim();
      if (!link) return ctx.reply("⚠️ link ထည့်ပါ");
      const links = await getAccGPs(n);
      links.push(link);
      await saveAccGPs(n, links);
      return ctx.reply(`✅ [${n}] GP ထည့်ပြီး:\n${link}\n\nစုစုပေါင်း: ${links.length}`);
    }

    // ── /acc<name>removegp <num>
    if (text.startsWith(`/acc${n}removegp `)) {
      console.log(`[text handler] matched /acc${n}removegp`);
      const num   = parseInt(text.split(" ")[1]);
      const links = await getAccGPs(n);
      const idx   = num - 1;
      if (isNaN(idx) || idx < 0 || idx >= links.length)
        return ctx.reply(`⚠️ 1 မှ ${links.length} ထိ နံပါတ်ထည့်ပါ`);
      const removed = links.splice(idx, 1)[0];
      await saveAccGPs(n, links);
      return ctx.reply(`🗑️ [${n}] ဖျက်ပြီး:\n${removed}\n\nကျန်: ${links.length}`);
    }

    // ── /acc<name>cleargp
    if (text === `/acc${n}cleargp`) {
      console.log(`[text handler] matched /acc${n}cleargp`);
      await saveAccGPs(n, []);
      return ctx.reply(`🗑️ [${n}] GP အကုန်ဖျက်ပြီး`);
    }

    // ── /acc<name>msg <text>
    if (text.startsWith(`/acc${n}msg `)) {
      console.log(`[text handler] matched /acc${n}msg set`);
      const msg   = text.slice(`/acc${n}msg `.length).trim();
      await saveAccount(n, { customMsg: msg });
      const parts = msg.split("{spin}");
      return ctx.reply(
        `✅ [${n}] Custom message:\n\n"${msg}"` +
        (parts.length > 1 ? `\n\n💡 Spin ${parts.length} မျိုး` : "")
      );
    }

    // ── /acc<name>msg alone — view
    if (text === `/acc${n}msg`) {
      console.log(`[text handler] matched /acc${n}msg view`);
      const accDoc = await getAccount(n);
      return ctx.reply(
        accDoc?.customMsg
          ? `💬 [${n}] Custom msg:\n\n"${accDoc.customMsg}"\n\nဖျက်ရန်: /acc${n}clearmsg`
          : `💬 [${n}] Custom msg မသတ်မှတ်ရသေး (global သုံးနေသည်)\n\nသတ်မှတ်ရန်: /acc${n}msg စာသား`
      );
    }

    // ── /acc<name>clearmsg
    if (text === `/acc${n}clearmsg`) {
      console.log(`[text handler] matched /acc${n}clearmsg`);
      await saveAccount(n, { customMsg: "" });
      return ctx.reply(`🗑️ [${n}] Custom msg ဖျက်ပြီး (global msg ကိုပြန်သုံးမည်)`);
    }
  }

  // no match — log it
  console.log(`[text handler] no match for: ${text}`);
});

// ─── GLOBAL MSG ───────────────────────────────────────────────────────────────

// ─── GLOBAL MSG ───────────────────────────────────────────────────────────────
bot.command("msg", adminOnly, (ctx) => {
  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!text) {
    return ctx.reply(
      globalMsg
        ? `💬 Global message:\n\n"${globalMsg}"\n\nပြောင်းရန်: /msg စာသား`
        : "⚠️ Usage: /msg စာသား\n\n💡 Spin: မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ..."
    );
  }
  globalMsg = text;
  saveGlobalSettings({ globalMsg }).catch(() => {});
  const parts = text.split("{spin}");
  ctx.reply(
    `✅ Global message:\n\n"${text}"` +
    (parts.length > 1 ? `\n\n💡 Spin ${parts.length} မျိုး:\n` + parts.map((p,i) => `${i+1}. "${p.trim()}"`).join("\n") : "")
  );
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
bot.command("setinterval", adminOnly, (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  if (!arg) return ctx.reply(`⚠️ Usage: /setinterval 59min (သို့) /setinterval 2hr\nလက်ရှိ: ${intervalMinutes} မိနစ်`);

  let mins = 0;
  const hrMatch  = arg.match(/^(\d+)hr$/i);
  const minMatch = arg.match(/^(\d+)min$/i);
  if (hrMatch)  mins = parseInt(hrMatch[1]) * 60;
  else if (minMatch) mins = parseInt(minMatch[1]);
  else return ctx.reply("⚠️ Format: 59min (သို့) 2hr");

  if (mins < 1) return ctx.reply("⚠️ အနည်းဆုံး 1 မိနစ်");
  intervalMinutes = mins;
  saveGlobalSettings({ intervalMinutes }).catch(() => {});
  if (schedulerTimer) startScheduler(); // restart with new interval
  ctx.reply(`✅ Rate limit & scheduler interval: ${mins} မိနစ် (${mins >= 60 ? (mins/60).toFixed(1)+"hr" : mins+"min"})`);
});

bot.command("setdelay", adminOnly, (ctx) => {
  const arg = parseInt(ctx.message.text.split(" ")[1]);
  if (isNaN(arg) || arg < 1) return ctx.reply("⚠️ Usage: /setdelay 6\n(seconds, အနည်းဆုံး 1)");
  sendDelaySeconds = arg;
  saveGlobalSettings({ sendDelaySeconds }).catch(() => {});
  ctx.reply(`✅ GP တိုင်းကြား delay: ${sendDelaySeconds} seconds`);
});

// ─── TIME / SEND ──────────────────────────────────────────────────────────────
bot.command("time", adminOnly, (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  if (!arg) return ctx.reply(
    schedulerTimer
      ? `⏰ Scheduler: ${intervalMinutes} မိနစ်တစ်ကြိမ် 🟢\n\nရပ်ရန်: /time stop`
      : "⚠️ Usage: /time 60min\nရပ်ရန်: /time stop"
  );
  if (arg.toLowerCase() === "stop") {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    return ctx.reply("⏹️ Scheduler ရပ်ပြီး။");
  }
  const hrM  = arg.match(/^(\d+)hr$/i);
  const minM = arg.match(/^(\d+)min$/i);
  let mins = 0;
  if (hrM)      mins = parseInt(hrM[1]) * 60;
  else if (minM) mins = parseInt(minM[1]);
  else return ctx.reply("⚠️ Format: /time 60min (သို့) /time 2hr");
  if (mins < 1) return ctx.reply("⚠️ အနည်းဆုံး 1 မိနစ်");
  intervalMinutes = mins;
  saveGlobalSettings({ intervalMinutes }).catch(() => {});
  startScheduler();
  ctx.reply(`✅ Scheduler: ${mins} မိနစ်တစ်ကြိမ် 🟢\n🔒 Rate limit: ${mins} မိနစ်\n\nရပ်ရန်: /time stop`);
});

bot.command("send", adminOnly, async (ctx) => {
  await ctx.reply("📤 ပို့မည်... (rate limit စစ်မည်)");
  await sendAllAccounts(false);
});

bot.command("forcesend", adminOnly, async (ctx) => {
  await ctx.reply("⚡ Force send — rate limit မစစ်ဘဲ အကုန်ပို့မည်!");
  await sendAllAccounts(true);
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
bot.command("status", adminOnly, async (ctx) => {
  const accounts = await getAccounts();
  const connected = accounts.filter(a => clientPool[a.name]).length;
  const sched = schedulerTimer ? `🟢 ${intervalMinutes} မိနစ်တစ်ကြိမ်` : "🔴 ပိတ်";

  let lines = `📊 Status\n\n`;
  lines += `👤 Accounts: ${accounts.length} (🟢${connected})\n`;
  lines += `💬 Global msg: ${globalMsg ? `"${globalMsg.substring(0,30)}..."` : "⚠️ မသတ်မှတ်ရသေး"}\n`;
  lines += `⏰ Scheduler: ${sched}\n`;
  lines += `🔒 Interval: ${intervalMinutes} မိနစ်\n`;
  lines += `⏱ Delay: ${sendDelaySeconds}s\n`;
  lines += `🔄 ပို့နေဆဲ: ${isSending ? "🔄 ဟုတ်" : "❌ မဟုတ်"}`;

  for (const acc of accounts) {
    const gpLinks = await getAccGPs(acc.name);
    const st      = clientPool[acc.name] ? "🟢" : "🔴";
    const msg     = acc.customMsg ? `custom` : `global`;
    lines += `\n\n━━━━━━━━━━━━━━━━━━\n${st} [${acc.name}] — GP:${gpLinks.length} msg:${msg}`;

    for (let i = 0; i < gpLinks.length; i++) {
      const link     = gpLinks[i];
      const lastSent = await getLastSent(acc.name, link);
      const short    = link.length > 30 ? link.substring(0,30)+"..." : link;
      if (!lastSent) {
        lines += `\n  ${i+1}. ✅ ${short}`;
      } else {
        const diffMin   = (Date.now() - new Date(lastSent).getTime()) / 60000;
        const remaining = Math.ceil(intervalMinutes - diffMin);
        lines += remaining <= 0
          ? `\n  ${i+1}. ✅ ${short}`
          : `\n  ${i+1}. ⏳${remaining}မိနစ် ${short}`;
      }
    }
  }

  ctx.reply(lines);
});


// ─── JOIN GP ──────────────────────────────────────────────────────────────────
// /joingp link1,link2,...           — account အကုန် join
// /joingp accname link1,link2,...   — တစ်ကောင်တည်းသာ join

let isJoining = false;

bot.command("joingp", adminOnly, async (ctx) => {
  if (isJoining) return ctx.reply("⚠️ Join လုပ်နေဆဲ ရှိသေးသည်။ ခဏစောင့်ပါ။");

  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) {
    return ctx.reply(
      "⚠️ Usage:\n\n" +
      "/joingp link1,link2 — account အကုန် join\n" +
      "/joingp acc1 link1,link2 — acc1 တစ်ကောင်တည်း join"
    );
  }

  const accounts = await getAccounts();
  const allNames = accounts.map(a => a.name);
  const parts    = args.split(" ");
  let targetAccs = [];
  let linksStr   = "";

  if (allNames.includes(parts[0])) {
    const accName = parts[0];
    if (!clientPool[accName]) return ctx.reply(`❌ "${accName}" connected မဟုတ်သေး။`);
    targetAccs = [accName];
    linksStr   = parts.slice(1).join(" ").trim();
  } else {
    const activeAccs = accounts.filter(a => clientPool[a.name]);
    if (activeAccs.length === 0) return ctx.reply("❌ Connected account မရှိသေး။");
    targetAccs = activeAccs.map(a => a.name);
    linksStr   = args;
  }

  const links = linksStr.split(",").map(l => l.trim()).filter(Boolean);
  if (links.length === 0) return ctx.reply("⚠️ GP link ထည့်ပါ။");

  isJoining = true;

  await ctx.reply(
    `🚀 Join စတင်မည်\n` +
    `👤 Accounts: ${targetAccs.join(", ")}\n` +
    `🔗 GP: ${links.length} ခု\n` +
    `⏱ Delay: 3s (join တိုင်းကြား)`
  );

  for (const accName of targetAccs) {
    const client = clientPool[accName];
    let success = 0, fail = 0, already = 0;

    await bot.telegram.sendMessage(ADMIN_ID, `\n▶️ [${accName}] Join စမည်...`);

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const num  = i + 1;

      try {
        const entity = await client.getEntity(link);
        await client.invoke(new (require("telegram/tl").Api.channels.JoinChannel)({ channel: entity }));
        success++;
        await bot.telegram.sendMessage(ADMIN_ID, `✅ Join ${num} done — [${accName}]\n${link}`);
      } catch (err) {
        const emsg = err.message || "";
        if (emsg.includes("USER_ALREADY_PARTICIPANT") || emsg.includes("already")) {
          already++;
          await bot.telegram.sendMessage(ADMIN_ID, `ℹ️ Join ${num} — [${accName}] Join ပြီးနေပြီ\n${link}`);
        } else {
          fail++;
          await bot.telegram.sendMessage(ADMIN_ID, `❌ Fail ${num} — [${accName}]\n${link}\n⚠️ ${emsg}`);
        }
      }

      if (i < links.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    await bot.telegram.sendMessage(ADMIN_ID,
      `📊 [${accName}] ပြီး — ✅${success} ❌${fail} ℹ️${already}(ပြီးနေပြီ)`
    );

    if (targetAccs.indexOf(accName) < targetAccs.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await bot.telegram.sendMessage(ADMIN_ID, "🏁 GP Join အကုန်ပြီးပါပြီ!");
  isJoining = false;
});

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end("OK"); })
  .listen(PORT, () => console.log(`🌐 Port ${PORT}`));
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  http.get(url, r => console.log(`💓 ${r.statusCode}`)).on("error", () => {});
}, 14 * 60 * 1000);

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();
  const s = await getGlobalSettings();
  if (s.globalMsg)        globalMsg        = s.globalMsg;
  if (s.intervalMinutes)  intervalMinutes  = s.intervalMinutes;
  if (s.sendDelaySeconds) sendDelaySeconds = s.sendDelaySeconds;

  await initAllClients();
  if (schedulerTimer === null && intervalMinutes > 0) {
    // don't auto-start scheduler on boot, wait for /time command
  }

  // Clear webhook and kill any existing polling sessions
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });

  // retry loop — if 409 conflict, wait 5s and retry
  let launched = false;
  let retryCount = 0;
  while (!launched) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      launched = true;
      console.log("✅ Bot started!");
    } catch (err) {
      if (err.response?.error_code === 409) {
        retryCount++;
        console.log(`⚠️ 409 Conflict — retry ${retryCount} in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        // force clear again
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      } else {
        throw err;
      }
    }
  }
  await bot.telegram.sendMessage(ADMIN_ID, "✅ GP Bot အသင့်ဖြစ်ပြီ!\n\n/start နိပ်ပါ။");

  process.once("SIGINT",  () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch(console.error);
