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

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");

  if (!token) return res.status(401).json({ success: false, message: "Token yok" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: "Token geçersiz" });
  }
}

function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Admin yetkisi gerekli" });
    }
    next();
  });
}

function normalize(t) {
  return String(t || "").toLowerCase()
    .replaceAll("ı","i").replaceAll("ğ","g").replaceAll("ü","u")
    .replaceAll("ş","s").replaceAll("ö","o").replaceAll("ç","c").trim();
}

function arr(v) {
  if (Array.isArray(v)) return v;
  return String(v || "").split(",").map(x => x.trim()).filter(Boolean);
}

function siteText(s) {
  return normalize(`
    ${s.title || ""} ${s.name || ""} ${s.businessName || ""}
    ${s.description || ""} ${s.desc || ""} ${s.address || ""}
    ${s.category || ""} ${s.city || ""} ${s.sehir || ""}
    ${s.district || ""} ${s.ilce || ""} ${arr(s.keywords).join(" ")}
    ${arr(s.tags).join(" ")}
  `);
}

function hasNegative(site, q) {
  const text = normalize(q);
  return arr(site.negativeKeywords).map(normalize).some(w => w && text.includes(w));
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
    s += 80;
    s += Math.min(Number(site.sponsorBudget || 0) / 10, 50);
    s += Math.min(Number(site.cpc || site.sponsorCpc || 0) * 5, 35);
  }

  s += Math.min(Number(site.aiScore || 0), 40);
  s += Math.min(Number(site.qualityScore || 0), 40);
  s += Math.min(Number(site.views || 0) / 20, 25);
  s += Math.min(Number(site.clicks || 0) / 5, 35);

  if (site.verified || site.isVerified) s += 35;
  if (site.logo || site.logoUrl || site.image) s += 8;
  if (site.cover || site.coverUrl) s += 8;
  if (site.phone || site.telefon || site.whatsapp) s += 10;

  return Math.round(s);
}

function buildSite(b) {
  return {
    ...b,
    title: b.title || b.name || b.businessName || "",
    name: b.name || b.title || b.businessName || "",
    businessName: b.businessName || b.title || b.name || "",

    url: b.url || b.website || b.link || "",
    website: b.website || b.url || b.link || "",
    link: b.link || b.url || b.website || "",

    description: b.description || b.desc || "",
    desc: b.desc || b.description || "",

    city: b.city || b.sehir || "",
    sehir: b.sehir || b.city || "",
    district: b.district || b.ilce || "",
    ilce: b.ilce || b.district || "",

    phone: b.phone || b.telefon || "",
    telefon: b.telefon || b.phone || "",

    keywords: arr(b.keywords || b.tags),
    tags: arr(b.tags || b.keywords),
    negativeKeywords: arr(b.negativeKeywords),

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
    aiScore: Number(b.aiScore || 10),
    qualityScore: Number(b.qualityScore || 0),
    latitude: Number(b.latitude || 0),
    longitude: Number(b.longitude || 0)
  };
}

/* HEALTH */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "NetSearch çalışıyor",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "not connected",
    openai: process.env.OPENAI_API_KEY ? "key var" : "key yok",
    jwt: "active",
    upload: "active"
  });
});

/* AUTH */

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!email || !password) return res.json({ success: false, message: "E-posta ve şifre gerekli" });

    const exists = await User.findOne({ email });
    if (exists) return res.json({ success: false, message: "Bu e-posta kayıtlı" });

    const hashed = await bcrypt.hash(password, 10);
    await User.create({ name, email, password: hashed, role: "user" });

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
    if (!user) return res.status(401).json({ success: false, message: "E-posta veya şifre hatalı" });

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

    if (!ok) return res.status(401).json({ success: false, message: "E-posta veya şifre hatalı" });

    const safeUser = {
      id: user._id,
      name: user.name,
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

/* SEARCH */

app.get("/api/sites", async (req, res) => {
  try {
    const q = req.query.q || "";
    const sites = await Site.find({ status: { $ne: "deleted" }, approved: { $ne: false } }).limit(300);

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
      o.finalScore = score(o, q);
      o.searchScore = o.finalScore;
      return o;
    }).sort((a,b) => b.finalScore - a.finalScore);

    res.json(results.slice(0, 40));
  } catch {
    res.status(500).json([]);
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";
    const sites = await Site.find({ status: { $ne: "deleted" }, approved: { $ne: false } }).limit(300);

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
      o.searchScore = score(o, q);
      return o;
    }).sort((a,b) => b.searchScore - a.searchScore);

    const sponsored = results.filter(s => s.sponsored || s.isSponsored || s.sponsorActive).slice(0, 5);
    const organic = results.filter(s => !(s.sponsored || s.isSponsored || s.sponsorActive)).slice(0, 40);

    let aiAnswer = "";
    try {
      if (openai && q.trim()) {
        const summary = [...sponsored, ...organic].slice(0, 5)
          .map((s,i) => `${i+1}. ${s.title || s.name || s.businessName} - ${s.description || s.desc || ""}`)
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

    const sites = await Site.find({ status: { $ne: "deleted" }, approved: { $ne: false } }).limit(200);
    const suggestions = [];

    sites.forEach(site => {
      [
        site.title, site.name, site.businessName, site.category,
        site.city, site.sehir, site.district, site.ilce,
        ...arr(site.keywords), ...arr(site.tags)
      ].forEach(x => {
        if (x && normalize(x).includes(q)) suggestions.push(x);
      });
    });

    res.json([...new Set(suggestions)].slice(0, 10));
  } catch {
    res.json([]);
  }
});

/* SITE DETAIL / COMMENT */

app.get("/api/sites/:id", async (req, res) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) return res.status(404).json({ success: false });

    site.views = Number(site.views || 0) + 1;
    await site.save();

    const comments = await Comment.find({ siteId: site._id, status: { $ne: "deleted" } }).sort({ createdAt: -1 });
    res.json({ site, comments });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.post("/api/sites/:id/click", async (req, res) => {
  try {
    await Site.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
    res.json({ success: true });
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
    res.json({ totalSites:0,pendingSites:0,approvedSites:0,activeAds:0,totalComments:0,totalUsers:0 });
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
    const site = await Site.findByIdAndUpdate(req.params.id, buildSite(req.body), { new: true });
    res.json({ success: true, site });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.patch("/api/admin/sites/:id", async (req, res) => {
  try {
    const site = await Site.findByIdAndUpdate(req.params.id, req.body, { new: true });
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
    const sites = await Site.find({ status: { $ne: "deleted" }, approved: { $ne: false } }).select("_id updatedAt");

    const urls = sites.map(site => `
  <url>
    <loc>https://netsearch.com.tr/site.html?id=${site._id}</loc>
    <lastmod>${new Date(site.updatedAt || Date.now()).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join("");

    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://netsearch.com.tr/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  ${urls}
</urlset>`);
  } catch {
    res.status(500).send("Sitemap oluşturulamadı");
  }
});

app.listen(PORT, () => {
  console.log(`NetSearch server ${PORT} portunda çalışıyor`);
});