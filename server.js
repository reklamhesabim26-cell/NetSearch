require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB bağlantısı başarılı"))
  .catch((err) => console.error("MongoDB bağlantı hatası:", err));

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
    status: {
      type: String,
      default: "pending"
    },
    isSponsored: {
      type: Boolean,
      default: false
    },
    sponsorActive: {
      type: Boolean,
      default: false
    },
    sponsorBudget: {
      type: Number,
      default: 0
    },
    clicks: {
      type: Number,
      default: 0
    },
    views: {
      type: Number,
      default: 0
    },
    rating: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

const CommentSchema = new mongoose.Schema(
  {
    siteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Site"
    },
    name: String,
    comment: String,
    rating: Number,
    status: {
      type: String,
      default: "pending"
    }
  },
  { timestamps: true }
);

const UserSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    password: String,
    role: {
      type: String,
      default: "user"
    }
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

  if (normalize(site.title || site.name).includes(q)) score += 60;
  if (text.includes(q)) score += 35;

  words.forEach((word) => {
    if (text.includes(word)) score += 10;
  });

  if (site.isSponsored || site.sponsorActive) score += 25;
  if (site.rating) score += Number(site.rating) * 3;
  if (site.views) score += Math.min(site.views / 20, 10);
  if (site.clicks) score += Math.min(site.clicks / 10, 15);

  return score;
}

async function getAiAnswer(query, organicResults) {
  try {
    if (!openai) {
      return "";
    }

    const siteSummary = organicResults
      .slice(0, 5)
      .map((site, index) => {
        return `${index + 1}. ${site.title || site.name || "Site"} - ${site.description || site.desc || ""}`;
      })
      .join("\n");

    if (!process.env.OPENAI_API_KEY) {
  return "";
}

const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Sen NetSearch adlı yeni nesil arama motorunun AI cevap asistanısın. Kullanıcıya kısa, net ve faydalı Türkçe cevap ver. Kesin olmayan bilgileri kesinmiş gibi söyleme."
        },
        {
          role: "user",
          content: `
Kullanıcının araması: ${query}

Veritabanındaki ilgili site sonuçları:
${siteSummary || "Henüz ilgili site bulunamadı."}

Bu arama için kullanıcıya kısa bir AI cevabı ver.
`
        }
      ],
      max_tokens: 220,
      temperature: 0.4
    });

    return completion.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.log("AI geçici olarak devre dışı:", err.message);
    return "";
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "NetSearch server çalışıyor",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "not connected",
    openai: process.env.OPENAI_API_KEY ? "key var" : "key yok"
  });
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";

    if (!q.trim()) {
      return res.json({
        aiAnswer: "",
        sponsored: [],
        results: []
      });
    }

    const regex = new RegExp(q.split(" ").join("|"), "i");

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
    }).limit(80);

    sites = sites
      .map((site) => {
        const obj = site.toObject();
        obj.searchScore = calculateScore(obj, q);
        return obj;
      })
      .filter((site) => site.searchScore > 0)
      .sort((a, b) => b.searchScore - a.searchScore);

    const sponsored = sites
      .filter((site) => site.isSponsored || site.sponsorActive)
      .slice(0, 5);

    const results = sites
      .filter((site) => !(site.isSponsored || site.sponsorActive))
      .slice(0, 30);

    const aiAnswer = await getAiAnswer(q, results.length ? results : sites);

    res.json({
      aiAnswer,
      sponsored,
      results
    });
  } catch (err) {
    console.error("Arama hatası:", err);
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

    if (q.length < 2) {
      return res.json([]);
    }

    const regex = new RegExp(q, "i");

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
      .limit(10)
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

    const clean = [...new Set(suggestions)]
      .filter((item) => normalize(item).includes(normalize(q)))
      .slice(0, 8);

    res.json(clean);
  } catch (err) {
    console.error("Autocomplete hata:", err);
    res.json([]);
  }
});

app.post("/api/sites", async (req, res) => {
  try {
    const body = req.body;

    const site = await Site.create({
      title: body.title || body.name,
      name: body.name || body.title,
      url: body.url || body.website,
      website: body.website || body.url,
      description: body.description || body.desc,
      desc: body.desc || body.description,
      category: body.category,
      tags: Array.isArray(body.tags)
        ? body.tags
        : String(body.tags || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
      keywords: Array.isArray(body.keywords)
        ? body.keywords
        : String(body.keywords || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
      city: body.city,
      district: body.district,
      phone: body.phone || body.telefon,
      telefon: body.telefon || body.phone,
      whatsapp: body.whatsapp,
      logo: body.logo,
      image: body.image,
      cover: body.cover,
      status: body.status || "active"
    });

    res.json({
      success: true,
      message: "Site başarıyla eklendi",
      site
    });
  } catch (err) {
    console.error("Site ekleme hatası:", err);
    res.status(500).json({
      success: false,
      message: "Site eklenirken hata oluştu"
    });
  }
});

app.get("/api/sites", async (req, res) => {
  try {
    const sites = await Site.find({ status: { $ne: "deleted" } })
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(sites);
  } catch (err) {
    res.status(500).json({ error: "Siteler alınamadı" });
  }
});

app.get("/api/sites/:id", async (req, res) => {
  try {
    const site = await Site.findById(req.params.id);

    if (!site) {
      return res.status(404).json({ error: "Site bulunamadı" });
    }

    site.views = Number(site.views || 0) + 1;
    await site.save();

    const comments = await Comment.find({
      siteId: site._id,
      status: { $ne: "deleted" }
    }).sort({ createdAt: -1 });

    res.json({
      site,
      comments
    });
  } catch (err) {
    res.status(500).json({ error: "Detay alınamadı" });
  }
});

app.post("/api/sites/:id/click", async (req, res) => {
  try {
    await Site.findByIdAndUpdate(req.params.id, {
      $inc: { clicks: 1 }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/comments", async (req, res) => {
  try {
    const comment = await Comment.create({
      siteId: req.body.siteId,
      name: req.body.name,
      comment: req.body.comment,
      rating: req.body.rating,
      status: "active"
    });

    res.json({
      success: true,
      message: "Yorum eklendi",
      comment
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Yorum eklenemedi"
    });
  }
});

app.get("/api/admin/sites", async (req, res) => {
  try {
    const sites = await Site.find({ status: { $ne: "deleted" } }).sort({ createdAt: -1 });
    res.json(sites);
  } catch (err) {
    res.status(500).json({ error: "Admin siteleri alınamadı" });
  }
});

app.put("/api/admin/sites/:id", async (req, res) => {
  try {
    const updated = await Site.findByIdAndUpdate(req.params.id, req.body, {
      new: true
    });

    res.json({
      success: true,
      site: updated
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Site güncellenemedi"
    });
  }
});

app.delete("/api/admin/sites/:id", async (req, res) => {
  try {
    await Site.findByIdAndUpdate(req.params.id, {
      status: "deleted"
    });

    res.json({
      success: true,
      message: "Site silindi"
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Site silinemedi"
    });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const exists = await User.findOne({ email: req.body.email });

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Bu e-posta zaten kayıtlı"
      });
    }

    const user = await User.create({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      role: "user"
    });

    res.json({
      success: true,
      message: "Kayıt başarılı",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Kayıt hatası"
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const user = await User.findOne({
      email: req.body.email,
      password: req.body.password
    });

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
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Giriş hatası"
    });
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
    const sites = await Site.find({
      status: { $ne: "deleted" }
    }).select("_id updatedAt");

    const urls = sites
      .map((site) => {
        return `
  <url>
    <loc>https://netsearch.com.tr/detail.html?id=${site._id}</loc>
    <lastmod>${new Date(site.updatedAt).toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
      })
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
  } catch (err) {
    res.status(500).send("Sitemap oluşturulamadı");
  }
});

app.listen(PORT, () => {
  console.log(`NetSearch server ${PORT} portunda çalışıyor`);
});