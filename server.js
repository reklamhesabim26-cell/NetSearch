require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const OpenAI = require("openai");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 180
}));

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGODB_URI || process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "netsearch_secret";

if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => {
      cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Sadece görsel yüklenebilir"));
    cb(null, true);
  }
});

let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

mongoose.connect(MONGO_URL)
  .then(() => console.log("MongoDB bağlantısı başarılı"))
  .catch(err => console.log("MongoDB bağlantı hatası:", err.message));

const userSchema = new mongoose.Schema({
  name: String,
  company: String,
  phone: String,
  email: String,
  password: String,
  role: { type: String, default: "user" },
  balance: { type: Number, default: 0 },
}, { timestamps: true, strict: false });

const siteSchema = new mongoose.Schema({}, { timestamps: true, strict: false });
const commentSchema = new mongoose.Schema({}, { timestamps: true, strict: false });
const paymentSchema = new mongoose.Schema({
  merchant_oid: String,
  email: String,
  amount: Number,
  status: { type: String, default: "pending" },
  processed: { type: Boolean, default: false }
}, { timestamps: true, strict: false });

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Site = mongoose.models.Site || mongoose.model("Site", siteSchema);
const Comment = mongoose.models.Comment || mongoose.model("Comment", commentSchema);
const Payment = mongoose.models.Payment || mongoose.model("Payment", paymentSchema);

function normalize(t) {
  return String(t || "").toLowerCase()
    .replaceAll("ı", "i").replaceAll("ğ", "g").replaceAll("ü", "u")
    .replaceAll("ş", "s").replaceAll("ö", "o").replaceAll("ç", "c")
    .trim();
}
function normalize(t) {
  return String(t || "").toLowerCase()
    .replaceAll("ı", "i").replaceAll("ğ", "g").replaceAll("ü", "u")
    .replaceAll("ş", "s").replaceAll("ö", "o").replaceAll("ç", "c")
    .trim();
}

function levenshtein(a, b) {
  a = normalize(a);
  b = normalize(b);

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {

      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }

    }
  }

  return matrix[b.length][a.length];
}

function similar(a, b) {
  a = normalize(a);
  b = normalize(b);

  if (!a || !b) return false;

  if (a.includes(b) || b.includes(a)) return true;

  const distance = levenshtein(a, b);

  if (a.length <= 4) return distance <= 1;
  if (a.length <= 7) return distance <= 2;

  return distance <= 3;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replaceAll("ı", "i").replaceAll("ğ", "g").replaceAll("ü", "u")
    .replaceAll("ş", "s").replaceAll("ö", "o").replaceAll("ç", "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function arr(v) {
  if (Array.isArray(v)) return v;
  return String(v || "").split(",").map(x => x.trim()).filter(Boolean);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function tokenFor(user) {
  return jwt.sign({
    id: user.id || user._id,
    email: user.email,
    role: user.role
  }, JWT_SECRET, { expiresIn: "7d" });
}

function siteText(s) {
  return normalize(`
    ${s.title || ""} ${s.name || ""} ${s.businessName || ""}
    ${s.adHeadline1 || ""} ${s.adHeadline2 || ""} ${s.adHeadline3 || ""}
    ${s.description || ""} ${s.desc || ""}
    ${s.adDescription1 || ""} ${s.adDescription2 || ""}
    ${s.address || ""} ${s.category || ""}
    ${s.city || ""} ${s.sehir || ""}
    ${s.district || ""} ${s.ilce || ""}
    ${arr(s.targetCities).join(" ")}
    ${arr(s.targetDistricts).join(" ")}
    ${arr(s.keywords).join(" ")}
    ${arr(s.tags).join(" ")}
  `);
}

function hasNegative(site, q) {
  const query = normalize(q);

  const negatives = arr(site.negativeKeywords)
    .map(normalize)
    .filter(Boolean);

  if (!negatives.length) return false;

  const queryWords = query.split(/\s+/).filter(Boolean);

  for (const negative of negatives) {
    if (query.includes(negative)) {
      return true;
    }

    for (const qw of queryWords) {
      if (similar(qw, negative)) {
        return true;
      }
    }
  }

  return false;
}

function targetMatch(site, q) {
  const query = normalize(q);
  const cities = arr(site.targetCities).map(normalize);
  const districts = arr(site.targetDistricts).map(normalize);
  const city = normalize(site.city || site.sehir || "");
  const district = normalize(site.district || site.ilce || "");

  let bonus = 0;

  if (city && query.includes(city)) bonus += 45;
  if (district && query.includes(district)) bonus += 35;

  cities.forEach(c => {
    if (c && query.includes(c)) bonus += 45;
  });

  districts.forEach(d => {
    if (d && query.includes(d)) bonus += 35;
  });

  return bonus;
  function detectQueryIntent(q) {
  q = normalize(q);

  const intents = [
    {
      name: "devlet",
      words: [
        "edevlet","e devlet","sgk","vergi",
        "belediye","bakanlik","devlet"
      ],
      allowedCategories: ["devlet"]
    },

    {
      name: "teknik_servis",
      words: [
        "kombi","kombici","beyaz esya",
        "servis","tamir","buzdolabi",
        "camasir","bulasik"
      ],
      allowedCategories: ["teknik servis"]
    },

    {
      name: "eczane",
      words: [
        "eczane","nobetci eczane",
        "ilac","saglik"
      ],
      allowedCategories: ["eczane","saglik"]
    },

    {
      name: "otomotiv",
      words: [
        "oto","araba","otomobil",
        "motor","lastik","kaporta"
      ],
      allowedCategories: ["otomotiv","oto servis"]
    },

    {
      name: "egitim",
      words: [
        "okul","universite","ders",
        "egitim","tarih","matematik"
      ],
      allowedCategories: ["egitim"]
    }
  ];

  for (const intent of intents) {
    for (const w of intent.words) {
      if (q.includes(normalize(w))) {
        return intent;
      }
    }
  }

  return null;
}
}
function categoryIntentScore(site, q) {
  const query = normalize(q);
  const category = normalize(site.category || "");
  const text = siteText(site);

  const groups = [
    {
      name: "kombi",
      words: ["kombi", "kombici", "kombi servisi", "kombi tamiri", "kombi bakimi", "dogalgaz", "kalorifer"],
      boostCategories: ["teknik servis", "kombi", "beyaz esya", "servis"],
      blockCategories: ["devlet", "otomotiv", "restoran", "haber", "egitim", "hukuk", "saglik", "e-ticaret"],
      blockWords: ["oto", "araba", "otomobil", "lastik", "motor", "kaporta", "edevlet", "e devlet", "haber", "restoran"]
    },
    {
      name: "beyaz_esya",
      words: ["beyaz esya", "buzdolabi", "camasir makinesi", "bulasik makinesi", "servis", "tamirci"],
      boostCategories: ["teknik servis", "beyaz esya", "servis"],
      blockCategories: ["devlet", "otomotiv", "restoran", "haber", "egitim", "hukuk", "saglik"],
      blockWords: ["oto", "araba", "otomobil", "lastik", "kaporta", "edevlet", "haber", "restoran"]
    },
    {
      name: "oto",
      words: ["oto", "araba", "otomobil", "arac", "motor", "kaporta", "lastik", "oto tamirci", "oto servis"],
      boostCategories: ["oto", "otomotiv", "oto servis", "araba", "servis"],
      blockCategories: ["devlet", "teknik servis", "restoran", "haber", "egitim", "hukuk", "saglik"],
      blockWords: ["kombi", "buzdolabi", "camasir", "bulasik", "edevlet", "haber", "restoran"]
    },
    {
      name: "devlet",
      words: ["edevlet", "e devlet", "devlet", "turkiye gov", "sgk", "vergi", "belediye", "bakanlik"],
      boostCategories: ["devlet"],
      blockCategories: ["teknik servis", "otomotiv", "restoran", "e-ticaret"],
      blockWords: ["kombi", "oto", "araba", "tamir", "servis", "restoran"]
    },
    {
      name: "eczane",
      words: ["eczane", "nobetci eczane", "ilac", "saglik"],
      boostCategories: ["eczane", "saglik"],
      blockCategories: ["teknik servis", "otomotiv", "restoran", "haber"],
      blockWords: ["kombi", "oto", "araba", "tamir"]
    },
    {
      name: "restoran",
      words: ["restoran", "yemek", "lokanta", "cafe", "kahvalti", "pizza", "burger"],
      boostCategories: ["restoran", "cafe", "yemek"],
      blockCategories: ["teknik servis", "otomotiv", "devlet", "hukuk"],
      blockWords: ["kombi", "oto", "tamir", "edevlet"]
    }
  ];

  let total = 0;
  let matchedAnyIntent = false;

  for (const group of groups) {
    const intentMatched = group.words.some(w => {
      const nw = normalize(w);
      return query.includes(nw) || similar(query, nw);
    });

    if (!intentMatched) continue;

    matchedAnyIntent = true;

    const categoryMatched = group.boostCategories.some(c => {
      const nc = normalize(c);
      return category.includes(nc) || text.includes(nc);
    });

    const categoryBlocked = group.blockCategories.some(c => {
      const nc = normalize(c);
      return category.includes(nc);
    });

    const wordBlocked = group.blockWords.some(w => {
      const nw = normalize(w);
      return text.includes(nw) || category.includes(nw);
    });

    if (categoryMatched) total += 180;
    if (categoryBlocked) total -= 260;
    if (wordBlocked) total -= 160;
  }

  if (matchedAnyIntent && total < -200) {
    total -= 300;
  }

  return total;
}
function getDailySpent(site) {
  if (site.dailySpendDate !== todayKey()) return 0;
  return Number(site.dailySpent || 0);
}

function dailyLimitAvailable(site) {
  const dailyLimit = Number(site.dailyLimit || 0);
  if (dailyLimit <= 0) return true;
  return getDailySpent(site) < dailyLimit;
}

function calcQualityScore(site) {
  let q = 0;

  if (site.logo || site.logoUrl || site.image) q += 10;
  if (site.cover || site.coverUrl) q += 8;
  if (site.phone || site.telefon || site.whatsapp) q += 12;
  if (site.verified || site.isVerified) q += 15;

  if ((site.description || site.desc || "").length > 50) q += 10;
  if ((site.adHeadline1 || "").length > 5) q += 8;
  if ((site.adHeadline2 || "").length > 5) q += 6;
  if ((site.adHeadline3 || "").length > 5) q += 6;
  if ((site.adDescription1 || "").length > 30) q += 10;
  if ((site.adDescription2 || "").length > 30) q += 8;

  if (arr(site.keywords).length >= 3) q += 10;
  if (arr(site.negativeKeywords).length >= 1) q += 6;
  if (arr(site.targetCities).length || site.city || site.sehir) q += 10;
  if (arr(site.targetDistricts).length || site.district || site.ilce) q += 8;

  const views = Number(site.views || 0);
  const clicks = Number(site.clicks || 0);
  const ctr = views > 0 ? clicks / views : 0;

  if (ctr > 0.02) q += 8;
  if (ctr > 0.05) q += 12;
  if (ctr > 0.10) q += 16;

  return Math.min(Math.round(q), 100);
}

function adScore(site, q) {
  const cpc = Number(site.cpc || site.sponsorCpc || 0);
  const budget = Number(site.sponsorBudget || 0);
  const dailyLimit = Number(site.dailyLimit || 0);
  const quality = calcQualityScore(site);
  const ai = Number(site.aiScore || 0);
  const views = Number(site.views || 0);
  const clicks = Number(site.clicks || 0);
  const ctr = views > 0 ? (clicks / views) * 100 : 0;

  let s = 0;
  s += Math.min(cpc * 8, 80);
  s += Math.min(budget / 20, 80);
  s += Math.min(dailyLimit / 20, 50);
  s += quality;
  s += Math.min(ai, 40);
  s += Math.min(ctr * 10, 60);
  s += targetMatch(site, q);
  s += categoryIntentScore(site, q);

  if (site.verified || site.isVerified) s += 25;

  return Math.round(s);
}

function score(site, q) {
  const query = normalize(q);
  const words = query.split(/\s+/).filter(Boolean);
  const text = siteText(site);
  const title = normalize(site.title || site.name || site.businessName);

  let s = 0;

  if (title === query) s += 130;
  if (title.includes(query)) s += 140;
if (text.includes(query)) s += 80;

if (similar(title, query)) s += 120;

  words.forEach(w => {
    if (title.includes(w)) s += 42;
if (text.includes(w)) s += 18;

const textWords = text.split(/\s+/);

textWords.forEach(tw => {

  if (similar(tw, w)) {
    s += 14;
  }

});
  });

  s += targetMatch(site, q);
  s += Math.min(Number(site.aiScore || 0), 40);
  s += Math.min(calcQualityScore(site), 70);
  s += Math.min(Number(site.views || 0) / 20, 25);
  s += Math.min(Number(site.clicks || 0) / 5, 35);

  if (site.sponsored || site.isSponsored || site.sponsorActive) {
    s += adScore(site, q);
  }

  if (site.verified || site.isVerified) s += 35;
  if (site.logo || site.logoUrl || site.image) s += 8;
  if (site.cover || site.coverUrl) s += 8;
  if (site.phone || site.telefon || site.whatsapp) s += 12;

  return Math.round(s);
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function buildSite(b) {
  const fixed = {
    ...b,

    title: b.title || b.name || b.businessName || b.adHeadline1 || "",
    name: b.name || b.title || b.businessName || b.adHeadline1 || "",
    businessName: b.businessName || b.title || b.name || b.adHeadline1 || "",
    slug: b.slug || slugify(b.title || b.name || b.businessName || b.adHeadline1 || ""),

    url: b.url || b.website || b.link || "",
    website: b.website || b.url || b.link || "",
    link: b.link || b.url || b.website || "",

    description: b.description || b.desc || b.adDescription1 || "",
    desc: b.desc || b.description || b.adDescription1 || "",

    city: b.city || b.sehir || "",
    sehir: b.sehir || b.city || "",
    district: b.district || b.ilce || "",
    ilce: b.ilce || b.district || "",

    phone: b.phone || b.telefon || "",
    telefon: b.telefon || b.phone || "",
    whatsapp: b.whatsapp || b.phone || b.telefon || "",

    keywords: arr(b.keywords || b.tags),
    tags: arr(b.tags || b.keywords),
    negativeKeywords: arr(b.negativeKeywords),
    targetCities: arr(b.targetCities),
    targetDistricts: arr(b.targetDistricts),

    gallery: arr(b.gallery),

    approved: b.approved === true || b.approved === "true",
    status: b.status || "pending",

    sponsored: b.sponsored === true || b.sponsored === "true",
    isSponsored: b.isSponsored === true || b.isSponsored === "true",
    sponsorActive: b.sponsorActive === true || b.sponsorActive === "true",

    verified: b.verified === true || b.verified === "true",
    isVerified: b.isVerified === true || b.isVerified === "true",

    sponsorBudget: Number(b.sponsorBudget || 0),
    dailyLimit: Number(b.dailyLimit || 0),
    dailySpent: Number(b.dailySpent || 0),
    dailySpendDate: b.dailySpendDate || "",
    cpc: Number(b.cpc || b.sponsorCpc || 0),
    sponsorCpc: Number(b.sponsorCpc || b.cpc || 0),
    totalSpent: Number(b.totalSpent || 0),

    aiScore: Number(b.aiScore || 10),
    latitude: Number(b.latitude || 0),
    longitude: Number(b.longitude || 0),

    views: Number(b.views || 0),
    clicks: Number(b.clicks || 0)
  };

  fixed.qualityScore = calcQualityScore(fixed);
  fixed.adScore = adScore(fixed, "");

  return fixed;
}

/* HEALTH */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "NetSearch çalışıyor",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "not connected",
    openai: process.env.OPENAI_API_KEY ? "key var" : "key yok",
    jwt: "active",
    upload: "active",
    autoIndex: "active",
    nearby: "active",
    adsEngine: "active",
    antiRefresh: "active",
    dailyBudget: "active",
    targetSystem: "active",
    ranking: "active"
  });
});

/* AUTH */

app.post("/api/register", async (req, res) => {
  try {
    const { name, company, phone, email, password } = req.body;

    if (!email || !password) {
      return res.json({ success: false, message: "E-posta ve şifre gerekli" });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.json({ success: false, message: "Bu e-posta kayıtlı" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await User.create({
      name,
      company,
      phone,
      email,
      password: hashed,
      role: "user"
    });

    res.json({ success: true, message: "Kayıt başarılı" });

  } catch {
    res.status(500).json({ success: false, message: "Kayıt hatası" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      (email === "enderadmin" || email === "admin" || email === "reklamhesabim26@gmail.com")
      && password === "123456"
    ) {
      const user = {
        id: "admin",
        name: "Ender Admin",
        email: "reklamhesabim26@gmail.com",
        role: "admin"
      };

      return res.json({
        success: true,
        message: "Admin girişi başarılı",
        token: tokenFor(user),
        user
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: "E-posta veya şifre hatalı" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ success: false, message: "E-posta veya şifre hatalı" });
    }

    const safeUser = {
      id: user._id,
      name: user.name,
      company: user.company,
      phone: user.phone,
      email: user.email,
      role: user.role || "user"
    };

    res.json({
      success: true,
      message: "Giriş başarılı",
      token: tokenFor(safeUser),
      user: safeUser
    });

  } catch {
    res.status(500).json({ success: false, message: "Giriş hatası" });
  }
});

/* UPLOAD */

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Dosya yok" });
  res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

app.post("/api/upload/multiple", upload.array("files", 10), (req, res) => {
  res.json({ success: true, urls: (req.files || []).map(f => `/uploads/${f.filename}`) });
});

/* AUTO INDEX */

function safeUrl(input) {
  try {
    let url = String(input || "").trim();

    if (!url) return null;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const parsed = new URL(url);

    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    return parsed.href;
  } catch {
    return null;
  }
}

function getDomain(input) {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function absoluteUrl(base, value) {
  try {
    if (!value) return "";
    if (value.startsWith("data:")) return "";
    if (value.startsWith("http://") || value.startsWith("https://")) return value;
    return new URL(value, base).href;
  } catch {
    return "";
  }
}

function cleanText(text, max = 300) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function uniqueList(list, limit = 30) {
  return [...new Set(
    list
      .map(x => cleanText(x, 80))
      .filter(x => x && x.length > 2)
  )].slice(0, limit);
}

function guessCategoryFromText(full) {
  const text = normalize(full);

  const rules = [
    {
      category: "Teknik Servis",
      words: [
        "kombi","beyaz esya","buzdolabi","camasir","bulasik",
        "servis","tamir","ariza","bakim","teknik servis",
        "kombi servisi","klima","elektronik"
      ]
    },

    {
      category: "Devlet",
      words: [
        "edevlet","e devlet","gov","bakanlik","belediye",
        "resmi","devlet","kurum","sgk","vergi"
      ]
    },

    {
      category: "Otomotiv",
      words: [
        "oto","araba","otomobil","arac","lastik",
        "kaporta","motor","oto servis","oto tamir"
      ]
    },

    {
      category: "Sağlık",
      words: [
        "doktor","hastane","klinik","dis","eczane",
        "saglik","muayene","psikolog"
      ]
    },

    {
      category: "Restoran",
      words: [
        "restoran","lokanta","yemek","cafe",
        "kahvalti","pizza","burger","doner"
      ]
    },

    {
      category: "Hukuk",
      words: [
        "avukat","hukuk","dava","danismanlik",
        "icra","noter"
      ]
    },

    {
      category: "Eğitim",
      words: [
        "okul","kurs","egitim","ders",
        "akademi","universite"
      ]
    },

    {
      category: "E-Ticaret",
      words: [
        "satın al","sepete ekle","urun","kargo",
        "alisveris","indirim","magaza"
      ]
    },

    {
      category: "Haber",
      words: [
        "haber","son dakika","gazete",
        "gundem","spor haberleri"
      ]
    },

    {
      category: "Yazılım",
      words: [
        "yazilim","software","web tasarim",
        "hosting","domain","seo","mobil uygulama"
      ]
    }
  ];

  let best = {
    category: "Genel",
    score: 0
  };

  for (const rule of rules) {

    let score = 0;

    for (const w of rule.words) {
      if (text.includes(normalize(w))) {
        score++;
      }
    }

    if (score > best.score) {
      best = {
        category: rule.category,
        score
      };
    }
  }

  return best.category;
}

function extractKeywordsFromPage($, title, description) {
  const keywords = [];

  const metaKeywords = $('meta[name="keywords"]').attr("content");
  if (metaKeywords) keywords.push(...arr(metaKeywords));

  $("h1,h2,h3").each((i, el) => {
    const txt = cleanText($(el).text(), 90);
    if (txt) keywords.push(txt);
  });

  $("a").each((i, el) => {
    const txt = cleanText($(el).text(), 60);
    if (txt && txt.length > 3 && txt.length < 45) keywords.push(txt);
  });

  const combined = normalize(`${title} ${description} ${keywords.join(" ")}`);
  const words = combined
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !["icin", "ile", "veya", "daha", "hemen", "firma", "hizmet", "iletisim", "anasayfa"].includes(w));

  keywords.push(...words);

  return uniqueList(keywords, 35);
}

async function crawlOneUrl(url) {
  const finalUrl = safeUrl(url);
  if (!finalUrl) throw new Error("Geçersiz URL");

  const response = await axios.get(finalUrl, {
    timeout: 16000,
    maxRedirects: 5,
    maxContentLength: 2 * 1024 * 1024,
    headers: {
      "User-Agent": "NetSearchBot/1.0 (+https://netsearch.com.tr)",
      "Accept": "text/html,application/xhtml+xml"
    }
    
  });
  
  const html = String(response.data || "");
  const $ = cheerio.load(html);

  const title =
    cleanText($("title").first().text(), 90) ||
    cleanText($('meta[property="og:title"]').attr("content"), 90) ||
    getDomain(finalUrl);

  const description =
    cleanText($('meta[name="description"]').attr("content"), 260) ||
    cleanText($('meta[property="og:description"]').attr("content"), 260) ||
    cleanText($("p").first().text(), 240) ||
    title;

  let favicon =
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    $('link[rel="apple-touch-icon"]').attr("href") ||
    "/favicon.ico";

  favicon = absoluteUrl(finalUrl, favicon);

  let image =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    "";

  image = absoluteUrl(finalUrl, image);

  const h1 = cleanText($("h1").first().text(), 90);
  const h2 = cleanText($("h2").first().text(), 90);

  const keywords = extractKeywordsFromPage($, title, description);

  const full = `${title} ${description} ${h1} ${h2} ${keywords.join(" ")}`;
  const category = guessCategoryFromText(full);

  return {
    title,
    description,
    favicon,
    image,
    h1,
    h2,
    keywords,
    category,
    domain: getDomain(finalUrl),
    finalUrl
  };
}
async function crawlSitemap(url) {
  try {
    const sitemapUrl = url.replace(/\/$/, "") + "/sitemap.xml";

    const res = await axios.get(sitemapUrl, {
      timeout: 10000,
      headers: {
        "User-Agent": "NetSearchBot/1.0"
      }
    });

    const xml = res.data;

    const matches = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)];

    return matches
      .map(m => m[1])
      .filter(u => u.startsWith("http"))
      .slice(0, 30);

  } catch (e) {
    return [];
  }
}

app.post("/api/auto-index", async (req, res) => {
  try {
    const { city, district, ownerEmail } = req.body;
    const url = safeUrl(req.body.url);

    if (!url) {
      return res.json({
        success: false,
        message: "Geçerli bir URL gerekli"
      });
    }

    const domain = getDomain(url);

    const already = await Site.findOne({
      status: { $ne: "deleted" },
      $or: [
        { url },
        { website: url },
        { link: url },
        { domain }
      ]
    });

    if (already) {
      return res.json({
        success: false,
        message: "Bu site zaten indexte kayıtlı",
        site: already
      });
    }

    const crawled = await crawlOneUrl(url);

    const newSite = await Site.create(buildSite({
      title: crawled.title,
      name: crawled.title,
      businessName: crawled.title,

      url: crawled.finalUrl,
      website: crawled.finalUrl,
      link: crawled.finalUrl,
      domain: crawled.domain,

      description: crawled.description,
      desc: crawled.description,

      adHeadline1: crawled.h1 || crawled.title,
      adHeadline2: crawled.h2 || crawled.category,
      adHeadline3: crawled.domain,

      adDescription1: crawled.description,
      adDescription2: `${crawled.category} kategorisinde NetSearch tarafından indexlendi.`,

      logo: crawled.favicon,
      logoUrl: crawled.favicon,
      image: crawled.favicon,

      cover: crawled.image,
      coverUrl: crawled.image,
      gallery: crawled.image ? [crawled.image] : [],

      keywords: crawled.keywords,
      tags: crawled.keywords,

      category: crawled.category,

      city: city || "",
      sehir: city || "",
      district: district || "",
      ilce: district || "",
      targetCities: city ? [city] : [],
      targetDistricts: district ? [district] : [],

      ownerEmail: ownerEmail || "",

      approved: true,
      verified: false,
      sponsored: false,
      isSponsored: false,
      sponsorActive: false,

      aiScore: 35,
      status: "active",

      createdBy: "crawler-v1",
      indexedAt: new Date(),
      lastCrawledAt: new Date()
    }));

    res.json({
      success: true,
      message: "Site başarıyla crawler ile indexlendi",
      site: newSite
    });

  } catch (e) {
    console.log("CRAWLER ERROR:", e.message);

    res.status(500).json({
      success: false,
      message: "Site taranamadı",
      error: e.message
    });
  }
});

app.post("/api/crawl-preview", async (req, res) => {
  try {
    const url = safeUrl(req.body.url);

    if (!url) {
      return res.json({
        success: false,
        message: "Geçerli URL gerekli"
      });
    }

    const crawled = await crawlOneUrl(url);

    res.json({
      success: true,
      data: crawled
    });

  } catch (e) {
    res.status(500).json({
      success: false,
      message: "Ön izleme alınamadı",
      error: e.message
    });
  }
});

/* SEARCH */

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";

    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(700);

    const words = normalize(q).split(/\s+/).filter(Boolean);

    let results = sites;

    if (q.trim()) {
      results = sites.filter(site => {
        if (hasNegative(site, q)) return false;
        
        const text = siteText(site);

        return words.some(w => {
          if (text.includes(w)) return true;

          const textWords = text.split(/\s+/);

          return textWords.some(tw => similar(tw, w));
        });
      });
    }

    results = results
      .map(site => {
        const o = site.toObject();

        o.qualityScore = calcQualityScore(o);
        o.adScore = adScore(o, q);
        o.searchScore = score(o, q);
        o.isRelevant = !q.trim() || o.searchScore >= 90;

        return o;
      })
      .filter(o => o.isRelevant)
      .sort((a, b) => b.searchScore - a.searchScore);

    const sponsored = results
      .filter(s =>
        (s.sponsored || s.isSponsored || s.sponsorActive) &&
        Number(s.sponsorBudget || 0) > 0 &&
        Number(s.cpc || s.sponsorCpc || 0) > 0 &&
        dailyLimitAvailable(s)
      )
      .sort((a, b) => b.adScore - a.adScore)
      .slice(0, 5);

    const organic = results
      .filter(s => !sponsored.some(ad => String(ad._id) === String(s._id)))
      .slice(0, 60);

    let aiAnswer = "";

    try {
      if (openai && q.trim()) {
        const summary = [...sponsored, ...organic].slice(0, 5)
          .map((s, i) => `${i + 1}. ${s.title || s.name || s.businessName} - ${s.description || s.desc || ""}`)
          .join("\n");

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Sen NetSearch arama asistanısın. Kısa Türkçe cevap ver." },
            { role: "user", content: `Arama: ${q}\nSonuçlar:\n${summary || "Sonuç yok"}` }
          ],
          max_tokens: 160
        });

        aiAnswer = completion.choices?.[0]?.message?.content || "";
      }
    } catch (e) {
      console.log("AI hata:", e.message);
    }

    res.json({ aiAnswer, sponsored, results: organic });

  } catch (e) {
    console.log("SEARCH ERROR:", e.message);
    res.status(500).json({ aiAnswer: "", sponsored: [], results: [] });
  }
});

app.get("/api/sites", async (req, res) => {
  try {
    const q = req.query.q || "";

    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(700);

    let results = sites;

    if (q.trim()) {
      const words = normalize(q).split(/\s+/).filter(Boolean);
      results = sites.filter(site => {
        if (hasNegative(site, q)) return false;
        const text = siteText(site);
return words.some(w => {
  if (text.includes(w)) return true;

  const textWords = text.split(/\s+/);

  return textWords.some(tw => similar(tw, w));
});s      });
    }

    results = results.map(site => {
      const o = site.toObject();
      o.qualityScore = calcQualityScore(o);
      o.adScore = adScore(o, q);
      o.finalScore = score(o, q);
      o.searchScore = o.finalScore;
      return o;
    }).sort((a, b) => b.finalScore - a.finalScore);

    res.json(results.slice(0, 60));

  } catch {
    res.status(500).json([]);
  }
});

app.get("/api/autocomplete", async (req, res) => {
  try {
    const q = normalize(req.query.q || "");
    if (q.length < 2) return res.json([]);

    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(400);

    const suggestions = [];

    sites.forEach(site => {
      [
        site.title,
        site.name,
        site.businessName,
        site.category,
        site.city,
        site.sehir,
        site.district,
        site.ilce,
        ...arr(site.keywords),
        ...arr(site.tags)
      ].forEach(x => {
        if (x && normalize(x).includes(q)) suggestions.push(x);
      });
    });

    res.json([...new Set(suggestions)].slice(0, 10));

  } catch {
    res.json([]);
  }
});

/* AD VIEW / CLICK ENGINE */

const viewCache = new Map();
const clickCache = new Map();

function cacheKey(type, siteId, req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "ip";
  const day = todayKey();
  return `${type}:${siteId}:${ip}:${day}`;
}

app.post("/api/sites/:id/view", async (req, res) => {
  try {
    const key = cacheKey("view", req.params.id, req);

    if (viewCache.has(key)) {
      return res.json({ success: true, counted: false });
    }

    viewCache.set(key, true);

    const site = await Site.findById(req.params.id);
    if (!site) return res.status(404).json({ success: false });

    await Site.findByIdAndUpdate(req.params.id, {
      $inc: { views: 1 },
      $set: {
        lastViewAt: new Date(),
        qualityScore: calcQualityScore(site),
        adScore: adScore(site, "")
      }
    });

    res.json({ success: true, counted: true });

  } catch {
    res.status(500).json({ success: false });
  }
});

app.post("/api/sites/:id/click", async (req, res) => {
  try {
    const key = cacheKey("click", req.params.id, req);

    if (clickCache.has(key)) {
      return res.json({ success: true, counted: false });
    }

    clickCache.set(key, true);

    const site = await Site.findById(req.params.id);
    if (!site) return res.status(404).json({ success: false });

    const cpc = Number(site.cpc || site.sponsorCpc || 0);
    const budget = Number(site.sponsorBudget || 0);
    const active = site.sponsored || site.isSponsored || site.sponsorActive;
    const today = todayKey();
    const dailySpent = getDailySpent(site);
    const dailyLimit = Number(site.dailyLimit || 0);

    const update = {
      $inc: { clicks: 1 },
      $set: {
        lastClickAt: new Date(),
        qualityScore: calcQualityScore(site),
        adScore: adScore(site, "")
      }
    };

    if (active && cpc > 0 && budget > 0) {
      if (dailyLimit > 0 && dailySpent + cpc > dailyLimit) {
        update.$set.sponsored = false;
        update.$set.isSponsored = false;
        update.$set.sponsorActive = false;
        update.$set.adStoppedReason = "Günlük bütçe limiti doldu";
      } else {
        const newBudget = Math.max(budget - cpc, 0);
        update.$set.sponsorBudget = newBudget;
        update.$set.totalSpent = Number(site.totalSpent || 0) + cpc;
        update.$set.dailySpent = dailySpent + cpc;
        update.$set.dailySpendDate = today;

        if (newBudget <= 0) {
          update.$set.sponsored = false;
          update.$set.isSponsored = false;
          update.$set.sponsorActive = false;
          update.$set.adStoppedReason = "Bütçe bitti";
        }
      }
    }

    await Site.findByIdAndUpdate(req.params.id, update);

    res.json({ success: true, counted: true });

  } catch {
    res.status(500).json({ success: false });
  }
});

/* NEARBY */

app.get("/api/nearby", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const q = req.query.q || "";
    const radius = Number(req.query.radius || 50);

    if (!lat || !lng) {
      return res.json({ success: false, message: "Konum gerekli", results: [] });
    }

    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(1000);

    const words = normalize(q).split(/\s+/).filter(Boolean);

    let results = sites
      .filter(site => Number(site.latitude || 0) && Number(site.longitude || 0))
      .map(site => {
        const o = site.toObject();
        o.distanceKm = Number(distanceKm(lat, lng, Number(o.latitude), Number(o.longitude)).toFixed(2));
        o.qualityScore = calcQualityScore(o);
        o.adScore = adScore(o, q);
        o.searchScore = score(o, q);
        return o;
      })
      .filter(site => site.distanceKm <= radius);

    if (q.trim()) {
      results = results.filter(site => {
        if (hasNegative(site, q)) return false;
        const text = siteText(site);
        return words.length === 0 || words.some(w => text.includes(w));
      });
    }

    results = results.sort((a, b) => {
      const sponsorA = a.sponsored || a.isSponsored || a.sponsorActive ? 1 : 0;
      const sponsorB = b.sponsored || b.isSponsored || b.sponsorActive ? 1 : 0;
      if (sponsorB !== sponsorA) return sponsorB - sponsorA;
      return a.distanceKm - b.distanceKm;
    });

    res.json({ success: true, count: results.length, results: results.slice(0, 60) });

  } catch {
    res.status(500).json({ success: false, results: [] });
  }
});

/* DETAIL / COMMENT */

app.get("/api/sites/:id", async (req, res) => {
  try {
    let site = null;

    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      site = await Site.findById(req.params.id);
    }

    if (!site) {
      site = await Site.findOne({
        slug: req.params.id,
        status: { $ne: "deleted" }
      });
    }

    if (!site) return res.status(404).json({ success: false });

    site.views = Number(site.views || 0) + 1;
    site.qualityScore = calcQualityScore(site);
    site.adScore = adScore(site, "");
    await site.save();

    const comments = await Comment.find({
      siteId: site._id,
      status: { $ne: "deleted" }
    }).sort({ createdAt: -1 });

    res.json({ site, comments });

  } catch {
    res.status(500).json({ success: false });
  }
});

app.post("/api/comments", async (req, res) => {
  try {
    await Comment.create({
      siteId: req.body.siteId,
      name: req.body.name || "Misafir",
      comment: req.body.comment,
      rating: Number(req.body.rating || 5),
      status: "active"
    });

    res.json({ success: true });

  } catch {
    res.status(500).json({ success: false });
  }
});

/* ADMIN */

app.get("/api/admin/stats", async (req, res) => {
  try {
    const sites = await Site.find({ status: { $ne: "deleted" } });
    const comments = await Comment.find({ status: { $ne: "deleted" } });

    res.json({
      totalSites: sites.length,
      pendingSites: sites.filter(s => s.status === "pending").length,
      approvedSites: sites.filter(s => s.status !== "pending").length,
      activeAds: sites.filter(s => s.sponsored || s.isSponsored || s.sponsorActive).length,
      totalComments: comments.length,
      totalUsers: await User.countDocuments(),
      totalViews: sites.reduce((a, s) => a + Number(s.views || 0), 0),
      totalClicks: sites.reduce((a, s) => a + Number(s.clicks || 0), 0),
      totalSpent: sites.reduce((a, s) => a + Number(s.totalSpent || 0), 0)
    });

  } catch {
    res.json({ totalSites: 0, pendingSites: 0, approvedSites: 0, activeAds: 0, totalComments: 0, totalUsers: 0 });
  }
});

app.get("/api/admin/sites", async (req, res) => {
  try {
    const sites = await Site.find({ status: { $ne: "deleted" } }).sort({ createdAt: -1 });
    res.json(sites);
  } catch {
    res.status(500).json([]);
  }
});

app.post("/api/admin/sites", async (req, res) => {
  try {
    const site = await Site.create(buildSite(req.body));
    res.json({ success: true, site });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.put("/api/admin/sites/:id", async (req, res) => {
  try {
    const fixed = buildSite(req.body);
    const site = await Site.findByIdAndUpdate(req.params.id, fixed, { new: true });
    res.json({ success: true, site });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.patch("/api/admin/sites/:id", async (req, res) => {
  try {
    const oldSite = await Site.findById(req.params.id);
    const merged = buildSite({ ...(oldSite ? oldSite.toObject() : {}), ...req.body });
    const site = await Site.findByIdAndUpdate(req.params.id, merged, { new: true });
    res.json({ success: true, site });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.delete("/api/admin/sites/:id", async (req, res) => {
  try {
    await Site.findByIdAndUpdate(req.params.id, { status: "deleted" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* SEO */

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(`User-agent: *
Allow: /

Sitemap: https://netsearch.com.tr/sitemap.xml`);
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).select("_id title slug city category updatedAt");

    const siteUrls = sites.map(site => {
      const slug = site.slug || slugify(site.title || site._id);

      return `
  <url>
    <loc>https://netsearch.com.tr/site/${slug}</loc>
    <lastmod>${new Date(site.updatedAt || Date.now()).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://netsearch.com.tr/site.html?id=${site._id}</loc>
    <lastmod>${new Date(site.updatedAt || Date.now()).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
    }).join("");

    const cityCategoryUrls = [...new Set(
      sites
        .map(site => `${slugify(site.city)}-${slugify(site.category)}`)
        .filter(x => x && x !== "-")
    )].map(slug => `
  <url>
    <loc>https://netsearch.com.tr/${slug}</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`).join("");

    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://netsearch.com.tr/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  ${cityCategoryUrls}
  ${siteUrls}
</urlset>`);

  } catch {
    res.status(500).send("Sitemap oluşturulamadı");
  }
});

/* ROUTES */

app.get("/site/:slug", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "site.html"));
});

app.get("/:cityCategory", async (req, res, next) => {
  try {
    const slug = req.params.cityCategory || "";

    if (
      slug.includes(".") ||
      slug.startsWith("api") ||
      slug === "health" ||
      slug === "robots.txt" ||
      slug === "sitemap.xml"
    ) {
      return next();
    }

    res.sendFile(path.join(__dirname, "public", "index.html"));

  } catch {
    next();
  }
});
const crypto = require("crypto");

app.post("/api/paytr-token", async (req, res) => {
  try {
    const merchant_id = process.env.PAYTR_MERCHANT_ID;
    const merchant_key = process.env.PAYTR_MERCHANT_KEY;
    const merchant_salt = process.env.PAYTR_MERCHANT_SALT;

    const amount = Number(req.body.amount || 100);
    const email = req.body.email || "test@netsearch.com";
    const merchant_oid = "NS" + Date.now();
    const payment_amount = Math.round(amount * 100);

    await Payment.create({
  merchant_oid,
  email,
  amount,
  status: "pending"
});

    const user_ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1").split(",")[0];

    const user_basket = Buffer.from(JSON.stringify([
      ["NetSearch Reklam Bakiyesi", amount.toFixed(2), 1]
    ])).toString("base64");

    const no_installment = "0";
    const max_installment = "0";
    const currency = "TL";
    const test_mode = process.env.PAYTR_TEST_MODE === "true" ? "1" : "0";

    const hashSTR =
      merchant_id +
      user_ip +
      merchant_oid +
      email +
      payment_amount +
      user_basket +
      no_installment +
      max_installment +
      currency +
      test_mode;

    const paytr_token = crypto
      .createHmac("sha256", merchant_key)
      .update(hashSTR + merchant_salt)
      .digest("base64");

    const params = new URLSearchParams({
      merchant_id,
      user_ip,
      merchant_oid,
      email,
      payment_amount: String(payment_amount),
      paytr_token,
      user_basket,
      debug_on: "1",
      no_installment,
      max_installment,
      user_name: "NetSearch Kullanıcısı",
      user_address: "Eskisehir",
      user_phone: "05300000000",
      merchant_ok_url: "https://netsearch.com.tr/user-panel.html?payment=success",
      merchant_fail_url: "https://netsearch.com.tr/user-panel.html?payment=fail",
      timeout_limit: "30",
      currency,
      test_mode,
      lang: "tr",
      iframe_v2: "1"
    });

    const paytrRes = await axios.post(
      "https://www.paytr.com/odeme/api/get-token",
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (paytrRes.data.status !== "success") {
      return res.json({ success: false, error: paytrRes.data.reason || "PayTR token alınamadı" });
    }

    res.json({
      success: true,
      token: paytrRes.data.token,
      iframeUrl: `https://www.paytr.com/odeme/guvenli/${paytrRes.data.token}`,
      merchant_oid
    });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/api/paytr/callback", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const merchant_key = process.env.PAYTR_MERCHANT_KEY;
    const merchant_salt = process.env.PAYTR_MERCHANT_SALT;

    const {
      merchant_oid,
      status,
      total_amount,
      hash
    } = req.body;

    const checkHash = crypto
      .createHmac("sha256", merchant_key)
      .update(merchant_oid + merchant_salt + status + total_amount)
      .digest("base64");

    if (hash !== checkHash) {
      return res.status(400).send("PAYTR notification failed: bad hash");
    }

    if (status === "success") {

  const payment = await Payment.findOne({ merchant_oid });

  if (payment && !payment.processed) {

    payment.status = "success";
    payment.processed = true;

    await payment.save();

    await User.findOneAndUpdate(
      { email: payment.email },
      {
        $inc: {
          balance: Number(payment.amount || 0)
        }
      }
    );

    console.log("BAKİYE EKLENDİ:", payment.email, payment.amount);

  } else {

    console.log("ÖDEME ZATEN İŞLENMİŞ:", merchant_oid);

  }

} else {

  console.log("PAYTR ÖDEME BAŞARISIZ:", merchant_oid);

}

    res.send("OK");

  } catch (e) {
    console.log("PAYTR CALLBACK HATA:", e.message);
    res.status(500).send("ERROR");
  }
});

app.listen(PORT, () => {
  console.log(`NetSearch server ${PORT} portunda çalışıyor`);
});