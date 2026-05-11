require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGODB_URI || process.env.MONGO_URI;

let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

mongoose
  .connect(MONGO_URL)
  .then(() => console.log("MongoDB bağlantısı başarılı"))
  .catch((err) => console.log("MongoDB bağlantı hatası:", err.message));

const userSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    password: String,
    role: { type: String, default: "user" }
  },
  { timestamps: true, strict: false }
);

const siteSchema = new mongoose.Schema(
  {
    title: String,
    name: String,
    businessName: String,

    url: String,
    website: String,
    link: String,

    description: String,
    desc: String,
    address: String,

    category: String,
    city: String,
    sehir: String,
    district: String,
    ilce: String,

    phone: String,
    telefon: String,
    whatsapp: String,

    keywords: mongoose.Schema.Types.Mixed,
    tags: mongoose.Schema.Types.Mixed,
    negativeKeywords: mongoose.Schema.Types.Mixed,

    logo: String,
    logoUrl: String,
    image: String,
    cover: String,
    coverUrl: String,
    gallery: [String],

    approved: { type: Boolean, default: true },
    status: { type: String, default: "active" },

    sponsored: { type: Boolean, default: false },
    isSponsored: { type: Boolean, default: false },
    sponsorActive: { type: Boolean, default: false },

    sponsorBudget: { type: Number, default: 0 },
    cpc: { type: Number, default: 0 },
    sponsorCpc: { type: Number, default: 0 },
    dailyLimit: { type: Number, default: 0 },

    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },

    aiScore: { type: Number, default: 10 },
    cityScore: { type: Number, default: 10 },
    popularityScore: { type: Number, default: 10 },
    commentScore: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },

    ownerEmail: String
  },
  { timestamps: true, strict: false }
);

const commentSchema = new mongoose.Schema(
  {
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: "Site" },
    name: String,
    comment: String,
    rating: Number,
    status: { type: String, default: "active" }
  },
  { timestamps: true, strict: false }
);

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Site = mongoose.models.Site || mongoose.model("Site", siteSchema);
const Comment = mongoose.models.Comment || mongoose.model("Comment", commentSchema);

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replaceAll("ı", "i")
    .replaceAll("ğ", "g")
    .replaceAll("ü", "u")
    .replaceAll("ş", "s")
    .replaceAll("ö", "o")
    .replaceAll("ç", "c")
    .trim();
}

function toText(value) {
  if (Array.isArray(value)) return value.join(" ");
  return String(value || "");
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function siteSearchText(site) {
  return normalize(`
    ${site.title || ""}
    ${site.name || ""}
    ${site.businessName || ""}
    ${site.description || ""}
    ${site.desc || ""}
    ${site.address || ""}
    ${site.category || ""}
    ${site.city || ""}
    ${site.sehir || ""}
    ${site.district || ""}
    ${site.ilce || ""}
    ${toText(site.keywords)}
    ${toText(site.tags)}
  `);
}

function hasNegativeKeyword(site, query) {
  const q = normalize(query);
  const negatives = toArray(site.negativeKeywords).map(normalize);
  return negatives.some((word) => word && q.includes(word));
}

function calculateScore(site, query) {
  const q = normalize(query);
  const words = q.split(/\s+/).filter(Boolean);
  const text = siteSearchText(site);

  let score = 0;

  const title = normalize(site.title || site.name || site.businessName);
  const category = normalize(site.category);
  const city = normalize(site.city || site.sehir);
  const district = normalize(site.district || site.ilce);

  if (title === q) score += 120;
  if (title.includes(q)) score += 80;
  if (text.includes(q)) score += 45;

  words.forEach((word) => {
    if (title.includes(word)) score += 24;
    if (category.includes(word)) score += 18;
    if (city.includes(word)) score += 16;
    if (district.includes(word)) score += 14;
    if (text.includes(word)) score += 10;
  });

  if (site.sponsored || site.isSponsored || site.sponsorActive) {
    score += 80;
    score += Math.min(Number(site.sponsorBudget || 0) / 10, 50);
    score += Math.min(Number(site.cpc || site.sponsorCpc || 0) * 5, 35);
  }

  score += Math.min(Number(site.aiScore || 0), 40);
  score += Math.min(Number(site.cityScore || 0), 30);
  score += Math.min(Number(site.popularityScore || 0), 30);
  score += Math.min(Number(site.commentScore || 0), 30);
  score += Math.min(Number(site.rating || 0) * 8, 40);
  score += Math.min(Number(site.reviewCount || 0) * 2, 30);
  score += Math.min(Number(site.clicks || 0) / 5, 35);
  score += Math.min(Number(site.views || 0) / 20, 25);

  const views = Number(site.views || 0);
  const clicks = Number(site.clicks || 0);
  if (views > 0) score += Math.min((clicks / views) * 100, 30);

  if (site.logo || site.logoUrl || site.image) score += 8;
  if (site.cover || site.coverUrl) score += 8;
  if (site.phone || site.telefon || site.whatsapp) score += 10;

  return Math.round(score);
}

function buildSiteFromBody(b) {
  return {
    title: b.title || b.name || b.businessName || "",
    name: b.name || b.title || b.businessName || "",
    businessName: b.businessName || b.title || b.name || "",

    url: b.url || b.website || b.link || "",
    website: b.website || b.url || b.link || "",
    link: b.link || b.url || b.website || "",

    description: b.description || b.desc || b.address || "",
    desc: b.desc || b.description || b.address || "",
    address: b.address || "",

    category: b.category || "Genel",
    city: b.city || b.sehir || "",
    sehir: b.sehir || b.city || "",
    district: b.district || b.ilce || "",
    ilce: b.ilce || b.district || "",

    phone: b.phone || b.telefon || "",
    telefon: b.telefon || b.phone || "",
    whatsapp: b.whatsapp || b.phone || b.telefon || "",

    keywords: toArray(b.keywords || b.tags),
    tags: toArray(b.tags || b.keywords),
    negativeKeywords: toArray(b.negativeKeywords),

    logo: b.logo || b.logoUrl || "",
    logoUrl: b.logoUrl || b.logo || "",
    image: b.image || b.logo || b.logoUrl || "",
    cover: b.cover || b.coverUrl || b.image || "",
    coverUrl: b.coverUrl || b.cover || b.image || "",

    approved: b.approved !== false,
    status: b.status || "active",

    sponsored: b.sponsored === true || b.sponsored === "true",
    isSponsored: b.isSponsored === true || b.isSponsored === "true",
    sponsorActive: b.sponsorActive === true || b.sponsorActive === "true",

    sponsorBudget: Number(b.sponsorBudget || 0),
    cpc: Number(b.cpc || b.sponsorCpc || 0),
    sponsorCpc: Number(b.sponsorCpc || b.cpc || 0),
    dailyLimit: Number(b.dailyLimit || 0),

    aiScore: Number(b.aiScore || 10),
    cityScore: Number(b.cityScore || 10),
    popularityScore: Number(b.popularityScore || 10),
    commentScore: Number(b.commentScore || 0),

    ownerEmail: b.ownerEmail || b.email || ""
  };
}

async function getAiAnswer(query, results) {
  try {
    if (!openai) return "";

    const summary = results
      .slice(0, 5)
      .map((s, i) => `${i + 1}. ${s.title || s.name || s.businessName} - ${s.description || s.desc || ""}`)
      .join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Sen NetSearch arama asistanısın. Kısa ve net Türkçe cevap ver."
        },
        {
          role: "user",
          content: `Arama: ${query}\nSonuçlar:\n${summary || "Sonuç yok"}`
        }
      ],
      max_tokens: 160,
      temperature: 0.4
    });

    return completion.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.log("AI geçici kapalı:", err.message);
    return "";
  }
}

/* SAYFALAR */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* HEALTH */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "NetSearch çalışıyor",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "not connected",
    openai: process.env.OPENAI_API_KEY ? "key var" : "key yok"
  });
});

/* AUTH */

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const exists = await User.findOne({ email });
    if (exists) {
      return res.json({ success: false, message: "Bu e-posta zaten kayıtlı" });
    }

    await User.create({ name, email, password, role: "user" });

    res.json({ success: true, message: "Kayıt başarılı" });
  } catch {
    res.status(500).json({ success: false, message: "Kayıt hatası" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      (email === "enderadmin" || email === "admin" || email === "reklamhesabim26@gmail.com") &&
      password === "123456"
    ) {
      return res.json({
        success: true,
        message: "Admin girişi başarılı",
        user: {
          id: "admin",
          name: "Ender Admin",
          email: "reklamhesabim26@gmail.com",
          role: "admin"
        }
      });
    }

    const user = await User.findOne({ email, password });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "E-posta veya şifre hatalı"
      });
    }

    res.json({
      success: true,
      message: "Giriş başarılı",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch {
    res.status(500).json({ success: false, message: "Giriş hatası" });
  }
});

/* ARAMA */

app.get("/api/sites", async (req, res) => {
  try {
    const q = req.query.q || "";

    const allSites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(300);

    let results = allSites;

    if (q.trim()) {
      const words = normalize(q).split(/\s+/).filter(Boolean);

      results = allSites.filter((site) => {
        if (hasNegativeKeyword(site, q)) return false;

        const text = siteSearchText(site);

        return words.some((word) => text.includes(word));
      });
    }

    results = results
      .map((site) => {
        const obj = site.toObject();
        obj.finalScore = calculateScore(obj, q);
        obj.searchScore = obj.finalScore;
        return obj;
      })
      .sort((a, b) => {
        const adA = a.sponsored || a.isSponsored || a.sponsorActive ? 1 : 0;
        const adB = b.sponsored || b.isSponsored || b.sponsorActive ? 1 : 0;

        if (adA !== adB) return adB - adA;
        return b.finalScore - a.finalScore;
      });

    const ids = results.slice(0, 40).map((x) => x._id);
    if (ids.length) {
      await Site.updateMany({ _id: { $in: ids } }, { $inc: { views: 1 } });
    }

    res.json(results.slice(0, 40));
  } catch (err) {
    console.log("Site arama hatası:", err.message);
    res.status(500).json([]);
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";

    const allSites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).limit(300);

    const words = normalize(q).split(/\s+/).filter(Boolean);

    let results = allSites;

    if (q.trim()) {
      results = allSites.filter((site) => {
        if (hasNegativeKeyword(site, q)) return false;
        const text = siteSearchText(site);
        return words.some((word) => text.includes(word));
      });
    }

    results = results
      .map((site) => {
        const obj = site.toObject();
        obj.searchScore = calculateScore(obj, q);
        return obj;
      })
      .sort((a, b) => b.searchScore - a.searchScore);

    const sponsored = results
      .filter((s) => s.sponsored || s.isSponsored || s.sponsorActive)
      .slice(0, 5);

    const organic = results
      .filter((s) => !(s.sponsored || s.isSponsored || s.sponsorActive))
      .slice(0, 40);

    const aiAnswer = await getAiAnswer(q, [...sponsored, ...organic]);

    res.json({
      aiAnswer,
      sponsored,
      results: organic
    });
  } catch (err) {
    console.log("Search hata:", err.message);
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
    }).limit(200);

    const suggestions = [];

    sites.forEach((site) => {
      [
        site.title,
        site.name,
        site.businessName,
        site.category,
        site.city,
        site.sehir,
        site.district,
        site.ilce,
        ...toArray(site.keywords),
        ...toArray(site.tags)
      ].forEach((x) => {
        if (x && normalize(x).includes(q)) suggestions.push(x);
      });
    });

    res.json([...new Set(suggestions)].slice(0, 10));
  } catch {
    res.json([]);
  }
});

/* SİTE EKLEME */

app.post("/api/sites", async (req, res) => {
  try {
    const site = await Site.create(buildSiteFromBody(req.body));
    res.json({ success: true, message: "Site eklendi", site });
  } catch (err) {
    console.log("Site ekleme hatası:", err.message);
    res.status(500).json({ success: false, message: "Site eklenemedi" });
  }
});

app.get("/api/sites/:id", async (req, res) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) return res.status(404).json({ success: false });

    site.views = Number(site.views || 0) + 1;
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

app.post("/api/sites/:id/click", async (req, res) => {
  try {
    await Site.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* YORUM */

app.post("/api/comments", async (req, res) => {
  try {
    const comment = await Comment.create({
      siteId: req.body.siteId,
      name: req.body.name,
      comment: req.body.comment,
      rating: Number(req.body.rating || 5),
      status: "active"
    });

    res.json({ success: true, comment });
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
      pendingSites: sites.filter((s) => s.status === "pending").length,
      approvedSites: sites.filter((s) => s.status !== "pending").length,
      activeAds: sites.filter((s) => s.sponsored || s.isSponsored || s.sponsorActive).length,
      totalComments: comments.length,
      totalUsers: await User.countDocuments()
    });
  } catch {
    res.json({
      totalSites: 0,
      pendingSites: 0,
      approvedSites: 0,
      activeAds: 0,
      totalComments: 0,
      totalUsers: 0
    });
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
    const site = await Site.create(buildSiteFromBody(req.body));
    res.json({ success: true, message: "Site eklendi", site });
  } catch (err) {
    console.log("Admin site ekleme hatası:", err.message);
    res.status(500).json({ success: false, message: "Site eklenemedi" });
  }
});

app.put("/api/admin/sites/:id", async (req, res) => {
  try {
    const updated = await Site.findByIdAndUpdate(req.params.id, buildSiteFromBody(req.body), {
      new: true
    });
    res.json({ success: true, site: updated });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.patch("/api/admin/sites/:id", async (req, res) => {
  try {
    const updated = await Site.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, site: updated });
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
  res.type("text/plain");
  res.send(`User-agent: *
Allow: /

Sitemap: https://netsearch.com.tr/sitemap.xml`);
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const sites = await Site.find({
      status: { $ne: "deleted" },
      approved: { $ne: false }
    }).select("_id updatedAt");

    const urls = sites
      .map(
        (site) => `
  <url>
    <loc>https://netsearch.com.tr/site.html?id=${site._id}</loc>
    <lastmod>${new Date(site.updatedAt || Date.now()).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`
      )
      .join("");

    res.type("application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
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