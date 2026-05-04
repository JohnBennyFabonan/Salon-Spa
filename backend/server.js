require("dotenv").config({ override: true });

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcrypt");
const path = require("path");
const nodemailer = require("nodemailer");

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} = require("@aws-sdk/client-s3");

const app = express();
const PORT = Number(process.env.PORT || 5000);
const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
const ALLOWED_BOOKING_STATUSES = ["Pending", "Approved", "Done", "Cancelled"];
const ALLOWED_PAYMENT_TYPES = ["gcash", "bpi", "maya"];

app.use(
  cors({
    origin: (process.env.CORS_ORIGINS || "http://127.0.0.1:5500,http://localhost:5500")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(express.json({ limit: "2mb" }));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const s3 = new S3Client({
  region: process.env.AWS_REGION || "ap-southeast-2",
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_FILE_SIZE_BYTES || 5 * 1024 * 1024),
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/gif",
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error("Only image uploads are allowed"));
    }

    cb(null, true);
  },
});

function getS3FileUrl(key) {
  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

function extractS3KeyFromUrl(url) {
  if (!url) return null;

  const prefix = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/`;
  if (url.startsWith(prefix)) return url.replace(prefix, "");

  return url.split(".amazonaws.com/")[1] || null;
}

function buildSafeFileName(originalName = "file") {
  const ext = path.extname(originalName);
  const base = path
    .basename(originalName, ext)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 60);

  return `${Date.now()}-${base || "upload"}${ext}`;
}

async function uploadFileToS3(file) {
  if (!process.env.AWS_BUCKET_NAME) {
    throw new Error("S3 not configured");
  }

  const key = buildSafeFileName(file.originalname);

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );

    return { key, imageUrl: getS3FileUrl(key) };

  } catch (err) {
    console.error("❌ S3 upload failed:", err.message);
    throw new Error("Upload failed");
  }
}

async function deleteFileFromS3ByUrl(url) {
  if (!process.env.AWS_BUCKET_NAME) {
    console.log("⚠️ S3 not configured, skipping delete");
    return;
  }

  const key = extractS3KeyFromUrl(url);
  if (!key) return;

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
      })
    );
  } catch (err) {
    console.log("⚠️ Failed to delete from S3");
  }
}

function parseRules(rules) {
  if (!rules) return [];
  if (Array.isArray(rules)) return rules.map((r) => String(r).trim()).filter(Boolean);
  return String(rules)
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function validatePaymentType(paymentType) {
  return ALLOWED_PAYMENT_TYPES.includes(String(paymentType || "").trim().toLowerCase());
}

/* ===============================
ROOT + HEALTH
=============================== */
app.get("/", (req, res) => {
  res.send("Server running");
});

app.get("/health", async (req, res) => {
  // ✅ Safe DB check
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.log("⚠️ DB health check failed:", err.message);
  }

  // ✅ Safe AWS check
  try {
    if (process.env.AWS_BUCKET_NAME) {
      await s3.send(
        new HeadBucketCommand({ Bucket: process.env.AWS_BUCKET_NAME })
      );
    }
  } catch (err) {
    console.log("⚠️ S3 health check failed:", err.message);
  }

  // ✅ ALWAYS respond (this prevents 502)
  res.status(200).json({ ok: true });
});

/* ===============================
GALLERY
=============================== */
app.post("/gallery", upload.single("image"), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const { title, category } = req.body;
  let uploaded;

  try {
    uploaded = await uploadFileToS3(req.file);

    const result = await pool.query(
      `INSERT INTO gallery (title, category, image_url)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [title?.trim() || "No title", category?.trim() || "Uncategorized", uploaded.imageUrl]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }
    throw error;
  }
}));

app.get("/gallery", asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM gallery ORDER BY id DESC");
  res.json(result.rows);
}));

app.delete("/gallery/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query("SELECT image_url FROM gallery WHERE id = $1", [id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  await deleteFileFromS3ByUrl(result.rows[0].image_url).catch(() => {});
  await pool.query("DELETE FROM gallery WHERE id = $1", [id]);

  res.json({ message: "Deleted" });
}));

/* ===============================
GET CATEGORIES (NEW)
=============================== */
app.get("/categories", asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT category 
    FROM gallery 
    WHERE category IS NOT NULL
    ORDER BY category ASC
  `);

  res.json(result.rows);
}));

/* ===============================
SPECIALISTS
=============================== */
app.post("/specialists", upload.single("image"), asyncHandler(async (req, res) => {
  const { name, role, specialty, bio } = req.body;

  if (!name || !role) {
    return res.status(400).json({ error: "Name and role are required" });
  }

  let uploaded = null;
  try {
    if (req.file) uploaded = await uploadFileToS3(req.file);

    const result = await pool.query(
      `INSERT INTO specialists (name, role, specialty, bio, image_url)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [name.trim(), role.trim(), specialty?.trim() || "", bio?.trim() || "", uploaded?.imageUrl || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }
    throw error;
  }
}));

app.get("/specialists", asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM specialists ORDER BY id DESC");
  res.json(result.rows);
}));

app.delete("/specialists/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query("SELECT image_url FROM specialists WHERE id = $1", [id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  await deleteFileFromS3ByUrl(result.rows[0].image_url).catch(() => {});
  await pool.query("DELETE FROM specialists WHERE id = $1", [id]);

  res.json({ message: "Deleted" });
}));

app.put("/specialists/:id", upload.single("image"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, role, specialty, bio } = req.body;

  const existing = await pool.query("SELECT image_url FROM specialists WHERE id = $1", [id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  let uploaded = null;
  try {
    if (req.file) uploaded = await uploadFileToS3(req.file);

    const result = await pool.query(
      `UPDATE specialists
       SET name = $1,
           role = $2,
           specialty = $3,
           bio = $4,
           image_url = COALESCE($5, image_url)
       WHERE id = $6
       RETURNING *`,
      [
        name?.trim() || "",
        role?.trim() || "",
        specialty?.trim() || "",
        bio?.trim() || "",
        uploaded?.imageUrl || null,
        id,
      ]
    );

    if (uploaded?.imageUrl && existing.rows[0].image_url) {
      await deleteFileFromS3ByUrl(existing.rows[0].image_url).catch(() => {});
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }
    throw error;
  }
}));

/* ===============================
SERVICES
=============================== */
app.post("/services", upload.single("image"), asyncHandler(async (req, res) => {
  const { name, description, price, duration, category } = req.body;

  if (!name || !description || !category) {
    return res.status(400).json({ error: "Name, description, and category are required" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }

  let uploaded;
  try {
    uploaded = await uploadFileToS3(req.file);

    const result = await pool.query(
      `INSERT INTO services (name, description, price, duration, category, image_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        name.trim(),
        description.trim(),
        toNumber(price),
        duration?.trim() || "",
        category.trim(),
        uploaded.imageUrl,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }
    throw error;
  }
}));

app.get("/services", asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM services ORDER BY id DESC");
  res.json(result.rows);
}));

app.delete("/services/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query("SELECT image_url FROM services WHERE id = $1", [id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Not found" });
  }

  await deleteFileFromS3ByUrl(result.rows[0].image_url).catch(() => {});
  await pool.query("DELETE FROM services WHERE id = $1", [id]);

  res.json({ message: "Deleted" });
}));

/* ===============================
UPDATE SERVICE (NEW)
=============================== */
app.put("/services/:id", upload.single("image"), asyncHandler(async (req, res) => {

  const { id } = req.params;
  const { name, description, price, duration, category } = req.body;

  const existing = await pool.query(
    "SELECT image_url FROM services WHERE id = $1",
    [id]
  );

  if (existing.rows.length === 0) {
    return res.status(404).json({ error: "Service not found" });
  }

  let uploaded = null;

  try {

    // Upload new image if provided
    if (req.file) {
      uploaded = await uploadFileToS3(req.file);
    }

    const result = await pool.query(
      `UPDATE services SET
        name = $1,
        description = $2,
        price = $3,
        duration = $4,
        category = $5,
        image_url = COALESCE($6, image_url)
      WHERE id = $7
      RETURNING *`,
      [
        name?.trim(),
        description?.trim(),
        toNumber(price),
        duration?.trim() || "",
        category?.trim(),
        uploaded?.imageUrl || null,
        id
      ]
    );

    // Delete old image if replaced
    if (uploaded?.imageUrl && existing.rows[0].image_url) {
      await deleteFileFromS3ByUrl(existing.rows[0].image_url).catch(() => {});
    }

    res.json(result.rows[0]);

  } catch (error) {

    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }

    throw error;
  }

}));

/* ===============================
USERS / AUTH
=============================== */
app.post("/register", asyncHandler(async (req, res) => {
  const { name, contact, email, password, securityQuestion, securityAnswer } = req.body;

  if (!name || !email || !password || !securityQuestion || !securityAnswer) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  // 🔒 ✅ ADD THIS (OTP CHECK)
  const check = await pool.query(
    "SELECT * FROM otp_codes WHERE email=$1 AND verified=true ORDER BY id DESC LIMIT 1",
    [email.trim().toLowerCase()]
  );

  if (check.rows.length === 0) {
    return res.status(400).json({ error: "Email not verified" });
  }

  // ✅ existing user check
  const existing = await pool.query(
    "SELECT id FROM users WHERE email = $1",
    [email.trim().toLowerCase()]
  );

  if (existing.rows.length > 0) {
    return res.status(400).json({ error: "Email already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const hashedSecurityAnswer = await bcrypt.hash(
    String(securityAnswer).trim().toLowerCase(),
    SALT_ROUNDS
  );

  const result = await pool.query(
    `INSERT INTO users (name, contact, email, password, security_question, security_answer)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, name, contact, email, role`,
    [
      name.trim(),
      contact?.trim() || "",
      email.trim().toLowerCase(),
      hashedPassword,
      securityQuestion.trim(),
      hashedSecurityAnswer,
    ]
  );

  res.status(201).json(result.rows[0]);
}));

app.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()]);
  if (result.rows.length === 0) {
    return res.status(400).json({ error: "User not found" });
  }

  const user = result.rows[0];
  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.status(400).json({ error: "Invalid password" });
  }

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });
}));

app.get("/users", asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, email, contact, role FROM users ORDER BY id DESC"
  );
  res.json(result.rows);
}));

app.put("/users/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, contact, password } = req.body;

  let hashedPassword = null;
  if (password) {
    hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  }

  await pool.query(
    `UPDATE users
     SET name = $1,
         email = $2,
         contact = $3,
         password = COALESCE($4, password)
     WHERE id = $5`,
    [
      name?.trim() || "",
      email?.trim().toLowerCase() || "",
      contact?.trim() || "",
      hashedPassword,
      id,
    ]
  );

  res.json({ message: "Updated" });
}));

app.delete("/users/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
  res.json({ message: "Deleted" });
}));

/* ===============================
BOOKINGS
=============================== */
const createBookingHandler = asyncHandler(async (req, res) => {
  const {
    services,
    totalPrice,
    totalAmount,
    price,
    downpayment,
    remaining,
    date,
    time,
    staff,
    notes,
    receipt,
    status,
    email,
    customer,
    customerName,
    bookingType,
    type,
    promo,
    promoTitle,
    promoType,
    promoId,
  } = req.body;

  const resolvedCustomer = customer || customerName;
  const resolvedType = bookingType || type || "service";
  const safeStatus = ALLOWED_BOOKING_STATUSES.includes(status) ? status : "Pending";

  if (!email || !resolvedCustomer) {
    return res.status(400).json({ error: "Missing user info (email or customer)" });
  }

  if (!date || !time) {
    return res.status(400).json({ error: "Missing date or time" });
  }

  if (resolvedType === "promo") {
    const total = toNumber(totalAmount ?? price ?? totalPrice);
    const down = downpayment !== undefined ? toNumber(downpayment) : total * 0.1;
    const remain = remaining !== undefined ? toNumber(remaining) : total - down;

    const promoServices = [
      {
        name: promoTitle || promo || "Promo Booking",
        type: promoType || "Promo",
        promo_id: promoId || null,
      },
    ];

    const result = await pool.query(
      `INSERT INTO bookings
       (email, customer, services, total_price, downpayment, remaining, date, time, staff, notes, receipt, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        String(email).trim().toLowerCase(),
        String(resolvedCustomer).trim(),
        JSON.stringify(promoServices),
        total,
        down,
        remain,
        date,
        time,
        staff?.trim() || "",
        notes?.trim() || `Promo: ${promoTitle || promo || "Promo Booking"}`,
        receipt?.trim() || "",
        safeStatus,
      ]
    );

    return res.status(201).json(result.rows[0]);
  }

  if (!Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ error: "No services selected" });
  }

  const total = toNumber(totalPrice ?? totalAmount ?? price);
  const down = downpayment !== undefined ? toNumber(downpayment) : total * 0.1;
  const remain = remaining !== undefined ? toNumber(remaining) : total - down;

  const result = await pool.query(
    `INSERT INTO bookings
     (email, customer, services, total_price, downpayment, remaining, date, time, staff, notes, receipt, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      String(email).trim().toLowerCase(),
      String(resolvedCustomer).trim(),
      JSON.stringify(services),
      total,
      down,
      remain,
      date,
      time,
      staff?.trim() || "",
      notes?.trim() || "",
      receipt?.trim() || "",
      safeStatus,
    ]
  );

  res.status(201).json(result.rows[0]);
});

const getBookingsHandler = asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM bookings ORDER BY id DESC");
  res.json(result.rows);
});

const updateBookingStatusHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!ALLOWED_BOOKING_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid booking status" });
  }

  await pool.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, id]);
  res.json({ success: true });
});

app.post("/bookings", createBookingHandler);
app.get("/bookings", getBookingsHandler);
app.put("/bookings/:id", updateBookingStatusHandler);

/* Compatibility aliases */
app.post("/api/bookings", createBookingHandler);
app.get("/api/bookings", getBookingsHandler);
app.put("/api/bookings/:id", updateBookingStatusHandler);

/* ===============================
UPLOAD RECEIPT
=============================== */
app.post("/upload-receipt", upload.single("image"), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const uploaded = await uploadFileToS3(req.file);
  res.json({ imageUrl: uploaded.imageUrl });
}));

/* ===============================
PROMOS
=============================== */
app.post("/api/promos", upload.single("image"), asyncHandler(async (req, res) => {
  const {
    id,
    title,
    type,
    highlight,
    dealPrice,
    oldPrice,
    validity,
    status,
    desc,
    rules,
  } = req.body;

  if (!id || !title || !type) {
    return res.status(400).json({ error: "Promo id, title, and type are required" });
  }

  let uploaded = null;
  try {
    if (req.file) uploaded = await uploadFileToS3(req.file);

    await pool.query(
      `INSERT INTO promos
       (id, title, type, highlight, deal_price, old_price, validity, status, description, rules, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        title,
        type,
        highlight || "",
        toNumber(dealPrice),
        toNumber(oldPrice),
        validity || "",
        status || "Active",
        desc || "",
        parseRules(rules),
        uploaded?.imageUrl || null,
      ]
    );

    res.status(201).json({ success: true });
  } catch (error) {
    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }
    throw error;
  }
}));

app.get("/api/promos", asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM promos ORDER BY id DESC");
  res.json(result.rows);
}));

app.put("/api/promos/:id", upload.single("image"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, type, highlight, dealPrice, oldPrice, validity, status, desc, rules } = req.body;

  const existing = await pool.query("SELECT image_url FROM promos WHERE id = $1", [id]);
  if (existing.rows.length === 0) {
    return res.status(404).json({ error: "Promo not found" });
  }

  let uploaded = null;
  try {
    if (req.file) uploaded = await uploadFileToS3(req.file);

    await pool.query(
      `UPDATE promos SET
        title = $1,
        type = $2,
        highlight = $3,
        deal_price = $4,
        old_price = $5,
        validity = $6,
        status = $7,
        description = $8,
        rules = $9,
        image_url = COALESCE($10, image_url)
      WHERE id = $11`,
      [
        title,
        type,
        highlight || "",
        toNumber(dealPrice),
        toNumber(oldPrice),
        validity || "",
        status || "Active",
        desc || "",
        parseRules(rules),
        uploaded?.imageUrl || null,
        id,
      ]
    );

    if (uploaded?.imageUrl && existing.rows[0].image_url) {
      await deleteFileFromS3ByUrl(existing.rows[0].image_url).catch(() => {});
    }

    res.json({ success: true });
  } catch (error) {
    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }
    throw error;
  }
}));

app.delete("/api/promos/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await pool.query("SELECT image_url FROM promos WHERE id = $1", [id]);

  if (existing.rows.length === 0) {
    return res.status(404).json({ error: "Promo not found" });
  }

  await deleteFileFromS3ByUrl(existing.rows[0].image_url).catch(() => {});
  await pool.query("DELETE FROM promos WHERE id = $1", [id]);

  res.json({ success: true });
}));

/* ===============================
RATINGS
=============================== */
app.post("/ratings", asyncHandler(async (req, res) => {
  const { booking_id, email, stars, feedback } = req.body;

  if (!booking_id || !email || !stars) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const numericStars = toNumber(stars);
  if (numericStars < 1 || numericStars > 5) {
    return res.status(400).json({ error: "Invalid rating value" });
  }

  const existing = await pool.query("SELECT id FROM ratings WHERE booking_id = $1", [booking_id]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: "You already rated this booking" });
  }

  await pool.query(
    `INSERT INTO ratings (booking_id, email, stars, feedback)
     VALUES ($1, $2, $3, $4)`,
    [booking_id, String(email).trim().toLowerCase(), numericStars, feedback || ""]
  );

  res.json({ success: true, message: "Rating saved" });
}));

app.get("/ratings", asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT
      r.id,
      r.stars,
      r.feedback,
      r.created_at,
      r.booking_id,
      b.services,
      b.email
    FROM ratings r
    JOIN bookings b ON r.booking_id = b.id
    ORDER BY r.created_at DESC
  `);

  res.json(result.rows);
}));

/* ===============================
PAYMENT QR CODES
=============================== */
const uploadPaymentQrHandler = asyncHandler(async (req, res) => {
  const paymentType = String(req.params.paymentType || "").trim().toLowerCase();

  if (!validatePaymentType(paymentType)) {
    return res.status(400).json({ error: "Invalid payment type" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const existing = await pool.query(
    "SELECT image_url, s3_key FROM payment_qrs WHERE payment_type = $1",
    [paymentType]
  );

  let uploaded = null;

  try {
    uploaded = await uploadFileToS3(req.file);

    await pool.query(
      `INSERT INTO payment_qrs (payment_type, image_url, s3_key, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (payment_type)
       DO UPDATE SET
         image_url = EXCLUDED.image_url,
         s3_key = EXCLUDED.s3_key,
         updated_at = NOW()`,
      [paymentType, uploaded.imageUrl, uploaded.key]
    );

    if (existing.rows.length > 0 && existing.rows[0].image_url) {
      await deleteFileFromS3ByUrl(existing.rows[0].image_url).catch(() => {});
    }

    res.json({
      success: true,
      paymentType,
      imageUrl: uploaded.imageUrl,
      s3Key: uploaded.key,
    });
  } catch (error) {
    if (uploaded?.imageUrl) {
      await deleteFileFromS3ByUrl(uploaded.imageUrl).catch(() => {});
    }
    throw error;
  }
});

const listPaymentQrsHandler = asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT payment_type, image_url, updated_at FROM payment_qrs"
  );

  const formatted = {
    gcash: null,
    bpi: null,
    maya: null,
  };

  result.rows.forEach((row) => {
    formatted[row.payment_type] = {
      image_url: row.image_url,
      updated_at: row.updated_at,
    };
  });

  res.json(formatted);
});

const getSinglePaymentQrHandler = asyncHandler(async (req, res) => {
  const paymentType = String(req.params.paymentType || "").trim().toLowerCase();

  if (!validatePaymentType(paymentType)) {
    return res.status(400).json({ error: "Invalid payment type" });
  }

  const result = await pool.query(
    "SELECT image_url, updated_at FROM payment_qrs WHERE payment_type = $1",
    [paymentType]
  );

  if (result.rows.length === 0 || !result.rows[0].image_url) {
    return res.status(404).json({ error: "QR not found" });
  }

  return res.redirect(result.rows[0].image_url);
});

app.post("/payment-qrs/:paymentType", upload.single("image"), uploadPaymentQrHandler);
app.get("/payment-qrs", listPaymentQrsHandler);
app.get("/payment-qrs/:paymentType", getSinglePaymentQrHandler);

/* Compatibility aliases for older frontend paths */
app.post("/api/payment-qrs/:paymentType", upload.single("image"), uploadPaymentQrHandler);
app.get("/api/payment-qrs", listPaymentQrsHandler);
app.get("/api/payment-qrs/:paymentType", getSinglePaymentQrHandler);

/* ===============================
BREVO EMAIL SETUP
=============================== */
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_LOGIN,
    pass: process.env.BREVO_SMTP_PASS
  }
});

// ✅ Check connection
transporter.verify((error, success) => {
  if (error) {
    console.log("❌ Brevo error:", error);
  } else {
    console.log("✅ Brevo connected successfully");
  }
});

/* ===============================
OTP FUNCTIONS
=============================== */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000);
}

// temporary storage (for testing)
const otpStore = {};

async function sendOTP(email, otp) {
  console.log("📧 Sending OTP to:", email);
  console.log("🔑 OTP:", otp);

  await transporter.sendMail({
    from: `"Zai Wellness Spa" <fabonan2001@gmail.com>`,
    to: email,
    subject: "Spa Verification Code",
    html: `
      <h2>Email Verification</h2>
      <h1>${otp}</h1>
    `
  });

  console.log("✅ Email sent successfully");
}

/* ===============================
ROUTES
=============================== */

// 📤 Send OTP
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // ✅ SAVE TO DATABASE (instead of otpStore)
    await pool.query(
      "INSERT INTO otp_codes (email, otp, expires_at) VALUES ($1, $2, $3)",
      [email, otp, expiresAt]
    );

    // ✅ SEND EMAIL
    await sendOTP(email, otp);

    res.json({ success: true, message: "OTP sent" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// ✅ Verify OTP
app.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;

  try {
    // 🔍 Find latest OTP for this email
    const result = await pool.query(
      "SELECT * FROM otp_codes WHERE email=$1 AND otp=$2 ORDER BY id DESC LIMIT 1",
      [email, otp]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, message: "Invalid OTP" });
    }

    const record = result.rows[0];

    // ⏰ Check expiration
    if (new Date() > record.expires_at) {
      return res.json({ success: false, message: "OTP expired" });
    }

    // ✅ Mark as verified
    await pool.query(
      "UPDATE otp_codes SET verified=true WHERE id=$1",
      [record.id]
    );

    res.json({ success: true, message: "Email verified" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

/* ===============================
ERROR HANDLER
=============================== */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  if (err.message === "Only image uploads are allowed") {
    return res.status(400).json({ error: err.message });
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/* ===============================
START SERVER
=============================== */
(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ Connected to PostgreSQL");

    if (process.env.AWS_BUCKET_NAME) {
      try {
        await s3.send(
          new HeadBucketCommand({ Bucket: process.env.AWS_BUCKET_NAME })
        );
        console.log("✅ AWS S3 connected");
      } catch (err) {
        console.log("⚠️ AWS S3 connection failed (continuing anyway)");
      }
    } else {
      console.log("⚠️ AWS not configured");
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error("❌ Startup failed:", error.message);
    process.exit(1);
  }
})();