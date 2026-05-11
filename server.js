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
  max: 120
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
  role: { type: String, default: "user" }
}, { timestamps: true, strict: false });

const siteSchema = new mongoose.Schema({}, { timestamps: true, strict: false });
const commentSchema = new mongoose.Schema({}, { timestamps: true, strict: false });

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Site = mongoose.models.Site || mongoose.model("Site", siteSchema);
const Comment = mongoose.models.Comment || mongoose.model("Comment", commentSchema);

function tokenFor(user) {
  return jwt.sign({
    id: user.id || user._id,
    email: user.email,
    role: user.role
  }, JWT_SECRET, { expiresIn: "7d" });
}

function normalize(t) {
  return String(t || "").toLowerCase()
    .replaceAll("ı", "i").replaceAll("ğ", "g").replaceAll("ü", "u")
    .replaceAll("ş", "s").replaceAll("ö", "o").replaceAll("ç", "c")
    .trim();
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
  const text = normalize(q);
  return arr(site.negativeKeywords).map(normalize).some(w => w && text.includes(w));
}

function calcQualityScore(site) {
  let q = 0;

  if (site.logo || site.logoUrl || site.image) q += 10;
  if (site.cover || site.coverUrl) q += 8;
  if (site.phone || site.telefon || site.whatsapp) q += 10;
  if (site.verified || site.isVerified) q += 15;

  if ((site.description || site.desc || "").length > 50) q += 10;
  if ((site.adHeadline1 || "").length > 5) q += 8;
  if ((site.adHeadline2 || "").length > 5) q += 6;
  if ((site.adHeadline3 || "").length > 5) q += 6;
  if ((site.adDescription1 || "").length > 30) q += 10;
  if ((site.adDescription2 || "").length > 30) q += 8;

  if (arr(site.keywords).length >= 3) q += 8;
  if (arr(site.negativeKeywords).length >= 1) q += 6;
  if (arr(site.targetCities).length || site.city || site.sehir) q += 8;
  if (arr(site.targetDistricts).length || site.district || site.ilce) q += 6;

  const views = Number(site.views || 0);
  const clicks = Number(site.clicks || 0);
  const ctr = views > 0 ? clicks / views : 0;

  if (ctr > 0.02) q += 8;
  if (ctr > 0.05) q += 12;
  if (ctr > 0.10) q += 16;

  return Math.min(Math.round(q), 100);
}

function textMatchStrong(site, q) {
  const query = normalize(q);
  if (!query) return true;
  const title = normalize(site.title || site.name || site.businessName || "");
  const text = siteText(site);
  return title.includes(query) || text.includes(query);
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
  s += quality;
  s += Math.min(ai, 40);
  s += Math.min(ctr * 10, 60);
  s += Math.min(budget / 20, 80);
  s += Math.min(dailyLimit / 20, 50);

  if (site.verified || site.isVerified) s += 25;
  if (textMatchStrong(site, q)) s += 50;

  return Math.round(s);
}

function score(site, q) {
  const query = normalize(q);
  const words = query.split(/\s+/).filter(Boolean);
  const text = siteText(site);
  const title = normalize(site.title || site.name || site.businessName);

  let s = 0;

  if (title === query) s += 120;
  if (title.includes(query)) s += 80;
  if (text.includes(query)) s += 45;

  words.forEach(w => {
    if (title.includes(w)) s += 24;
    if (text.includes(w)) s += 10;
  });

  if (site.sponsored || site.isSponsored || site.sponsorActive) {
    s += adScore(site, q);
  }

  s += Math.min(Number(site.aiScore || 0), 40);
  s += Math.min(calcQualityScore(site), 70);
  s += Math.min(Number(site.views || 0) / 20, 25);
  s += Math.min(Number(site.clicks || 0) / 5, 35);

  if (site.verified || site.isVerified) s += 35;
  if (site.logo || site.logoUrl || site.image) s += 8;
  if (site.cover || site.coverUrl) s += 8;
  if (site.phone || site.telefon || site.whatsapp) s += 10;

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

    approved: b.approved !== false && b.approved !== "false",
    status: b.status || "active",

    sponsored: b.sponsored === true || b.sponsored === "true",
    isSponsored: b.isSponsored === true || b.isSponsored === "true",
    sponsorActive: b.sponsorActive === true || b.sponsorActive === "true",

    verified: b.verified === true || b.verified === "true",
    isVerified: b.isVerified === true || b.isVerified === "true",

    sponsorBudget: Number(b.sponsorBudget || 0),
    dailyLimit: Number(b.dailyLimit || 0),
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
    antiRefresh: "active"
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

    let ok = false;

    if (String(user.password || "").startsWith("$2")) {
      ok = await bcrypt.compare(password, user.password);
    } else {
      ok = user.password === password;
      if (ok) {
        user.password = await bcrypt.hash(password, 10);
        await user.save();
      }
    }

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

app.post("/api/auto-index", async (req, res) => {
  try {
    let { url, city, district, ownerEmail } = req.body;

    if (!url) return res.json({ success: false, message: "URL gerekli" });
    if (!url.startsWith("http")) url = "https://" + url;

    const already = await Site.findOne({
      $or: [{ url }, { website: url }, { link: url }],
      status: { $ne: "deleted" }
    });

    if (already) {
      return res.json({ success: false, message: "Bu site zaten kayıtlı", site: already });
    }

    const response = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { "User-Agent": "NetSearchBot/1.0 (+https://netsearch.com.tr)" }
    });

    const $ = cheerio.load(response.data);

    const title =
      $("title").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      url;

    const description =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      $("p").first().text().trim().slice(0, 220) ||
      "";

    let favicon =
      $('link[rel="icon"]').attr("href") ||
      $('link[rel="shortcut icon"]').attr("href") ||
      "/favicon.ico";

    if (favicon && !favicon.startsWith("http")) favicon = new URL(favicon, url).href;

    let image =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      "";

    if (image && !image.startsWith("http")) image = new URL(image, url).href;

    const keywords = [];
    const metaKeywords = $('meta[name="keywords"]').attr("content");
    if (metaKeywords) keywords.push(...arr(metaKeywords));

    $("h1,h2,h3").each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 70) keywords.push(text);
    });

    const full = normalize(`${title} ${description} ${keywords.join(" ")}`);

    let detectedCategory = "Genel";
    if (full.includes("kombi") || full.includes("servis") || full.includes("tamir")) detectedCategory = "Teknik Servis";
    if (full.includes("restoran") || full.includes("yemek")) detectedCategory = "Restoran";
    if (full.includes("cafe") || full.includes("kahve")) detectedCategory = "Cafe";
    if (full.includes("doktor") || full.includes("hastane") || full.includes("klinik")) detectedCategory = "Sağlık";
    if (full.includes("avukat") || full.includes("hukuk")) detectedCategory = "Hukuk";
    if (full.includes("otel") || full.includes("hotel")) detectedCategory = "Otel";
    if (full.includes("market") || full.includes("alisveris") || full.includes("alışveriş")) detectedCategory = "Market";
    if (full.includes("okul") || full.includes("kurs") || full.includes("egitim") || full.includes("eğitim")) detectedCategory = "Eğitim";

    const newSite = await Site.create(buildSite({
      title,
      name: title,
      businessName: title,
      description,
      desc: description,
      url,
      website: url,
      link: url,
      logo: favicon,
      logoUrl: favicon,
      image: favicon,
      cover: image,
      coverUrl: image,
      gallery: image ? [image] : [],
      keywords: [...new Set(keywords)].slice(0, 20),
      tags: [...new Set(keywords)].slice(0, 20),
      category: detectedCategory,
      city: city || "",
      sehir: city || "",
      district: district || "",
      ilce: district || "",
      ownerEmail: ownerEmail || "",
      approved: true,
      verified: false,
      sponsored: false,
      sponsorActive: false,
      aiScore: 25,
      status: "active",
      createdBy: "auto-index",
      indexedAt: new Date()
    }));

    res.json({ success: true, message: "Site başarıyla otomatik indexlendi", site: newSite });

  } catch (e) {
    console.log("AUTO INDEX ERROR:", e.message);
    res.status(500).json({ success: false, message: "Site taranamadı" });
  }
});

/* SEARCH */

app.get("/api/sites", async (req, res) => {
  try {
    const q = req.query.q || "";

    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(500);

    let results = sites;

    if (q.trim()) {
      const words = normalize(q).split(/\s+/).filter(Boolean);
      results = sites.filter(site => {
        if (hasNegative(site, q)) return false;
        const text = siteText(site);
        return words.some(w => text.includes(w));
      });
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

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";

    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(500);

    const words = normalize(q).split(/\s+/).filter(Boolean);

    let results = sites;

    if (q.trim()) {
      results = sites.filter(site => {
        if (hasNegative(site, q)) return false;
        const text = siteText(site);
        return words.some(w => text.includes(w));
      });
    }

    results = results.map(site => {
      const o = site.toObject();
      o.qualityScore = calcQualityScore(o);
      o.adScore = adScore(o, q);
      o.searchScore = score(o, q);
      return o;
    }).sort((a, b) => b.searchScore - a.searchScore);

    const sponsored = results
      .filter(s =>
        (s.sponsored || s.isSponsored || s.sponsorActive) &&
        Number(s.sponsorBudget || 0) > 0 &&
        Number(s.cpc || s.sponsorCpc || 0) > 0
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

  } catch {
    res.status(500).json({ aiAnswer: "", sponsored: [], results: [] });
  }
});

app.get("/api/autocomplete", async (req, res) => {
  try {
    const q = normalize(req.query.q || "");
    if (q.length < 2) return res.json([]);

    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(300);

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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function cacheKey(type, siteId, req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "ip";
  const day = todayKey();
  return `${type}:${siteId}:${ip}:${day}`;
}

function getDailySpent(site) {
  const today = todayKey();

  if (site.dailySpendDate !== today) {
    return 0;
  }

  return Number(site.dailySpent || 0);
}

function canSpendToday(site, cpc) {
  const dailyLimit = Number(site.dailyLimit || 0);

  if (dailyLimit <= 0) return true;

  const spentToday = getDailySpent(site);

  return spentToday + cpc <= dailyLimit;
}

app.post("/api/sites/:id/view", async (req, res) => {
  try {
    const key = cacheKey("view", req.params.id, req);

    if (viewCache.has(key)) {
      return res.json({
        success: true,
        counted: false,
        message: "Tekrar görüntüleme sayılmadı"
      });
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

    res.json({
      success: true,
      counted: true
    });

  } catch {
    res.status(500).json({ success: false });
  }
});

app.post("/api/sites/:id/click", async (req, res) => {
  try {
    const key = cacheKey("click", req.params.id, req);

    if (clickCache.has(key)) {
      return res.json({
        success: true,
        counted: false,
        message: "Tekrar tıklama sayılmadı"
      });
    }

    clickCache.set(key, true);

    const site = await Site.findById(req.params.id);
    if (!site) return res.status(404).json({ success: false });

    const cpc = Number(site.cpc || site.sponsorCpc || 0);
    const budget = Number(site.sponsorBudget || 0);
    const active = site.sponsored || site.isSponsored || site.sponsorActive;
    const today = todayKey();

    let dailySpent = getDailySpent(site);

    const update = {
      $inc: { clicks: 1 },
      $set: {
        lastClickAt: new Date(),
        qualityScore: calcQualityScore(site),
        adScore: adScore(site, "")
      }
    };

    if (active && cpc > 0 && budget > 0) {

      if (!canSpendToday(site, cpc)) {
        update.$set.sponsored = false;
        update.$set.isSponsored = false;
        update.$set.sponsorActive = false;
        update.$set.adStoppedReason = "Günlük bütçe limiti doldu";

        await Site.findByIdAndUpdate(req.params.id, update);

        return res.json({
          success: true,
          counted: true,
          charged: false,
          message: "Günlük bütçe limiti doldu, reklam durduruldu"
        });
      }

      const newBudget = Math.max(budget - cpc, 0);
      const newDailySpent = dailySpent + cpc;

      update.$set.sponsorBudget = newBudget;
      update.$set.totalSpent = Number(site.totalSpent || 0) + cpc;
      update.$set.dailySpent = newDailySpent;
      update.$set.dailySpendDate = today;

      if (newBudget <= 0) {
        update.$set.sponsored = false;
        update.$set.isSponsored = false;
        update.$set.sponsorActive = false;
        update.$set.adStoppedReason = "Bütçe bitti";
      }
    }

    await Site.findByIdAndUpdate(req.params.id, update);

    res.json({
      success: true,
      counted: true,
      charged: active && cpc > 0 && budget > 0
    });

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

  } catch (e) {
    console.log("NEARBY ERROR:", e.message);
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
      totalUsers: await User.countDocuments()
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
    fixed.qualityScore = calcQualityScore(fixed);
    fixed.adScore = adScore(fixed, "");
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
    merged.qualityScore = calcQualityScore(merged);
    merged.adScore = adScore(merged, "");
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

app.listen(PORT, () => {
  console.log(`NetSearch server ${PORT} portunda çalışıyor`);
});