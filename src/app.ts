import "dotenv/config";
import express from "express";
import { promises as fs } from "fs";
import { Markup, Telegraf } from "telegraf";

type Item = { title: string; price?: number; description?: string; active: boolean };
type Settings = {
  businessName: string;
  welcomeMessage: string;
  supportContact: string;
  aboutText: string;
  items: Item[];
  formQuestions: string[];
  payment: {
    paymentLink: string;
    cardNumber: string;
    cardHolder: string;
    zarinpalMerchantId: string;
    zarinpalSandbox: boolean;
    note: string;
  };
  admins: number[];
};

type UserSession = {
  mode: "form" | "support" | "reservation" | "service" | "shop" | "course";
  step: number;
  answers: string[];
  meta?: Record<string, string>;
};

type AdminState =
  | { action: "ADD_ITEM" }
  | { action: "EDIT_ITEM"; index: number }
  | { action: "EDIT_FIELD"; field: "businessName" | "welcomeMessage" | "supportContact" | "aboutText" }
  | { action: "EDIT_FORM_QUESTIONS" }
  | { action: "SET_CARD" }
  | { action: "SET_PAYMENT_LINK" }
  | { action: "SET_ZARINPAL" }
  | { action: "ADD_ADMIN" }
  | { action: "BROADCAST" };

const token = process.env.CUSTOMER_BOT_TOKEN;
const primaryAdminId = Number(process.env.CUSTOMER_ADMIN_ID || "0");
const baseUrl = (process.env.BASE_URL || "").replace(/\/$/, "");
const dataPath = process.env.SETTINGS_FILE || "./data/settings.json";

const bot = new Telegraf(token || "missing");
const app = express();
app.use(express.json());

const status = { ready: false, startedAt: new Date().toISOString(), error: null as string | null };

const TEMPLATE_CODE: string = "SHOP";
const TEMPLATE_TITLE = "فروشگاهی";
const FEATURES = [
  "پرداخت کارت‌به‌کارت و تایید رسید",
  "مدیریت محصول/خدمت",
  "گزارش‌گیری",
  "ارسال پیام گروهی",
  "چند ادمین",
  "درگاه پرداخت آنلاین",
  "پنل مدیریت ساده",
  "چندزبانه"
];
const FEATURE_CODES = [
  "CARD_TO_CARD",
  "PRODUCT_MANAGEMENT",
  "REPORTS",
  "BROADCAST",
  "MULTI_ADMIN",
  "PAYMENT_GATEWAY",
  "ADMIN_PANEL",
  "MULTI_LANGUAGE"
];
const HAS_PAYMENT_GATEWAY = true;
const HAS_CARD_TO_CARD = true;
const HAS_ADMIN_PANEL = true;
const DETAILS_RAW = "محصول یک\nمحصول ۲";
const DETAIL_LINES = [
  "محصول یک",
  "محصول ۲"
];

const sessions = new Map<number, UserSession>();
const adminStates = new Map<number, AdminState>();
const knownUsers = new Set<number>();
let cachedSettings: Settings | null = null;

function parsePrice(input: string): number | undefined {
  const normalized = input
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[^0-9]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatToman(amount?: number) {
  if (!amount || amount <= 0) return "قیمت ثبت نشده";
  return new Intl.NumberFormat("fa-IR").format(amount) + " تومان";
}

function parseItemLine(line: string): Item {
  const parts = line.split(/\s*[|\-–—]\s*/).map((p) => p.trim()).filter(Boolean);
  const title = parts[0] || line.trim() || "آیتم بدون نام";
  const price = parsePrice(parts[1] || "");
  const description = parts.slice(price ? 2 : 1).join(" - ") || undefined;
  return { title, price, description, active: true };
}

function defaultItems() {
  const fallback: Record<string, string[]> = {
    SHOP: ["محصول نمونه | 100000 | توضیحات محصول", "خدمت نمونه | 200000 | توضیحات خدمت"],
    RESERVATION: ["مشاوره | 300000 | نوبت ۳۰ دقیقه‌ای", "ویزیت | 400000 | نوبت حضوری"],
    SERVICE_ORDER: ["خدمت اول | 500000 | توضیحات خدمت", "مشاوره | 300000 | بررسی اولیه"],
    COURSE_FILE: ["دوره نمونه | 600000 | فایل/ویدیو آموزشی"],
    SUPPORT: ["سوالات عمومی", "مشکل سفارش", "ارتباط با پشتیبانی"],
    FORM: ["نام و نام خانوادگی", "شماره تماس", "توضیحات"]
  };
  const lines = DETAIL_LINES.length ? DETAIL_LINES : (fallback[TEMPLATE_CODE] || fallback.SERVICE_ORDER);
  if (TEMPLATE_CODE === "FORM") return [];
  return lines.map(parseItemLine);
}

function defaultFormQuestions() {
  if (TEMPLATE_CODE === "FORM") {
    return DETAIL_LINES.length ? DETAIL_LINES : ["نام و نام خانوادگی", "شماره تماس", "توضیحات یا درخواست شما"];
  }
  return ["نام و نام خانوادگی", "شماره تماس", "توضیحات"];
}

function defaultSettings(): Settings {
  return {
    businessName: "فروشگاه ۱",
    welcomeMessage: "خیلی خوش‌تشریف آوردین",
    supportContact: "کشتیرانی",
    aboutText: "این ربات به صورت خودکار ساخته شده و اطلاعات آن توسط مدیر ربات قابل ویرایش است.",
    items: defaultItems(),
    formQuestions: defaultFormQuestions(),
    payment: {
      paymentLink: process.env.PAYMENT_LINK || "",
      cardNumber: process.env.CARD_NUMBER || "",
      cardHolder: process.env.CARD_HOLDER || "",
      zarinpalMerchantId: process.env.ZARINPAL_MERCHANT_ID || "",
      zarinpalSandbox: process.env.ZARINPAL_SANDBOX === "true",
      note: "بعد از پرداخت، رسید یا اطلاعات پرداخت را برای پشتیبانی ارسال کنید."
    },
    admins: primaryAdminId ? [primaryAdminId] : []
  };
}

async function ensureDir() {
  const dir = dataPath.split("/").slice(0, -1).join("/");
  if (dir) await fs.mkdir(dir, { recursive: true });
}

async function loadSettings(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  try {
    const raw = await fs.readFile(dataPath, "utf8");
    const parsed = JSON.parse(raw) as Settings;
    cachedSettings = { ...defaultSettings(), ...parsed, payment: { ...defaultSettings().payment, ...(parsed.payment || {}) } };
  } catch {
    cachedSettings = defaultSettings();
    await saveSettings(cachedSettings);
  }
  return cachedSettings;
}

async function saveSettings(settings: Settings) {
  cachedSettings = settings;
  await ensureDir();
  await fs.writeFile(dataPath, JSON.stringify(settings, null, 2), "utf8");
}

function isAdminId(chatId?: number) {
  if (!chatId) return false;
  const settings = cachedSettings;
  return chatId === primaryAdminId || !!settings?.admins.includes(chatId);
}

async function isAdmin(chatId?: number) {
  if (!chatId) return false;
  const settings = await loadSettings();
  return chatId === primaryAdminId || settings.admins.includes(chatId);
}

function userLabel(ctx: any) {
  return ctx.from?.username ? "@" + ctx.from.username : String(ctx.chat?.id || "unknown");
}

function userMenu(settings: Settings) {
  const rows: string[][] = [];
  if (TEMPLATE_CODE === "SHOP") rows.push(["🛍 محصولات", "🧾 ثبت سفارش"]);
  else if (TEMPLATE_CODE === "SUPPORT") rows.push(["🎫 ثبت تیکت", "❓ سوالات متداول"]);
  else if (TEMPLATE_CODE === "RESERVATION") rows.push(["📅 رزرو نوبت", "📋 خدمات"]);
  else if (TEMPLATE_CODE === "COURSE_FILE") rows.push(["🎓 دوره‌ها / فایل‌ها", "🧾 درخواست خرید"]);
  else if (TEMPLATE_CODE === "FORM") rows.push(["📝 شروع فرم", "ℹ️ راهنما"]);
  else rows.push(["📝 ثبت سفارش خدمات", "📋 خدمات"]);
  rows.push(["💳 پرداخت", "☎️ پشتیبانی"]);
  rows.push(["ℹ️ درباره ما"]);
  if (isAdminId(primaryAdminId)) void settings;
  return Markup.keyboard(rows).resize();
}

function adminMenu() {
  return Markup.keyboard([
    ["🧰 پنل مدیریت"],
    ["📦 مدیریت آیتم‌ها", "✏️ ویرایش متن‌ها"],
    ["💳 تنظیم پرداخت", "📊 گزارش‌ها"],
    ["📣 پیام همگانی", "👥 مدیریت ادمین‌ها"],
    ["🔙 منوی کاربر"]
  ]).resize();
}

function itemListText(settings: Settings) {
  if (!settings.items.length) return "هنوز آیتمی ثبت نشده است.";
  return settings.items
    .map((item, i) => String(i + 1) + ". " + (item.active ? "✅" : "⛔️") + " " + item.title + "\nقیمت: " + formatToman(item.price) + (item.description ? "\n" + item.description : ""))
    .join("\n\n");
}

function itemsInline(settings: Settings) {
  const rows = settings.items.slice(0, 20).flatMap((item, i) => [
    [Markup.button.callback("✏️ ویرایش " + String(i + 1), "ADM_ITEM_EDIT_" + String(i)), Markup.button.callback("🗑 حذف " + String(i + 1), "ADM_ITEM_DEL_" + String(i))]
  ]);
  rows.push([Markup.button.callback("➕ افزودن آیتم", "ADM_ITEM_ADD")]);
  return Markup.inlineKeyboard(rows);
}

function textSettingsInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🏷 نام کسب‌وکار", "ADM_EDIT_businessName")],
    [Markup.button.callback("👋 متن خوش‌آمد", "ADM_EDIT_welcomeMessage")],
    [Markup.button.callback("☎️ پشتیبانی", "ADM_EDIT_supportContact")],
    [Markup.button.callback("ℹ️ درباره ما", "ADM_EDIT_aboutText")],
    [Markup.button.callback("📝 سوال‌های فرم", "ADM_EDIT_FORM_QUESTIONS")]
  ]);
}

function paymentInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 کارت‌به‌کارت", "ADM_SET_CARD")],
    [Markup.button.callback("🔗 لینک پرداخت", "ADM_SET_PAYMENT_LINK")],
    [Markup.button.callback("🟣 مرچنت زرین‌پال/API", "ADM_SET_ZARINPAL")]
  ]);
}

async function notifyAdmin(title: string, ctx: any, body: string) {
  const settings = await loadSettings();
  const text =
    title + "\n\n" +
    "کسب‌وکار: " + settings.businessName + "\n" +
    "نوع ربات: " + TEMPLATE_TITLE + "\n" +
    "کاربر: " + userLabel(ctx) + "\n\n" +
    body;
  for (const id of settings.admins) {
    try { await ctx.telegram.sendMessage(id, text); } catch (error) { console.error("notify admin failed", id, error); }
  }
}

function startSession(chatId: number, mode: UserSession["mode"], firstQuestion: string) {
  sessions.set(chatId, { mode, step: 0, answers: [], meta: {} });
  return firstQuestion;
}

async function finishFormLike(ctx: any, session: UserSession, title: string, questions: string[]) {
  const summary = questions.map((q, i) => String(i + 1) + ") " + q + ":\n" + (session.answers[i] || "-")).join("\n\n");
  sessions.delete(ctx.chat.id);
  await notifyAdmin(title, ctx, summary);
  const settings = await loadSettings();
  await ctx.reply("اطلاعات شما ثبت شد ✅\nمدیر به‌زودی بررسی می‌کند.", userMenu(settings));
}

function describePayment(settings: Settings) {
  let text = "روش‌های پرداخت:\n";
  if (HAS_PAYMENT_GATEWAY) {
    if (settings.payment.paymentLink) text += "\n🔗 پرداخت آنلاین:\n" + settings.payment.paymentLink + "\n";
    if (settings.payment.zarinpalMerchantId) text += "\n🟣 درگاه زرین‌پال/API ثبت شده است.\nمرچنت: " + settings.payment.zarinpalMerchantId.slice(0, 8) + "...\n";
    if (!settings.payment.paymentLink && !settings.payment.zarinpalMerchantId) text += "\nدرگاه آنلاین هنوز توسط مدیر تکمیل نشده است.\n";
  }
  if (HAS_CARD_TO_CARD || settings.payment.cardNumber) {
    if (settings.payment.cardNumber) text += "\n💳 کارت‌به‌کارت:\n" + settings.payment.cardNumber + "\nبه نام: " + (settings.payment.cardHolder || "-") + "\n";
    else text += "\nکارت‌به‌کارت هنوز توسط مدیر تکمیل نشده است.\n";
  }
  text += "\n" + settings.payment.note;
  return text;
}

bot.start(async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  if (await isAdmin(ctx.chat.id)) {
    await ctx.reply("سلام مدیر 👋\nاز منوی مدیریت می‌توانی محصولات، متن‌ها، قیمت‌ها و پرداخت را تغییر بدهی.", adminMenu());
  } else {
    await ctx.reply(settings.welcomeMessage, userMenu(settings));
  }
});

bot.hears("🧰 پنل مدیریت", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id))) return;
  await ctx.reply("پنل مدیریت ربات مشتری:\nهر چیزی که لازم داری از همینجا قابل تغییر است.", adminMenu());
});

bot.hears("📦 مدیریت آیتم‌ها", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id))) return;
  const settings = await loadSettings();
  await ctx.reply("آیتم‌های فعلی:\n\n" + itemListText(settings), itemsInline(settings));
});

bot.hears("✏️ ویرایش متن‌ها", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id))) return;
  await ctx.reply("کدام متن را می‌خواهی تغییر بدهی؟", textSettingsInline());
});

bot.hears("💳 تنظیم پرداخت", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id))) return;
  const settings = await loadSettings();
  await ctx.reply("وضعیت فعلی پرداخت:\n\n" + describePayment(settings), paymentInline());
});

bot.hears("📊 گزارش‌ها", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id))) return;
  await ctx.reply("گزارش ساده:\nکاربران دیده‌شده از زمان روشن شدن ربات: " + knownUsers.size + "\nتعداد آیتم‌ها: " + (await loadSettings()).items.length, adminMenu());
});

bot.hears("📣 پیام همگانی", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id))) return;
  adminStates.set(ctx.chat.id, { action: "BROADCAST" });
  await ctx.reply("متن پیام همگانی را بفرست.\nفعلاً پیام به کاربرانی ارسال می‌شود که از زمان روشن شدن ربات /start زده‌اند.");
});

bot.hears("👥 مدیریت ادمین‌ها", async (ctx) => {
  if (!(await isAdmin(ctx.chat.id))) return;
  const settings = await loadSettings();
  await ctx.reply("ادمین‌های فعلی:\n" + settings.admins.join("\n") + "\n\nبرای افزودن ادمین جدید، آیدی عددی را بفرست.");
  adminStates.set(ctx.chat.id, { action: "ADD_ADMIN" });
});

bot.hears("🔙 منوی کاربر", async (ctx) => {
  const settings = await loadSettings();
  await ctx.reply("منوی کاربر:", userMenu(settings));
});

bot.action("ADM_ITEM_ADD", async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  adminStates.set(ctx.chat!.id, { action: "ADD_ITEM" });
  await ctx.reply("آیتم جدید را با این فرمت بفرست:\nعنوان | قیمت | توضیح\n\nمثال:\nمحصول تست | 250000 | توضیحات محصول");
});

bot.action(/ADM_ITEM_EDIT_(\d+)/, async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  adminStates.set(ctx.chat!.id, { action: "EDIT_ITEM", index: Number(ctx.match[1]) });
  await ctx.reply("مقدار جدید را با این فرمت بفرست:\nعنوان | قیمت | توضیح");
});

bot.action(/ADM_ITEM_DEL_(\d+)/, async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  const settings = await loadSettings();
  const index = Number(ctx.match[1]);
  if (settings.items[index]) settings.items.splice(index, 1);
  await saveSettings(settings);
  await ctx.reply("حذف شد ✅\n\n" + itemListText(settings), itemsInline(settings));
});

bot.action(/ADM_EDIT_(businessName|welcomeMessage|supportContact|aboutText)/, async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  adminStates.set(ctx.chat!.id, { action: "EDIT_FIELD", field: ctx.match[1] as any });
  await ctx.reply("متن جدید را بفرست.");
});

bot.action("ADM_EDIT_FORM_QUESTIONS", async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  adminStates.set(ctx.chat!.id, { action: "EDIT_FORM_QUESTIONS" });
  await ctx.reply("سوال‌های فرم را خط به خط بفرست.");
});

bot.action("ADM_SET_CARD", async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  adminStates.set(ctx.chat!.id, { action: "SET_CARD" });
  await ctx.reply("شماره کارت و نام صاحب کارت را با این فرمت بفرست:\nشماره کارت | نام صاحب کارت");
});

bot.action("ADM_SET_PAYMENT_LINK", async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  adminStates.set(ctx.chat!.id, { action: "SET_PAYMENT_LINK" });
  await ctx.reply("لینک پرداخت را بفرست. مثال:\nhttps://...");
});

bot.action("ADM_SET_ZARINPAL", async (ctx) => {
  if (!(await isAdmin(ctx.chat?.id))) return;
  await ctx.answerCbQuery();
  adminStates.set(ctx.chat!.id, { action: "SET_ZARINPAL" });
  await ctx.reply("مرچنت/API زرین‌پال را بفرست.\nفعلاً در ربات ذخیره می‌شود تا پرداخت آنلاین فعال‌سازی شود.");
});

bot.hears("ℹ️ درباره ما", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  const features = FEATURES.map((f) => "• " + f).join("\n") || "ثبت نشده";
  await ctx.reply(settings.businessName + "\n\n" + settings.aboutText + "\n\nنوع ربات: " + TEMPLATE_TITLE + "\n\nامکانات فعال:\n" + features, userMenu(settings));
});

bot.hears("☎️ پشتیبانی", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  if (settings.supportContact && settings.supportContact !== "ثبت نشده") {
    await ctx.reply("راه ارتباطی پشتیبانی:\n" + settings.supportContact, userMenu(settings));
  } else {
    sessions.set(ctx.chat.id, { mode: "support", step: 0, answers: [], meta: {} });
    await ctx.reply("پیام پشتیبانی خود را بنویسید تا برای مدیر ارسال شود.");
  }
});

bot.hears("💳 پرداخت", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  await ctx.reply(describePayment(settings), userMenu(settings));
});

bot.hears(["📋 خدمات", "❓ سوالات متداول", "🎓 دوره‌ها / فایل‌ها"], async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  const active = settings.items.filter((item) => item.active);
  await ctx.reply(active.length ? itemListText({ ...settings, items: active }) : "اطلاعات هنوز توسط مدیر تکمیل نشده است.", userMenu(settings));
});

bot.hears("🛍 محصولات", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  const items = settings.items.filter((item) => item.active);
  if (!items.length) {
    await ctx.reply("هنوز محصولی ثبت نشده است.", userMenu(settings));
    return;
  }
  await ctx.reply("محصولات / خدمات:\n\n" + itemListText({ ...settings, items }), Markup.inlineKeyboard(items.slice(0, 20).map((item, i) => [Markup.button.callback("🛒 سفارش: " + item.title.slice(0, 32), "BUY_" + i)])));
});

bot.action(/BUY_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  knownUsers.add(ctx.chat!.id);
  const settings = await loadSettings();
  const item = settings.items.filter((x) => x.active)[Number(ctx.match[1])] || { title: "محصول انتخاب‌شده" };
  sessions.set(ctx.chat!.id, { mode: "shop", step: 0, answers: [], meta: { item: item.title, price: String(item.price || "") } });
  await ctx.reply("برای سفارش «" + item.title + "» اطلاعات زیر را در یک پیام بفرستید:\nنام، شماره تماس، آدرس/توضیحات\n\nقیمت: " + formatToman(item.price));
});

bot.hears("🧾 ثبت سفارش", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  sessions.set(ctx.chat.id, { mode: "shop", step: 0, answers: [], meta: {} });
  await ctx.reply("لطفاً نام محصول/خدمت، تعداد، شماره تماس و توضیحات را ارسال کنید.");
});

bot.hears("🎫 ثبت تیکت", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  sessions.set(ctx.chat.id, { mode: "support", step: 0, answers: [], meta: {} });
  await ctx.reply("موضوع و متن مشکل/درخواست خود را بنویسید.");
});

bot.hears("📅 رزرو نوبت", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  const question = startSession(ctx.chat.id, "reservation", "نام خدمت موردنظر، روز/ساعت پیشنهادی، نام و شماره تماس را ارسال کنید.");
  await ctx.reply(question + "\n\nخدمات:\n" + itemListText(settings));
});

bot.hears("📝 ثبت سفارش خدمات", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  sessions.set(ctx.chat.id, { mode: "service", step: 0, answers: [], meta: {} });
  await ctx.reply("لطفاً نوع خدمت، توضیحات کامل، زمان موردنظر و شماره تماس را ارسال کنید.");
});

bot.hears("🧾 درخواست خرید", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  sessions.set(ctx.chat.id, { mode: "course", step: 0, answers: [], meta: {} });
  await ctx.reply("نام دوره/فایل موردنظر و شماره تماس خود را ارسال کنید.");
});

bot.hears("📝 شروع فرم", async (ctx) => {
  knownUsers.add(ctx.chat.id);
  const settings = await loadSettings();
  const questions = settings.formQuestions.length ? settings.formQuestions : ["نام و نام خانوادگی", "شماره تماس", "توضیحات"];
  sessions.set(ctx.chat.id, { mode: "form", step: 0, answers: [], meta: {} });
  await ctx.reply("فرم شروع شد ✅\n\n" + questions[0]);
});

bot.hears("ℹ️ راهنما", async (ctx) => {
  const settings = await loadSettings();
  await ctx.reply("برای ثبت اطلاعات روی «📝 شروع فرم» بزنید و سوال‌ها را مرحله‌به‌مرحله پاسخ دهید.", userMenu(settings));
});

async function handleAdminText(ctx: any, text: string) {
  const state = adminStates.get(ctx.chat.id);
  if (!state || !(await isAdmin(ctx.chat.id))) return false;
  const settings = await loadSettings();

  if (state.action === "ADD_ITEM") {
    settings.items.push(parseItemLine(text));
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("آیتم اضافه شد ✅\n\n" + itemListText(settings), itemsInline(settings));
    return true;
  }

  if (state.action === "EDIT_ITEM") {
    if (!settings.items[state.index]) {
      adminStates.delete(ctx.chat.id);
      await ctx.reply("این آیتم پیدا نشد.", adminMenu());
      return true;
    }
    settings.items[state.index] = parseItemLine(text);
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("آیتم ویرایش شد ✅\n\n" + itemListText(settings), itemsInline(settings));
    return true;
  }

  if (state.action === "EDIT_FIELD") {
    settings[state.field] = text;
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("ذخیره شد ✅", adminMenu());
    return true;
  }

  if (state.action === "EDIT_FORM_QUESTIONS") {
    settings.formQuestions = text.split(/\r?\n/).map((x: string) => x.trim()).filter(Boolean).slice(0, 30);
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("سوال‌های فرم ذخیره شد ✅", adminMenu());
    return true;
  }

  if (state.action === "SET_CARD") {
    const parts = text.split("|").map((x: string) => x.trim());
    settings.payment.cardNumber = parts[0] || text.trim();
    settings.payment.cardHolder = parts[1] || "";
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("اطلاعات کارت ذخیره شد ✅", adminMenu());
    return true;
  }

  if (state.action === "SET_PAYMENT_LINK") {
    settings.payment.paymentLink = text.trim();
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("لینک پرداخت ذخیره شد ✅", adminMenu());
    return true;
  }

  if (state.action === "SET_ZARINPAL") {
    settings.payment.zarinpalMerchantId = text.trim();
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("مرچنت/API زرین‌پال ذخیره شد ✅\nمرحله بعدی اتصال کامل callback پرداخت آنلاین است.", adminMenu());
    return true;
  }

  if (state.action === "ADD_ADMIN") {
    const id = Number(text.replace(/[^0-9]/g, ""));
    if (!id) {
      await ctx.reply("آیدی عددی درست نیست. دوباره بفرست.");
      return true;
    }
    if (!settings.admins.includes(id)) settings.admins.push(id);
    await saveSettings(settings);
    adminStates.delete(ctx.chat.id);
    await ctx.reply("ادمین اضافه شد ✅", adminMenu());
    return true;
  }

  if (state.action === "BROADCAST") {
    let sent = 0;
    for (const id of knownUsers) {
      try { await ctx.telegram.sendMessage(id, text); sent++; } catch {}
    }
    adminStates.delete(ctx.chat.id);
    await ctx.reply("پیام ارسال شد ✅\nتعداد ارسال: " + sent, adminMenu());
    return true;
  }

  return false;
}

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  knownUsers.add(ctx.chat.id);
  if (await handleAdminText(ctx, text)) return;
  if (text.startsWith("/")) return;

  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  const settings = await loadSettings();
  if (!session) {
    await ctx.reply("از منوی پایین یک گزینه را انتخاب کنید.", (await isAdmin(chatId)) ? adminMenu() : userMenu(settings));
    return;
  }

  if (session.mode === "form") {
    const questions = settings.formQuestions.length ? settings.formQuestions : ["نام و نام خانوادگی", "شماره تماس", "توضیحات"];
    session.answers.push(text);
    session.step += 1;
    if (session.step >= questions.length) {
      await finishFormLike(ctx, session, "فرم جدید ثبت شد 📝", questions);
      return;
    }
    sessions.set(chatId, session);
    await ctx.reply(questions[session.step]);
    return;
  }

  const titles: Record<string, string> = {
    support: "تیکت پشتیبانی جدید 🎫",
    reservation: "درخواست رزرو جدید 📅",
    service: "سفارش خدمات جدید 📝",
    shop: "سفارش فروشگاهی جدید 🛍",
    course: "درخواست خرید دوره/فایل 🎓"
  };

  const selectedItem = session.meta?.item ? "آیتم انتخاب‌شده: " + session.meta.item + "\nقیمت: " + formatToman(parsePrice(session.meta.price || "")) + "\n\n" : "";
  sessions.delete(chatId);
  await notifyAdmin(titles[session.mode] || "پیام جدید", ctx, selectedItem + text);
  await ctx.reply("درخواست شما ثبت و برای مدیر ارسال شد ✅", userMenu(settings));
});

app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.json(status));

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", async () => {
  console.log("Listening on " + port);
  try {
    if (!token) throw new Error("CUSTOMER_BOT_TOKEN is missing");
    if (!baseUrl) throw new Error("BASE_URL is missing");
    await loadSettings();
    const path = "/webhook/" + token.split(":")[0];
    app.post(path, async (req, res) => {
      try {
        await bot.handleUpdate(req.body);
        res.sendStatus(200);
      } catch (error) {
        console.error(error);
        res.sendStatus(200);
      }
    });
    await bot.telegram.setWebhook(baseUrl + path, { drop_pending_updates: true });
    status.ready = true;
    status.error = null;
    console.log("Customer bot ready");
  } catch (error) {
    status.ready = false;
    status.error = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
});
