require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB bağlantısı başarılı"))
  .catch((err) => console.error("MongoDB bağlantı hatası:", err.message));

const SiteSchema = new mongoose.Schema(
  {
    title: String,
    name: String,
    url: String,
    website: String,
    description: String,
    desc: String,
    category: String,
    tags: [String],
    keywords: [String],
    city: String,
    district: String,
    phone: String,
    telefon: String,
    whatsapp: String,
    logo: String,
    image: String,
    cover: String,

    status: { type: String, default: "active" },

    isSponsored: { type: Boolean, default: false },
    sponsorActive: { type: Boolean, default: false },
    sponsorBudget: { type: Number, default: 0 },
    sponsorCpc: { type: Number, default: 0 },
    sponsorClicks: { type: Number, default: 0 },
    sponsorViews: { type: Number, default: 0 },

    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },

    ownerEmail: String
  },
  { timestamps: true }
);

const CommentSchema = new mongoose.Schema(
  {
    siteId: { type: mongoose.Schema.Types.ObjectId, ref: "Site" },
    name: String,
    comment: String,
    rating: Number,
    status: { type: String, default: "active" }
  },
  { timestamps: true }
);

const UserSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    password: String,
    role: { type: String, default: "user" }
  },
  { timestamps: true }
);

const Site = mongoose.models.Site || mongoose.model("Site", SiteSchema);
const Comment = mongoose.models.Comment || mongoose.model("Comment", CommentSchema);
const User = mongoose.models.User || mongoose.model("User", UserSchema);

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

function siteText(site) {
  return normalize([
    site.title,
    site.name,
    site.description,
    site.desc,
    site.category,
    site.city,
    site.district,
    ...(site.tags || []),
    ...(site.keywords || [])
  ].join(" "));
}

function calculateScore(site, query) {
  const q = normalize(query);
  const words = q.split(" ").filter(Boolean);
  const text = siteText(site);

  let score = 0;

  const title = normalize(site.title || site.name);
  const category = normalize(site.category);
  const city = normalize(site.city);
  const district = normalize(site.district);

  if (title === q) score += 120;
  if (title.includes(q)) score += 80;
  if (text.includes(q)) score += 45;

  words.forEach((word) => {
    if (title.includes(word)) score += 20;
    if (category.includes(word)) score += 18;
    if (city.includes(word)) score += 16;
    if (district.includes(word)) score += 14;
    if (text.includes(word)) score += 8;
  });

  if (site.isSponsored || site.sponsorActive) {
    score += 70;
    score += Math.min(Number(site.sponsorBudget || 0) / 10, 40);
    score += Math.min(Number(site.sponsorCpc || 0) * 5, 30);
  }

  score += Math.min(Number(site.rating || 0) * 8, 40);
  score += Math.min(Number(site.reviewCount || 0) * 2, 30);
  score += Math.min(Number(site.clicks || 0) / 5, 35);
  score += Math.min(Number(site.views || 0) / 20, 25);

  const ctr =
    Number(site.views || 0) > 0
      ? Number(site.clicks || 0) / Number(site.views || 1)
      : 0;

  score += Math.min(ctr * 100, 30);

  const descLength = String(site.description || site.desc || "").length;
  if (descLength > 60) score += 10;
  if (site.logo || site.image) score += 8;
  if (site.cover) score += 8;
  if (site.phone || site.telefon || site.whatsapp) score += 10;
  if (site.updatedAt) score += 5;

  return Math.round(score);
}

async function getAiAnswer(query, results) {
  try {
    if (!openai) return "";

    const siteSummary = results
      .slice(0, 5)
      .map((s, i) => `${i + 1}. ${s.title || s.name} - ${s.description || s.desc || ""}`)
      .join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Sen NetSearch AI arama asistanısın. Türkçe, kısa, net ve güvenli cevap ver. Kesin olmayan bilgileri kesin gibi anlatma."
        },
        {
          role: "user",
          content: `Arama: ${query}\n\nİlgili sonuçlar:\n${siteSummary || "Sonuç yok"}\n\nKullanıcıya kısa bir arama özeti ver.`
        }
      ],
      max_tokens: 220,
      temperature: 0.4
    });

    return completion.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.log("AI geçici kapalı:", err.message);
    return "";
  }
}

function safeRegex(query) {
  const clean = String(query || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(clean.split(/\s+/).filter(Boolean).join("|"), "i");
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "NetSearch çalışıyor",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "not connected",
    openai: process.env.OPENAI_API_KEY ? "key var" : "key yok"
  });
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";

    if (!q.trim()) {
      return res.json({ aiAnswer: "", sponsored: [], results: [] });
    }

    const regex = safeRegex(q);

    let sites = await Site.find({
      status: { $ne: "deleted" },
      $or: [
        { title: regex },
        { name: regex },
        { description: regex },
        { desc: regex },
        { category: regex },
        { city: regex },
        { district: regex },
        { tags: regex },
        { keywords: regex }
      ]
    }).limit(150);

    sites = sites
      .map((site) => {
        const obj = site.toObject();
        obj.searchScore = calculateScore(obj, q);
        return obj;
      })
      .filter((site) => site.searchScore > 0)
      .sort((a, b) => b.searchScore - a.searchScore);

    const sponsored = sites
      .filter((s) => s.isSponsored || s.sponsorActive)
      .sort((a, b) => b.searchScore - a.searchScore)
      .slice(0, 5);

    const results = sites
      .filter((s) => !(s.isSponsored || s.sponsorActive))
      .sort((a, b) => b.searchScore - a.searchScore)
      .slice(0, 40);

    const ids = [...sponsored, ...results].map((s) => s._id);
    if (ids.length) {
      await Site.updateMany({ _id: { $in: ids } }, { $inc: { views: 1 } });
      await Site.updateMany(
        { _id: { $in: sponsored.map((s) => s._id) } },
        { $inc: { sponsorViews: 1 } }
      );
    }

    const aiAnswer = await getAiAnswer(q, results.length ? results : sites);

    res.json({ aiAnswer, sponsored, results });
  } catch (err) {
    console.error("Arama hatası:", err.message);
    res.status(500).json({
      aiAnswer: "",
      sponsored: [],
      results: [],
      error: "Arama sırasında hata oluştu"
    });
  }
});

app.get("/api/autocomplete", async (req, res) => {
  try {
    const q = req.query.q || "";
    if (q.length < 2) return res.json([]);

    const regex = safeRegex(q);

    const sites = await Site.find({
      status: { $ne: "deleted" },
      $or: [
        { title: regex },
        { name: regex },
        { category: regex },
        { city: regex },
        { district: regex },
        { tags: regex },
        { keywords: regex }
      ]
    })
      .limit(20)
      .select("title name category city district tags keywords");

    const suggestions = [];

    sites.forEach((site) => {
      if (site.title) suggestions.push(site.title);
      if (site.name) suggestions.push(site.name);
      if (site.category) suggestions.push(site.category);
      if (site.city) suggestions.push(site.city);
      if (site.district) suggestions.push(site.district);
      if (Array.isArray(site.tags)) suggestions.push(...site.tags);
      if (Array.isArray(site.keywords)) suggestions.push(...site.keywords);
    });

    res.json(
      [...new Set(suggestions)]
        .filter((x) => normalize(x).includes(normalize(q)))
        .slice(0, 10)
    );
  } catch {
    res.json([]);
  }
});

app.post("/api/sites", async (req, res) => {
  try {
    const b = req.body;

    const site = await Site.create({
      title: b.title || b.name,
      name: b.name || b.title,
      url: b.url || b.website,
      website: b.website || b.url,
      description: b.description || b.desc,
      desc: b.desc || b.description,
      category: b.category,
      tags: Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(",").map(x => x.trim()).filter(Boolean),
      keywords: Array.isArray(b.keywords) ? b.keywords : String(b.keywords || "").split(",").map(x => x.trim()).filter(Boolean),
      city: b.city,
      district: b.district,
      phone: b.phone || b.telefon,
      telefon: b.telefon || b.phone,
      whatsapp: b.whatsapp,
      logo: b.logo,
      image: b.image,
      cover: b.cover,
      ownerEmail: b.ownerEmail,
      status: b.status || "active"
    });

    res.json({ success: true, message: "Site eklendi", site });
  } catch (err) {
    res.status(500).json({ success: false, message: "Site eklenemedi" });
  }
});

app.get("/api/sites", async (req, res) => {
  const sites = await Site.find({ status: { $ne: "deleted" } })
    .sort({ createdAt: -1 })
    .limit(100);

  res.json(sites);
});

app.get("/api/sites/:id", async (req, res) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) return res.status(404).json({ error: "Site bulunamadı" });

    site.views = Number(site.views || 0) + 1;
    await site.save();

    const comments = await Comment.find({
      siteId: site._id,
      status: { $ne: "deleted" }
    }).sort({ createdAt: -1 });

    res.json({ site, comments });
  } catch {
    res.status(500).json({ error: "Detay alınamadı" });
  }
});

app.post("/api/sites/:id/click", async (req, res) => {
  try {
    const site = await Site.findById(req.params.id);
    if (!site) return res.json({ success: false });

    const update = { $inc: { clicks: 1 } };

    if (site.isSponsored || site.sponsorActive) {
      update.$inc.sponsorClicks = 1;

      if (Number(site.sponsorBudget || 0) > 0 && Number(site.sponsorCpc || 0) > 0) {
        update.$inc.sponsorBudget = -Math.abs(Number(site.sponsorCpc || 0));
      }
    }

    await Site.findByIdAndUpdate(req.params.id, update);

    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.post("/api/comments", async (req, res) => {
  try {
    const comment = await Comment.create({
      siteId: req.body.siteId,
      name: req.body.name,
      comment: req.body.comment,
      rating: Number(req.body.rating || 5),
      status: "active"
    });

    const comments = await Comment.find({
      siteId: req.body.siteId,
      status: { $ne: "deleted" }
    });

    const avg =
      comments.reduce((sum, c) => sum + Number(c.rating || 0), 0) /
      Math.max(comments.length, 1);

    await Site.findByIdAndUpdate(req.body.siteId, {
      rating: Math.round(avg * 10) / 10,
      reviewCount: comments.length
    });

    res.json({ success: true, message: "Yorum eklendi", comment });
  } catch {
    res.status(500).json({ success: false, message: "Yorum eklenemedi" });
  }
});

app.get("/api/admin/sites", async (req, res) => {
  const sites = await Site.find({ status: { $ne: "deleted" } }).sort({ createdAt: -1 });
  res.json(sites);
});

app.put("/api/admin/sites/:id", async (req, res) => {
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
    res.json({ success: true, message: "Site silindi" });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.get("/api/owner/stats", async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: "email gerekli" });

    const sites = await Site.find({
      ownerEmail: email,
      status: { $ne: "deleted" }
    }).select("title name views clicks sponsorViews sponsorClicks sponsorBudget sponsorCpc rating reviewCount");

    res.json({ success: true, sites });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const exists = await User.findOne({ email: req.body.email });
    if (exists) return res.status(400).json({ success: false, message: "Bu e-posta kayıtlı" });

    const user = await User.create({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      role: "user"
    });

    res.json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const user = await User.findOne({
      email: req.body.email,
      password: req.body.password
    });

    if (!user) return res.status(401).json({ success: false, message: "E-posta veya şifre hatalı" });

    res.json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(`User-agent: *
Allow: /

Sitemap: https://netsearch.com.tr/sitemap.xml`);
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const sites = await Site.find({ status: { $ne: "deleted" } }).select("_id updatedAt");

    const urls = sites.map(site => `
  <url>
    <loc>https://netsearch.com.tr/site.html?id=${site._id}</loc>
    <lastmod>${new Date(site.updatedAt).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join("");

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