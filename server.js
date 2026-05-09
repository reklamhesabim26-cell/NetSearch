require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("MongoDB bağlandı 🔥"))
.catch(err => console.log("MongoDB hata:", err));

const userSchema = new mongoose.Schema({
  name: String,
  company: String,
  email: String,
  phone: String,
  username: String,
  password: String,
  role: { type: String, default: "user" },
  banned: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const siteSchema = new mongoose.Schema({
  title: String,
  url: String,
  keywords: String,
  desc: String,

  category: String,
  logoUrl: String,
  imageUrl: String,
  phone: String,
  address: String,

  seoTitle: String,
  seoDescription: String,

  ownerId: String,
  ownerName: String,
  status: { type: String, default: "pending" },

  adActive: { type: Boolean, default: false },
  isAd: { type: Boolean, default: false },
  balance: { type: Number, default: 0 },
  costPerClick: { type: Number, default: 5 },
  dailyLimit: { type: Number, default: 100 },
  todaySpent: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  paidClicks: { type: Number, default: 0 },
  views: { type: Number, default: 0 },

  city: String,
  district: String,
  negativeKeywords: String,
  createdAt: { type: Date, default: Date.now }
});

const clickSchema = new mongoose.Schema({
  siteId: String,
  userKey: String,
  time: Number
});

const User = mongoose.model("User", userSchema);
const Site = mongoose.model("Site", siteSchema);
const Click = mongoose.model("Click", clickSchema);

function safeUser(user){
  return {
    id: user._id.toString(),
    name: user.name,
    company: user.company,
    email: user.email,
    phone: user.phone,
    username: user.username,
    role: user.role,
    banned: user.banned
  };
}

function safeSite(site){
  const obj = site.toObject();
  obj.id = obj._id.toString();
  return obj;
}

async function createAdmin(){
  const hashedPassword = await bcrypt.hash("123456", 10);

  await User.findOneAndUpdate(
    { username: "enderadmin" },
    {
      name: "Ender Admin",
      company: "NetSearch",
      email: "admin@netsearch.com",
      phone: "05331310226",
      username: "enderadmin",
      password: hashedPassword,
      role: "admin",
      banned: false
    },
    { upsert: true, new: true }
  );

  console.log("Ender admin hesabı hazır ✅");
}

createAdmin();

/* AUTH */

async function registerHandler(req, res){
  try{
    const { name, company, email, phone, username, password } = req.body;

    if(!username || !password){
      return res.status(400).json({ success:false, message:"Kullanıcı adı ve şifre zorunlu." });
    }

    const exists = await User.findOne({
      $or: [{ username }, { email }]
    });

    if(exists){
      return res.status(400).json({ success:false, message:"Bu kullanıcı adı veya e-posta zaten kayıtlı." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      company,
      email,
      phone,
      username,
      password: hashedPassword,
      role: "user"
    });

    res.json({
      success:true,
      message:"Kayıt başarılı.",
      user: safeUser(user)
    });

  }catch(err){
    console.log(err);
    res.status(500).json({ success:false, message:"Sunucu hatası." });
  }
}

async function loginHandler(req, res){
  try{
    const { username, password } = req.body;

    const user = await User.findOne({ username });

    if(!user){
      return res.status(401).json({ success:false, message:"Kullanıcı bulunamadı." });
    }

    if(user.banned){
      return res.status(403).json({ success:false, message:"Hesabınız engellenmiş." });
    }

    const match = await bcrypt.compare(password, user.password);

    if(!match){
      return res.status(401).json({ success:false, message:"Şifre yanlış." });
    }

    res.json({
      success:true,
      message:"Giriş başarılı.",
      username:user.username,
      role:user.role,
      user:safeUser(user)
    });

  }catch(err){
    console.log(err);
    res.status(500).json({ success:false, message:"Sunucu hatası." });
  }
}

app.post("/register", registerHandler);
app.post("/api/register", registerHandler);
app.post("/login", loginHandler);
app.post("/api/login", loginHandler);

/* USERS */

app.get("/api/users", async (req, res) => {
  const users = await User.find().sort({ createdAt:-1 });
  res.json(users.map(safeUser));
});

app.put("/api/users/:id", async (req, res) => {
  try{
    const { name, company, email, phone, username, password, role, banned } = req.body;

    const update = {};
    if(name !== undefined) update.name = name;
    if(company !== undefined) update.company = company;
    if(email !== undefined) update.email = email;
    if(phone !== undefined) update.phone = phone;
    if(username !== undefined) update.username = username;
    if(role !== undefined) update.role = role;
    if(banned !== undefined) update.banned = banned;

    if(password){
      update.password = await bcrypt.hash(password, 10);
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, { new:true });

    if(!user){
      return res.status(404).json({ message:"Kullanıcı bulunamadı." });
    }

    res.json({ message:"Kullanıcı güncellendi.", user:safeUser(user) });

  }catch(err){
    console.log(err);
    res.status(500).json({ message:"Sunucu hatası." });
  }
});

app.delete("/api/users/:id", async (req, res) => {
  const user = await User.findById(req.params.id);

  if(!user){
    return res.status(404).json({ message:"Kullanıcı bulunamadı." });
  }

  if(user.role === "admin"){
    return res.status(403).json({ message:"Admin hesabı silinemez." });
  }

  await User.findByIdAndDelete(req.params.id);

  res.json({ message:"Kullanıcı silindi." });
});

/* SITES */

app.get("/api/sites", async (req, res) => {
  const sites = await Site.find().sort({ createdAt:-1 });
  res.json(sites.map(safeSite));
});

app.post("/api/sites", async (req, res) => {
  try{
    const {
      title,
      url,
      keywords,
      desc,
      category,
      logoUrl,
      imageUrl,
      phone,
      address,
      seoTitle,
      seoDescription,
      ownerId,
      ownerName,
      city,
      district
    } = req.body;

    if(!title || !url || !keywords || !desc){
      return res.status(400).json({ message:"Başlık, link, anahtar kelime ve açıklama zorunlu." });
    }

    const site = await Site.create({
      title,
      url,
      keywords,
      desc,
      category: category || "Genel",
      logoUrl: logoUrl || "",
      imageUrl: imageUrl || "",
      phone: phone || "",
      address: address || "",
      seoTitle: seoTitle || title,
      seoDescription: seoDescription || desc,
      ownerId: ownerId || null,
      ownerName: ownerName || "Admin",
      status: ownerId ? "pending" : "approved",
      city: city || "",
      district: district || "",
      negativeKeywords: ""
    });

    res.json({
      message: ownerId ? "Site onay bekliyor." : "Site kaydedildi.",
      site:safeSite(site)
    });

  }catch(err){
    console.log(err);
    res.status(500).json({ message:"Sunucu hatası." });
  }
});

app.delete("/api/sites/:id", async (req, res) => {
  await Site.findByIdAndDelete(req.params.id);
  res.json({ message:"Site silindi." });
});

app.put("/api/sites/:id/status", async (req, res) => {
  const { status } = req.body;

  if(!["pending","approved","rejected"].includes(status)){
    return res.status(400).json({ message:"Geçersiz durum." });
  }

  const site = await Site.findByIdAndUpdate(
    req.params.id,
    { status },
    { new:true }
  );

  if(!site){
    return res.status(404).json({ message:"Site bulunamadı." });
  }

  res.json({ message:"Site durumu güncellendi.", site:safeSite(site) });
});

app.put("/api/sites/:id", async (req, res) => {
  try{
    const allowed = [
      "title","url","keywords","desc","category","logoUrl","imageUrl",
      "phone","address","seoTitle","seoDescription","city","district","negativeKeywords"
    ];

    const update = {};

    allowed.forEach(field => {
      if(req.body[field] !== undefined){
        update[field] = req.body[field];
      }
    });

    const site = await Site.findByIdAndUpdate(req.params.id, update, { new:true });

    if(!site){
      return res.status(404).json({ message:"Site bulunamadı." });
    }

    res.json({ message:"Site güncellendi.", site:safeSite(site) });

  }catch(err){
    console.log(err);
    res.status(500).json({ message:"Sunucu hatası." });
  }
});

app.put("/api/sites/:id/ad", async (req, res) => {
  const { adActive, balance, costPerClick, dailyLimit, city, district, negativeKeywords } = req.body;

  const update = {};

  if(typeof adActive === "boolean"){
    update.adActive = adActive;
    update.isAd = adActive;
  }

  if(balance !== undefined) update.balance = Number(balance);
  if(costPerClick !== undefined) update.costPerClick = Number(costPerClick);
  if(dailyLimit !== undefined) update.dailyLimit = Number(dailyLimit);
  if(city !== undefined) update.city = city;
  if(district !== undefined) update.district = district;
  if(negativeKeywords !== undefined) update.negativeKeywords = negativeKeywords;

  const site = await Site.findByIdAndUpdate(req.params.id, update, { new:true });

  if(!site){
    return res.status(404).json({ message:"Site bulunamadı." });
  }

  res.json({ message:"Reklam ayarları güncellendi.", site:safeSite(site) });
});

app.post("/api/sites/:id/view", async (req, res) => {
  const site = await Site.findByIdAndUpdate(
    req.params.id,
    { $inc:{ views:1 } },
    { new:true }
  );

  if(!site){
    return res.status(404).json({ message:"Site bulunamadı." });
  }

  res.json({ message:"Görüntülenme kaydedildi." });
});

app.post("/api/sites/:id/click", async (req, res) => {
  const id = req.params.id;
  const userKey = req.ip + "-" + (req.headers["user-agent"] || "unknown");
  const now = Date.now();
  const protectionMs = 60 * 1000;

  const site = await Site.findById(id);

  if(!site){
    return res.status(404).json({ message:"Site bulunamadı." });
  }

  const recentClick = await Click.findOne({
    siteId:id,
    userKey,
    time:{ $gt: now - protectionMs }
  });

  site.clicks += 1;

  if(recentClick){
    await site.save();

    return res.json({
      message:"Tıklama sayıldı ama ücret kesilmedi.",
      charged:false,
      site:safeSite(site)
    });
  }

  await Click.create({
    siteId:id,
    userKey,
    time:now
  });

  if(site.adActive){
    const cpc = Number(site.costPerClick || 0);

    if(
      Number(site.balance || 0) >= cpc &&
      Number(site.todaySpent || 0) + cpc <= Number(site.dailyLimit || 0)
    ){
      site.balance -= cpc;
      site.todaySpent += cpc;
      site.paidClicks += 1;
    }else{
      site.adActive = false;
      site.isAd = false;
    }
  }

  await site.save();

  res.json({
    message:"Tıklama kaydedildi.",
    charged:true,
    site:safeSite(site)
  });
});

/* SEO */

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(`User-agent: *
Allow: /
Sitemap: https://netsearch.onrender.com/sitemap.xml`);
});

app.get("/sitemap.xml", async (req, res) => {
  const sites = await Site.find({ status:"approved" }).sort({ createdAt:-1 });

  const urls = sites.map(site => `
  <url>
    <loc>https://netsearch.onrender.com/</loc>
    <lastmod>${new Date(site.createdAt).toISOString()}</lastmod>
  </url>`).join("");

  res.type("application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://netsearch.onrender.com/</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
  </url>
  ${urls}
</urlset>`);
});

/* PAGES */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`NetSearch çalışıyor 🚀 http://localhost:${PORT}`);
});