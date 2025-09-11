import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import XLSX from "xlsx";
import session from "express-session";

// --- helpers for Excel & dates ---

const EXCEL_HEADERS = [
  "name",
  "dob",
  "age",
  "gender",
  "ncd",
  "medicines",
  "aadhaar",
  "submittedAt",
  "submittedDate",
];

function normalizeForm(body) {
  return {
    name: body.name?.trim() || "",
    dob: body.dob || "",
    age: body.age || "",
    gender: body.gender || "",
    ncd: body.ncd || "",
    medicines: Array.isArray(body.medicines)
      ? body.medicines.join(", ")
      : (body.medicines || ""),
    aadhaar: body.aadhaar || "",
    submittedAt: new Date().toISOString(),
    submittedDate: new Date().toISOString().slice(0, 10)
  };
}

const port = 5000;

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PostgreSQL connection pool
const pool = new pg.Pool({
  user: "postgres",
  password: "root",
  host: "localhost",
  database: "Form_104",
  port: 5432,
  max: 10000,
});

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "secret-key", // move to env variable in production
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: false }, // Set secure: true if using HTTPS
  })
);

function requireAdmin(req, res, next) {
  if (req.session.username === "admin") {
    next();
  } else {
    res.status(403).send("Access denied. Admins only.");
  }
}

// Middleware to protect /form.html - only logged-in users can access
app.use((req, res, next) => {
  const publicPaths = ["/", "/login", "/logout", "/styles.css","/form","/api/resords/*"];
  if (
    req.session.username ||
    publicPaths.includes(req.path) ||
    req.path.startsWith("/public") ||
    req.path.startsWith("/api/records")
  ) {
    next();
  } else {
    res.redirect("/");
  }
});

// POST /login: Validate user and redirect to form.html
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT username FROM users WHERE username = $1 AND password = $2",
      [username, password]
    );
    req.session.username = username;
    if (result.rows.length > 0) {
      // Removed activeUsers check to allow multiple sessions
      if (username === "admin" && password === "admin123") {
        res.redirect("/manage.html");
      } else {
        res.redirect("/form.html");
      }
    } else {
      res.send(
        `<h2 style="text-align:center;color:#FF6F61;margin-top:40px;">
          Invalid credentials! <a href="/">Try again</a>
        </h2>`
      );
    }
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).send("Internal server error");
  }
});

const EXCEL_FILE = path.join(process.cwd(), "data.xlsx");

// POST /submit: Save form data to Excel file
app.post("/submit", (req, res) => {
  console.log("Incoming form data:", req.body);

  const row = normalizeForm(req.body);

  row.submittedAt = new Date().toISOString();
  row.submittedDate = new Date().toISOString().slice(0, 10);

  const excelFile = path.join(__dirname, "data.xlsx");
  let workbook, worksheet;

  if (fs.existsSync(excelFile)) {
    workbook = XLSX.readFile(excelFile);
    const sheetName = workbook.SheetNames[0] || "Sheet1";
    worksheet = workbook.Sheets[sheetName];
  } else {
    workbook = XLSX.utils.book_new();
    worksheet = XLSX.utils.json_to_sheet([], { header: EXCEL_HEADERS });
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  }

  // Read current data → append → rewrite with stable headers
  const current = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
  current.push(row);

  const newSheet = XLSX.utils.json_to_sheet(current, { header: EXCEL_HEADERS });
  workbook.Sheets[workbook.SheetNames[0]] = newSheet;
  XLSX.writeFile(workbook, excelFile);

  console.log("✅ Saved row:", row);

  res.sendFile(path.join(__dirname, "public", "success.html"));
});

app.get("/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT username FROM users ORDER BY username");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Error fetching users" });
  }
});

// GET /manage - Only for admin
app.get("/manage", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manage.html"));
});

// GET /users - return list of users (admin only)
app.get("/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT username FROM users ORDER BY username");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching users" });
  }
});

// POST /add-user - create a new user (admin only)
app.post("/add-user", requireAdmin, async (req, res) => {
  const { username, password } = req.body;

  try {
    // 1. Check in DB first
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);

    if (result.rows.length > 0) {
      return res.send(`
        <script>
          alert("⚠️ Username already exists in database!");
          window.location.href = "/manage.html"; 
        </script>
      `);
    }

    // 2. Insert user into DB
    await pool.query("INSERT INTO users (username, password) VALUES ($1, $2)", [
      username,
      password,
    ]);

    // 3. Update local JSON file (for frontend use)
    const filePath = path.join(__dirname, "existing_users.json");

    let existingUsers = [];
    if (fs.existsSync(filePath)) {
      existingUsers = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    // Check if username already exists in JSON file
    const alreadyExists = existingUsers.some(u => u.username === username);

    if (!alreadyExists) {
      existingUsers.push({ username });
      fs.writeFileSync(filePath, JSON.stringify(existingUsers, null, 2));
    }

    // 4. Send success alert + redirect
    res.send(`
      <script>
        alert("✅ User added successfully! Username: ${username}");
        window.location.href = "/manage.html"; 
      </script>
    `);

  } catch (err) {
    console.error(err);
    res.send(`
      <script>
        alert("❌ Error adding user. Please try again.");
        window.location.href = "/manage.html"; 
      </script>
    `);
  }
});

// Get all past records for a specific name
app.get("/api/records/:name", (req, res) => {
  try {
    const { name } = req.params;
    const excelFile = path.join(__dirname, "data.xlsx");
    if (!fs.existsSync(excelFile)) return res.json([]);

    const workbook = XLSX.readFile(excelFile);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

    // Case-insensitive match
    const pastRecords = rows.filter(r => (r.name || "").toLowerCase() === name.toLowerCase());

    res.json(pastRecords);
  } catch (err) {
    console.error("Error fetching person records:", err);
    res.status(500).json({ error: "Failed to fetch records" });
  }
});


// GET only today's beneficiaries
app.get("/api/beneficiaries", requireAdmin, (req, res) => {
  try {
    const excelFile = path.join(__dirname, "data.xlsx");
    if (!fs.existsSync(excelFile)) return res.json([]);

    const workbook = XLSX.readFile(excelFile);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

    const today = new Date().toISOString().split("T")[0]; // yyyy-mm-dd

    const todaysData = rows.filter(r => {
      let submittedAt = r.submittedAt || r.submittedDate || "";
      if (!submittedAt) return false;

      // Handle Excel number dates
      if (typeof submittedAt === "number") {
        submittedAt = new Date((submittedAt - 25569) * 86400 * 1000).toISOString();
      }

      return String(submittedAt).startsWith(today);
    });

    res.json(todaysData);
  } catch (err) {
    console.error("Error filtering today's data:", err);
    res.status(500).json({ error: "Failed to read data" });
  }
});

app.post("/delete-user", requireAdmin, async (req, res) => {
  const { username } = req.body;

  if (username === "admin") {
    return res.status(403).send("Cannot delete admin.");
  }

  try {
    await pool.query("DELETE FROM users WHERE username = $1", [username]);
    res.status(200).send("User deleted");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting user");
  }
});

// POST /logout: Destroy session and redirect to login
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Could not log out.");
    }
    res.redirect("/");
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
