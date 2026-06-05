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
  const sched     = schedulerTimer ? `🟢 ${intervalMinutes} မိနစ်တစ်ကြိမ်` : "🔴 ပိတ်ထား";
  const msgStatus = globalMsg ? `"${globalMsg.substring(0,30)}..."` : "⚠️ မသတ်မှတ်ရသေး";

  // Message 1 — Status + Account + GP
  await ctx.reply(
`👋 GP Auto Sender Bot 🤖

━━━━━━━━━━━━━━━━━━
📊 လောလောဆယ် အခြေအနေ
━━━━━━━━━━━━━━━━━━
👤 Accounts  : ${accounts.length} ခု (🟢 ${connected} connected)
💬 Global msg: ${msgStatus}
⏰ Scheduler : ${sched}
⏱ Send delay : ${sendDelaySeconds}s
🔒 Rate limit: ${intervalMinutes} မိနစ်တစ်ကြိမ်

━━━━━━━━━━━━━━━━━━
👤 ACCOUNT Commands
━━━━━━━━━━━━━━━━━━
/accounts
  → account စာရင်းနဲ့ နံပါတ်တွေကြည့်

/addaccount မိဘ
  → "မိဘ" နာမည်နဲ့ account ထည့်
  → Bot က session .txt file တောင်းမည်
  → file ပို့ရုံပဲ — auto connect ဖြစ်မည်

/removeaccount မိဘ
  → "မိဘ" account ဖျက်

/accountstatus
  → account တိုင်း connected/disconnected ကြည့်

━━━━━━━━━━━━━━━━━━
🔗 GP Commands (နံပါတ်နဲ့သုံး)
━━━━━━━━━━━━━━━━━━
⚠️ /accounts နိပ်ပြီး account နံပါတ် သိပါ

/check1
  → account 1 ရဲ့ GP list, message, ကျန်ချိန် အကုန်ကြည့်

/1gp https://t.me/+xxx,https://t.me/+yyy
  → account 1 ရဲ့ GP link တွေ တစ်ခါတည်းသတ်မှတ်
  → comma ခြားပြီး အများကြီးထည့်လို့ရ

/1gp
  → account 1 ရဲ့ GP list ကြည့်

/1addgp https://t.me/+zzz
  → account 1 ကို GP link တစ်ခုထပ်ထည့်

/1removegp 2
  → account 1 ရဲ့ GP နံပါတ် 2 ဖျက်

/1cleargp
  → account 1 ရဲ့ GP link အကုန်ဖျက်

💡 Account 2 ဆိုရင် → /2gp, /check2, /2addgp ...
💡 Account 3 ဆိုရင် → /3gp, /check3, /3addgp ...`
  );

  // Message 2 — Message + Settings + Send + Join + Steps
  await ctx.reply(
`━━━━━━━━━━━━━━━━━━
💬 MESSAGE Commands
━━━━━━━━━━━━━━━━━━
/msg မင်္ဂလာပါ ညီကိုများ
  → account အကုန်အတွက် global message သတ်မှတ်
  → GP link မထည့်ရသေးတဲ့ account တွေပါ သုံးမည်

/msg
  → global message ကြည့်

/1msg မင်္ဂလာပါ ညီကိုများ
  → account 1 သီးသန့် message (global ထက် priority မြင့်)

/1msg
  → account 1 ရဲ့ message ကြည့်

/1clearmsg
  → account 1 custom msg ဖျက် (global ကိုပြန်သုံးမည်)

💡 Spin syntax — ပို့တိုင်း message ပြောင်းမည်
/msg မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ညီကိုများ
  GP1 → "မင်္ဂလာပါ ညီကိုများ"
  GP2 → "ဟေး ညီကိုများ"
  GP3 → "ဟယ်လို ညီကိုများ"
  (spam filter မကျအောင်) ✅

━━━━━━━━━━━━━━━━━━
⚙️ SETTINGS Commands
━━━━━━━━━━━━━━━━━━
/setinterval 59min
  → တစ်ကောင်က တစ်ခုကို ဘယ်နှ မိနစ်တစ်ကြိမ်ပို့မည် သတ်မှတ်
  → ဥပမာ: /setinterval 2hr (သို့) /setinterval 30min

/setdelay 6
  → GP တစ်ခုပြီး နောက်တစ်ခုပို့ဖို့ ကြားချိန် (seconds)
  → ဥပမာ: /setdelay 10

━━━━━━━━━━━━━━━━━━
🤝 GP JOIN Commands
━━━━━━━━━━━━━━━━━━
/joingp https://t.me/+xxx,https://t.me/+yyy
  → connected account အကုန်နဲ့ GP တွေ join
  → join တိုင်းကြား 3s delay ပါမည်

/joingp မိဘ https://t.me/+xxx,https://t.me/+yyy
  → "မိဘ" account တစ်ကောင်တည်းသာ join

━━━━━━━━━━━━━━━━━━
📤 SEND Commands
━━━━━━━━━━━━━━━━━━
/send
  → rate limit စစ်ပြီး ပို့ (ကြာနိုင်)
  → 59 မိနစ်မပြည့်သေးရင် skip ဖြစ်မည်

/forcesend
  → rate limit မစစ်ဘဲ ချက်ချင်းအကုန်ပို့

/time 60min
  → 60 မိနစ်တစ်ကြိမ် 24hr ပတ်လုံး auto ပို့
  → ဥပမာ: /time 2hr (သို့) /time 30min

/time stop
  → auto ပို့ ရပ်

/status
  → account တိုင်း GP တိုင်း ကျန်ချိန် အကုန်ကြည့်

━━━━━━━━━━━━━━━━━━
📌 စတင်သုံးနည်း (အဆင့်)
━━━━━━━━━━━━━━━━━━
1️⃣ /addaccount မိဘ
   → Bot က file တောင်းမည် → session .txt ပို့

2️⃣ /joingp link1,link2,...
   → GP တွေကို account တွေနဲ့ join

3️⃣ /1gp link1,link2,...
   → account 1 ရဲ့ ပို့မည့် GP list ထည့်

4️⃣ /msg မင်္ဂလာပါ{spin}ဟေး ညီကိုများ
   → message သတ်မှတ် (spin ထည့်ရင် ပိုကောင်း)

5️⃣ /setinterval 60min
   → rate limit သတ်မှတ်

6️⃣ /time 60min
   → scheduler ဖွင့် — အလိုအလျောက် ပို့နေမည် ✅

🛡 Spam Protection (auto ပါမည်)
✅ Random delay: GP တိုင်းကြား ${sendDelaySeconds}s
✅ Rate limit: တစ်ကောင်က တစ်ခုကို ${intervalMinutes} မိနစ်တစ်ကြိမ်
✅ Message spin: ပို့တိုင်း message ပြောင်း
✅ Sequential send: ACC1 ပြီးမှ ACC2`
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
// Pattern: /1gp  /1addgp  /1removegp  /1cleargp  /1msg  /1clearmsg  /check1
// Number = account index (1-based) in accounts list order

bot.on("text", adminOnly, async (ctx) => {
  if (!ctx.message?.text) return;
  const raw  = ctx.message.text.trim().replace(/@\w+/, "");
  const text = raw;

  const knownCmds = [
    "/start","/accounts","/addaccount","/removeaccount","/accountstatus",
    "/msg","/setinterval","/setdelay","/time","/send","/forcesend",
    "/status","/joingp","/ratelimit"
  ];
  const base = text.split(" ")[0].toLowerCase();
  if (knownCmds.includes(base)) {
    console.log(`[cmd] skip: ${base}`);
    return;
  }

  console.log(`[cmd] received: ${text}`);

  const accounts = await getAccounts();

  // helper: get account by 1-based index number
  function getAccByNum(numStr) {
    const idx = parseInt(numStr) - 1;
    if (isNaN(idx) || idx < 0 || idx >= accounts.length) return null;
    return accounts[idx];
  }

  // ── /check<N>  e.g. /check1  /check2
  const checkM = text.match(/^\/check(\d+)$/);
  if (checkM) {
    const acc = getAccByNum(checkM[1]);
    if (!acc) return ctx.reply(`❌ Account ${checkM[1]} မတွေ့ပါ။\nရှိသည့် account: ${accounts.length} ခု`);
    const n        = acc.name;
    const gpLinks  = await getAccGPs(n);
    const accDoc   = await getAccount(n);
    const msg      = await getAccMsg(n, globalMsg);
    const st       = clientPool[n] ? "🟢 Connected" : "🔴 Disconnected";
    let gpStatus   = gpLinks.length === 0
      ? "\n📭 GP link မရှိသေး"
      : "\n\n━━━━━━━━━━━━━━━━━━\n📋 GP List & ကျန်ချိန်\n━━━━━━━━━━━━━━━━━━";
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
    const num = checkM[1];
    return ctx.reply(
      `👤 [${n}] (#${num}) Status\n\n${st}\n` +
      `🔗 GP: ${gpLinks.length} ခု\n` +
      `💬 Msg: ${accDoc?.customMsg ? `"${accDoc.customMsg.substring(0,40)}" (custom)` : msg ? `"${msg.substring(0,40)}" (global)` : "⚠️ မသတ်မှတ်ရသေး"}` +
      gpStatus +
      `\n\n📝 Edit:\n/${num}gp link1,link2\n/${num}addgp link\n/${num}removegp 1\n/${num}msg စာသား`
    );
  }

  // ── /<N>gp <links>  set GP list
  const gpSetM = text.match(/^\/(\d+)gp (.+)$/);
  if (gpSetM) {
    const acc = getAccByNum(gpSetM[1]);
    if (!acc) return ctx.reply(`❌ Account ${gpSetM[1]} မတွေ့ပါ။`);
    const links = gpSetM[2].split(",").map(l => l.trim()).filter(Boolean);
    if (!links.length) return ctx.reply("⚠️ link ထည့်ပါ");
    await saveAccGPs(acc.name, links);
    return ctx.reply(`✅ [${acc.name}] GP ${links.length} ခု:\n\n${links.map((l,i)=>`${i+1}. ${l}`).join("\n")}`);
  }

  // ── /<N>gp  view GP list
  const gpViewM = text.match(/^\/(\d+)gp$/);
  if (gpViewM) {
    const acc = getAccByNum(gpViewM[1]);
    if (!acc) return ctx.reply(`❌ Account ${gpViewM[1]} မတွေ့ပါ။`);
    const links = await getAccGPs(acc.name);
    if (!links.length) return ctx.reply(`📭 [${acc.name}] GP မရှိသေး\n/${gpViewM[1]}gp link1,link2`);
    return ctx.reply(`📋 [${acc.name}] GP (${links.length}):\n\n${links.map((l,i)=>`${i+1}. ${l}`).join("\n")}`);
  }

  // ── /<N>addgp <link>
  const addGpM = text.match(/^\/(\d+)addgp (.+)$/);
  if (addGpM) {
    const acc = getAccByNum(addGpM[1]);
    if (!acc) return ctx.reply(`❌ Account ${addGpM[1]} မတွေ့ပါ။`);
    const link  = addGpM[2].trim();
    const links = await getAccGPs(acc.name);
    links.push(link);
    await saveAccGPs(acc.name, links);
    return ctx.reply(`✅ [${acc.name}] GP ထည့်ပြီး:\n${link}\n\nစုစုပေါင်း: ${links.length}`);
  }

  // ── /<N>removegp <num>
  const rmGpM = text.match(/^\/(\d+)removegp (\d+)$/);
  if (rmGpM) {
    const acc   = getAccByNum(rmGpM[1]);
    if (!acc) return ctx.reply(`❌ Account ${rmGpM[1]} မတွေ့ပါ။`);
    const links = await getAccGPs(acc.name);
    const idx   = parseInt(rmGpM[2]) - 1;
    if (idx < 0 || idx >= links.length)
      return ctx.reply(`⚠️ 1 မှ ${links.length} ထိ နံပါတ်ထည့်ပါ`);
    const removed = links.splice(idx, 1)[0];
    await saveAccGPs(acc.name, links);
    return ctx.reply(`🗑️ [${acc.name}] ဖျက်ပြီး:\n${removed}\n\nကျန်: ${links.length}`);
  }

  // ── /<N>cleargp
  const clrGpM = text.match(/^\/(\d+)cleargp$/);
  if (clrGpM) {
    const acc = getAccByNum(clrGpM[1]);
    if (!acc) return ctx.reply(`❌ Account ${clrGpM[1]} မတွေ့ပါ။`);
    await saveAccGPs(acc.name, []);
    return ctx.reply(`🗑️ [${acc.name}] GP အကုန်ဖျက်ပြီး`);
  }

  // ── /<N>msg <text>  set custom msg
  const msgSetM = text.match(/^\/(\d+)msg (.+)$/);
  if (msgSetM) {
    const acc = getAccByNum(msgSetM[1]);
    if (!acc) return ctx.reply(`❌ Account ${msgSetM[1]} မတွေ့ပါ။`);
    const msg = msgSetM[2].trim();
    await saveAccount(acc.name, { customMsg: msg });
    const parts = msg.split("{spin}");
    return ctx.reply(
      `✅ [${acc.name}] Custom message:\n\n"${msg}"` +
      (parts.length > 1 ? `\n\n💡 Spin ${parts.length} မျိုး` : "")
    );
  }

  // ── /<N>msg  view custom msg
  const msgViewM = text.match(/^\/(\d+)msg$/);
  if (msgViewM) {
    const acc    = getAccByNum(msgViewM[1]);
    if (!acc) return ctx.reply(`❌ Account ${msgViewM[1]} မတွေ့ပါ။`);
    const accDoc = await getAccount(acc.name);
    const num    = msgViewM[1];
    return ctx.reply(
      accDoc?.customMsg
        ? `💬 [${acc.name}] Custom msg:\n\n"${accDoc.customMsg}"\n\nဖျက်ရန်: /${num}clearmsg`
        : `💬 [${acc.name}] Custom msg မသတ်မှတ်ရသေး (global သုံးနေသည်)\n\nသတ်မှတ်ရန်: /${num}msg စာသား`
    );
  }

  // ── /<N>clearmsg
  const clrMsgM = text.match(/^\/(\d+)clearmsg$/);
  if (clrMsgM) {
    const acc = getAccByNum(clrMsgM[1]);
    if (!acc) return ctx.reply(`❌ Account ${clrMsgM[1]} မတွေ့ပါ။`);
    await saveAccount(acc.name, { customMsg: "" });
    return ctx.reply(`🗑️ [${acc.name}] Custom msg ဖျက်ပြီး`);
  }

  console.log(`[cmd] no match: ${text}`);
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
