const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI)
.then(() => {
    console.log("MongoDB bağlantısı başarılı");
})
.catch((err) => {
    console.log("MongoDB bağlantı hatası:", err.message);
});





/* =========================
   MODELLER
========================= */

const userSchema = new mongoose.Schema({
    name: String,
    email: String,
    password: String,
    role: {
        type: String,
        default: "user"
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const siteSchema = new mongoose.Schema({
    title: String,
    url: String,
    category: String,
    city: String,
    district: String,
    phone: String,
    address: String,
    keywords: String,
    negativeKeywords: String,
    desc: String,
    logo: String,
    cover: String,
    gallery: [String],

    seoTitle: String,
    seoDesc: String,

    sponsored: {
        type: Boolean,
        default: false
    },

    sponsorBudget: {
        type: Number,
        default: 0
    },

    cpc: {
        type: Number,
        default: 0
    },

    dailyLimit: {
        type: Number,
        default: 0
    },

    cityScore: {
        type: Number,
        default: 10
    },

    aiScore: {
        type: Number,
        default: 10
    },

    popularityScore: {
        type: Number,
        default: 10
    },

    commentScore: {
        type: Number,
        default: 0
    },

    clickRate: {
        type: Number,
        default: 0
    },

    views: {
        type: Number,
        default: 0
    },

    clicks: {
        type: Number,
        default: 0
    },

    approved: {
        type: Boolean,
        default: true
    },

    createdAt: {
        type: Date,
        default: Date.now
    }
});

const User = mongoose.model("User", userSchema);
const Site = mongoose.model("Site", siteSchema);





/* =========================
   SCORE SİSTEMİ
========================= */

function normalize(text) {
    return (text || "")
    .toString()
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

function calculateScore(site, query) {

    const q = normalize(query);

    let score = 0;

    const text = normalize(`
        ${site.title}
        ${site.desc}
        ${site.category}
        ${site.city}
        ${site.district}
        ${site.keywords}
    `);

    if (text.includes(q)) {
        score += 40;
    }

    const words = q.split(" ");

    words.forEach(word => {
        if (text.includes(word)) {
            score += 12;
        }
    });

    score += Number(site.aiScore || 0);
    score += Number(site.cityScore || 0);
    score += Number(site.popularityScore || 0);
    score += Number(site.commentScore || 0);

    if (site.sponsored) {
        score += 100;
    }

    return score;
}





/* =========================
   HEALTH
========================= */

app.get("/health", async (req, res) => {

    let mongoStatus = "not connected";

    if (mongoose.connection.readyState === 1) {
        mongoStatus = "connected";
    }

    res.json({
        ok: true,
        message: "NetSearch çalışıyor",
        mongo: mongoStatus,
        openai: process.env.OPENAI_API_KEY ? "key var" : "key yok"
    });
});





/* =========================
   REGISTER
========================= */

app.post("/api/register", async (req, res) => {

    try {

        const { name, email, password } = req.body;

        const existing = await User.findOne({ email });

        if (existing) {
            return res.json({
                success: false,
                message: "Bu email zaten kayıtlı"
            });
        }

        const user = new User({
            name,
            email,
            password,
            role: "user"
        });

        await user.save();

        res.json({
            success: true,
            message: "Kayıt başarılı"
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            message: "Register hatası"
        });
    }
});





/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {

    try {

        const { email, password } = req.body;

        if (
            (email === "enderadmin" ||
            email === "admin" ||
            email === "reklamhesabim26@gmail.com")
            &&
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

        const user = await User.findOne({
            email,
            password
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





/* =========================
   SİTE EKLE
========================= */

app.post("/api/sites", async (req, res) => {

    try {

        const newSite = new Site(req.body);

        await newSite.save();

        res.json({
            success: true,
            message: "Site başarıyla eklendi"
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            success: false,
            message: "Site eklenemedi"
        });
    }
});





/* =========================
   TÜM SİTELER
========================= */

app.get("/api/sites", async (req, res) => {

    try {

        const query = req.query.q || "";

        const allSites = await Site.find({
            approved: true
        });

        const results = allSites
        .map(site => {

            const score = calculateScore(site, query);

            return {
                ...site._doc,
                finalScore: score
            };

        })
        .sort((a, b) => b.finalScore - a.finalScore);

        res.json(results);

    } catch (err) {

        res.status(500).json({
            success: false,
            message: "Site listesi alınamadı"
        });
    }
});





/* =========================
   TEK SİTE
========================= */

app.get("/api/sites/:id", async (req, res) => {

    try {

        const site = await Site.findById(req.params.id);

        if (!site) {
            return res.status(404).json({
                success: false
            });
        }

        site.views += 1;

        await site.save();

        res.json(site);

    } catch (err) {

        res.status(500).json({
            success: false
        });
    }
});





/* =========================
   TIKLAMA
========================= */

app.post("/api/sites/:id/click", async (req, res) => {

    try {

        const site = await Site.findById(req.params.id);

        if (!site) {
            return res.status(404).json({
                success: false
            });
        }

        site.clicks += 1;

        await site.save();

        res.json({
            success: true
        });

    } catch (err) {

        res.status(500).json({
            success: false
        });
    }
});





/* =========================
   ADMIN İSTATİSTİK
========================= */

app.get("/api/admin/stats", async (req, res) => {

    try {

        const totalSites = await Site.countDocuments();
        const totalUsers = await User.countDocuments();

        const sponsored = await Site.countDocuments({
            sponsored: true
        });

        res.json({
            totalSites,
            totalUsers,
            sponsored
        });

    } catch (err) {

        res.status(500).json({
            success: false
        });
    }
});





/* =========================
   SAYFALAR
========================= */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/register", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/user-panel", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "user-panel.html"));
});





/* =========================
   SERVER
========================= */

app.listen(PORT, () => {
    console.log(`NetSearch server ${PORT} portunda çalışıyor`);
});