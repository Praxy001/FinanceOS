/**
 * PLOS — Personal Life Operating System
 * Backend API  |  Node.js 24 + built-in SQLite + Express
 * Layers: Auth · Gemini AI · Gmail OAuth · Cron Scheduler
 */

require('dotenv').config();

const express    = require('express');
const { DatabaseSync } = require('node:sqlite');
const cors       = require('cors');
const path       = require('path');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const cron       = require('node-cron');

// Optional — gracefully degrade if not installed yet
let GoogleGenerativeAI = null;
try { GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI; } catch(_) {}
let googleApis = null;
try { googleApis = require('googleapis').google; } catch(_) {}

const app  = express();
const PORT     = process.env.PORT || 3000;
const DB_PATH  = process.env.DB_PATH || path.join(__dirname, 'plos.db');
const JWT_SECRET = process.env.JWT_SECRET || 'plos-secret-jwt-2026';
const FRONTEND_URL = process.env.FRONTEND_URL || '*'; // Cloudflare Pages URL

app.use(cors({
  origin: (origin, cb) => cb(null, true), // allow all origins
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Health check — Railway pings this to confirm server is running
app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0', time: new Date().toISOString() }));
app.get('/', (_, res) => res.json({ app: 'PLOS API', status: 'running' }));

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT 'PK',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, bank TEXT NOT NULL,
      type TEXT NOT NULL, account_no TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0, color TEXT DEFAULT '#6366f1'
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, date TEXT NOT NULL,
      description TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL,
      type TEXT DEFAULT 'UPI', icon TEXT DEFAULT '💳', source TEXT DEFAULT 'manual',
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, lender TEXT NOT NULL,
      outstanding REAL NOT NULL, emi REAL NOT NULL, rate REAL NOT NULL,
      tenure_remaining INTEGER NOT NULL, due_day INTEGER DEFAULT 5
    );
    CREATE TABLE IF NOT EXISTS credit_cards (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, bank TEXT NOT NULL,
      card_limit REAL NOT NULL, used REAL NOT NULL DEFAULT 0,
      due_date TEXT, min_due REAL DEFAULT 0, total_due REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS investments (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      invested REAL NOT NULL, current_value REAL NOT NULL,
      units REAL DEFAULT 0, sip_amount REAL DEFAULT 0, sip_active INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tax_items (
      id INTEGER PRIMARY KEY, category TEXT NOT NULL, amount REAL NOT NULL, description TEXT
    );
    CREATE TABLE IF NOT EXISTS budget_categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
      budget REAL NOT NULL, color TEXT DEFAULT '#6366f1'
    );
    CREATE TABLE IF NOT EXISTS budget_actuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL,
      month TEXT NOT NULL, spent REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(category_id) REFERENCES budget_categories(id)
    );
    CREATE TABLE IF NOT EXISTS vault_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, doc_type TEXT NOT NULL,
      category TEXT NOT NULL, icon TEXT NOT NULL, status TEXT DEFAULT 'Valid',
      expiry_date TEXT, ocr_indexed INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS passwords (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, username TEXT NOT NULL,
      icon TEXT NOT NULL, strength TEXT NOT NULL, reused INTEGER DEFAULT 0, last_updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL,
      severity TEXT NOT NULL, category TEXT NOT NULL, created_at TEXT NOT NULL, resolved INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, event_date TEXT NOT NULL,
      event_time TEXT NOT NULL, type TEXT NOT NULL, description TEXT, color TEXT DEFAULT '#6366f1'
    );
    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, subject TEXT NOT NULL,
      email_date TEXT NOT NULL, priority TEXT NOT NULL, category TEXT NOT NULL,
      is_read INTEGER DEFAULT 0, icon TEXT DEFAULT '📧', gmail_id TEXT, body_snippet TEXT
    );
    CREATE TABLE IF NOT EXISTS net_worth_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, record_date TEXT NOT NULL,
      net_worth REAL NOT NULL, assets REAL NOT NULL, liabilities REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monthly_cashflow (
      id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL UNIQUE,
      income REAL NOT NULL, expenses REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER DEFAULT 1,
      message TEXT NOT NULL, reply TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS gmail_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1, access_token TEXT, refresh_token TEXT,
      expiry_date INTEGER, scope TEXT
    );
    CREATE TABLE IF NOT EXISTS scheduled_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL,
      trigger_date TEXT NOT NULL, sent INTEGER DEFAULT 0
    );
  `);
}

function seedDB() {
  const count = db.prepare('SELECT COUNT(*) as c FROM accounts').get();
  if (count.c > 0) return;
  console.log('🌱 Seeding database...');

  // Default user
  const hash = bcrypt.hashSync('plos2026', 10);
  db.prepare(`INSERT INTO users(name,email,password_hash,avatar) VALUES(?,?,?,?)`).run('Prakhar Chawda','prakhar@networkfp.com',hash,'PK');

  // Accounts
  [[1,'Primary Savings','HDFC Bank','savings','4821',218400,'#10b981'],
   [2,'Secondary Savings','SBI','savings','0032',98200,'#3b82f6'],
   [3,'Current Account','ICICI','current','7741',75740,'#6366f1'],
   [4,'Fixed Deposit','Kotak','fd','9920',20000,'#f59e0b']
  ].forEach(r => db.prepare(`INSERT INTO accounts VALUES(?,?,?,?,?,?,?)`).run(...r));

  // Transactions
  const ts = db.prepare(`INSERT INTO transactions(account_id,date,description,category,amount,type,icon) VALUES(?,?,?,?,?,?,?)`);
  [
    [1,'2026-06-01','Salary — Network FP','Income',185000,'IMPS','💼'],
    [1,'2026-06-01','Home Loan EMI','Loans',-28500,'Auto-debit','🏠'],
    [1,'2026-06-01','Swiggy Order','Food & Dining',-640,'UPI','🛒'],
    [1,'2026-05-31','Jio Recharge','Utilities',-999,'UPI','📱'],
    [1,'2026-05-30','SIP — Parag Parikh','Investments',-25000,'Auto-debit','📈'],
    [1,'2026-05-30','Zomato Order','Food & Dining',-820,'UPI','🛒'],
    [2,'2026-05-29','Apollo Pharmacy','Health',-420,'UPI','🏥'],
    [1,'2026-05-28','Netflix Subscription','Subscriptions',-649,'Auto-debit','📺'],
    [1,'2026-05-28','HP Petrol Pump','Transport',-1800,'UPI','⛽'],
    [1,'2026-05-27','Amazon Shopping','Shopping',-3200,'UPI','🛍️'],
    [1,'2026-05-26','Car Loan EMI','Loans',-12200,'Auto-debit','🚗'],
    [1,'2026-05-25','Swiggy Order','Food & Dining',-580,'UPI','🛒'],
    [2,'2026-05-24','SBI Credit Card Bill','Credit Card',-9800,'NEFT','💳'],
    [1,'2026-05-23','SIP — Nifty 50','Investments',-10000,'Auto-debit','📈'],
    [1,'2026-05-22','Electricity Bill','Utilities',-2400,'UPI','⚡'],
    [1,'2026-05-21','Swiggy Order','Food & Dining',-760,'UPI','🛒'],
    [1,'2026-05-20','Hotstar Subscription','Subscriptions',-299,'Auto-debit','📺'],
    [3,'2026-05-19','Freelance Consulting','Income',15000,'NEFT','💼'],
    [1,'2026-05-18','Grocery — DMart','Food & Dining',-4200,'UPI','🛒'],
    [1,'2026-05-17','Spotify','Subscriptions',-119,'Auto-debit','🎵'],
    [1,'2026-05-16','Petrol','Transport',-1600,'UPI','⛽'],
    [1,'2026-05-15','LIC Premium','Insurance',-4000,'NEFT','🏦'],
    [1,'2026-05-14','Zomato Order','Food & Dining',-950,'UPI','🛒'],
    [1,'2026-05-13','Amazon Prime','Subscriptions',-299,'Auto-debit','📦'],
    [1,'2026-05-12','Doctor Visit','Health',-800,'UPI','🏥'],
    [1,'2026-05-11','Swiggy Order','Food & Dining',-490,'UPI','🛒'],
    [1,'2026-05-10','SIP — ELSS Fund','Investments',-5000,'Auto-debit','📈'],
    [1,'2026-05-09','Water Bill','Utilities',-350,'UPI','💧'],
    [1,'2026-05-08','Swiggy Instamart','Food & Dining',-1200,'UPI','🛒'],
    [2,'2026-05-07','Health Insurance Premium','Insurance',-8500,'NEFT','🏥'],
    [1,'2026-05-06','Petrol','Transport',-1800,'UPI','⛽'],
    [1,'2026-05-05','Zomato Pro','Subscriptions',-99,'Auto-debit','🍔'],
    [1,'2026-05-01','Salary — Network FP','Income',185000,'IMPS','💼'],
    [1,'2026-05-01','Home Loan EMI','Loans',-28500,'Auto-debit','🏠'],
    [1,'2026-04-30','Swiggy Order','Food & Dining',-720,'UPI','🛒'],
    [1,'2026-04-28','Shopping — Myntra','Shopping',-2800,'UPI','🛍️'],
    [1,'2026-04-25','Car Loan EMI','Loans',-12200,'Auto-debit','🚗'],
    [1,'2026-04-20','Electricity Bill','Utilities',-2200,'UPI','⚡'],
    [1,'2026-04-15','Dividend — TCS','Income',2400,'NEFT','📈'],
    [1,'2026-04-01','Salary — Network FP','Income',185000,'IMPS','💼'],
  ].forEach(r => ts.run(...r));

  // Loans
  [[1,'Home Loan','HDFC Bank',840000,28500,8.5,192,5],
   [2,'Car Loan','SBI',320000,12200,9.2,36,10],
   [3,'Personal Loan','ICICI',120000,0,14.0,0,0]
  ].forEach(r => db.prepare(`INSERT INTO loans VALUES(?,?,?,?,?,?,?,?)`).run(...r));

  // Credit cards
  [[1,'HDFC Millennia','HDFC Bank',300000,42000,'2026-06-08',4200,9800],
   [2,'SBI SimplyCLICK','SBI',150000,18000,'2026-06-15',1800,4200]
  ].forEach(r => db.prepare(`INSERT INTO credit_cards VALUES(?,?,?,?,?,?,?,?)`).run(...r));

  // Investments
  [[1,'Parag Parikh Flexi Cap','MF',600000,914000,2840.5,25000,1],
   [2,'Mirae Asset ELSS','MF',300000,412000,1240.2,5000,1],
   [3,'Nifty 50 Index — UTI','Index',400000,560000,1820.0,10000,1],
   [4,'TCS','Stock',200000,218000,60,0,0],
   [5,'HDFC Balanced Advantage','MF',210000,244000,980.1,5000,1],
   [6,'SGB — Gold Bonds 2022','Gold',120000,164000,40,0,0],
   [7,'ICICI Pru US Bluechip','MF',180000,148000,620.3,0,0]
  ].forEach(r => db.prepare(`INSERT INTO investments VALUES(?,?,?,?,?,?,?,?)`).run(...r));

  // Tax
  [[1,'Gross Income',2220000,'Salary + Other'],[2,'Standard Deduction',50000,'Section 16(ia)'],
   [3,'80C Deductions',150000,'ELSS + LIC + Principal'],[4,'80D — Health Insurance',25000,'Family cover'],
   [5,'TDS Deducted',162000,'Employer + banks'],[6,'Advance Tax Paid',40000,'2 installments']
  ].forEach(r => db.prepare(`INSERT INTO tax_items VALUES(?,?,?,?)`).run(...r));

  // Budget categories
  [[1,'EMIs & Loans','🏠',42000,'#6366f1'],[2,'Investments / SIPs','📈',45000,'#10b981'],
   [3,'Food & Dining','🍔',8000,'#ef4444'],[4,'Utilities & Bills','⚡',5000,'#3b82f6'],
   [5,'Subscriptions','📱',2000,'#f59e0b'],[6,'Shopping','🛍️',5000,'#06b6d4'],
   [7,'Transport','🚗',3000,'#8b5cf6'],[8,'Health','🏥',2000,'#10b981'],[9,'Insurance','🏦',5000,'#3b82f6']
  ].forEach(r => db.prepare(`INSERT INTO budget_categories VALUES(?,?,?,?,?)`).run(...r));

  [[1,40700],[2,40000],[3,12400],[4,3349],[5,1465],[6,0],[7,3400],[8,1220],[9,0]]
    .forEach(([cid,s]) => db.prepare(`INSERT INTO budget_actuals(category_id,month,spent) VALUES(?,?,?)`).run(cid,'2026-06',s));

  // Vault docs
  [['Aadhaar Card','PDF','Identity','🪪','Valid',null],['PAN Card','PDF','Identity','🪪','Valid',null],
   ['Passport','PDF','Identity','📘','Expiring','2026-07-15'],['Driving License','PDF','Identity','🚗','Expiring','2026-08-22'],
   ['Home Loan Agreement','PDF','Finance','🏠','Valid',null],['Vehicle RC','PDF','Legal','🚗','Valid',null],
   ['Health Insurance Policy','PDF','Insurance','🏥','Valid','2027-03-31'],['LIC Policy Document','PDF','Insurance','💼','Valid','2036-12-01'],
   ['Car Insurance','PDF','Insurance','🚗','Valid','2026-12-10'],['Salary Slip May 2026','PDF','Finance','💼','Valid',null],
   ['Form 16 AY 2025-26','PDF','Finance','🧾','Valid',null],['IT Return AY 2025-26','PDF','Finance','📄','Valid',null]
  ].forEach(r => db.prepare(`INSERT INTO vault_documents(name,doc_type,category,icon,status,expiry_date) VALUES(?,?,?,?,?,?)`).run(...r));

  // Passwords
  [['HDFC NetBanking','prakhar@networkfp.com','🏦','Strong',0,'2026-03-10'],
   ['Gmail','prakhar@networkfp.com','📧','Strong',0,'2026-04-20'],
   ['Zerodha Kite','prakhar@networkfp.com','📊','Medium',1,'2025-11-05'],
   ['Amazon.in','prakhar@networkfp.com','🛒','Weak',0,'2024-08-14'],
   ['SBI Net Banking','prakhar1234','💳','Weak',1,'2024-06-01'],
   ['Jio MyAccount','prakhar@networkfp.com','📱','Strong',0,'2026-02-28'],
   ['Paytm','prakhar@networkfp.com','💳','Medium',1,'2025-07-12'],
   ['ICICI Bank','prakhar@networkfp.com','🏦','Strong',0,'2026-01-15']
  ].forEach(r => db.prepare(`INSERT INTO passwords(site,username,icon,strength,reused,last_updated) VALUES(?,?,?,?,?,?)`).run(...r));

  // Alerts
  [['TDS Mismatch — Income Tax Notice','Form 26AS vs ITR discrepancy ₹12,400. Respond by Jun 15.','critical','Tax','2026-06-01'],
   ['Credit Card Overdue — HDFC','₹4,200 overdue from last cycle. Interest at 42% p.a.','critical','Credit','2026-05-30'],
   ['Budget Breach — Food','Spent 155% of monthly food budget.','warning','Budget','2026-06-01'],
   ['Subscription Spike','6 streaming subs = ₹2,890/mo. Up 44%.','warning','Subscriptions','2026-05-28'],
   ['Underperforming Investment','ICICI Pru US Bluechip −17.8%. Review or exit.','warning','Investments','2026-05-25'],
   ['Passport Expiring in 56 Days','Expires July 2026. Start renewal now.','info','Documents','2026-05-20']
  ].forEach(r => db.prepare(`INSERT INTO alerts(title,description,severity,category,created_at) VALUES(?,?,?,?,?)`).run(...r));

  // Calendar events
  [['Weekly Sync — Partnerships Team','2026-06-01','10:00','meeting','Google Meet · 5 attendees','#3b82f6'],
   ['AMC Partner Call — Axis MF','2026-06-01','12:30','meeting','Zoom · QPFP onboarding','#6366f1'],
   ['University Program Review','2026-06-01','14:30','meeting','Internal · Q2 progress','#10b981'],
   ['Nationals Sponsorship Deck Review','2026-06-01','17:00','meeting','Internal · Final','#f59e0b'],
   ['Home Loan EMI Due','2026-06-05','09:00','payment','HDFC · ₹28,500','#ef4444'],
   ['SBI Credit Card Bill','2026-06-08','09:00','payment','₹9,800 due','#ef4444'],
   ['Car Loan EMI','2026-06-10','09:00','payment','SBI · ₹12,200','#ef4444'],
   ['Advance Tax Q1 FY27','2026-06-15','09:00','compliance','Est. ₹54,600 due','#f59e0b'],
   ['LIC Premium','2026-06-15','09:00','payment','₹4,000','#3b82f6'],
   ['NFP Nationals Planning Call','2026-06-08','11:00','meeting','Strategy · Sponsor pipeline','#6366f1']
  ].forEach(r => db.prepare(`INSERT INTO calendar_events(title,event_date,event_time,type,description,color) VALUES(?,?,?,?,?,?)`).run(...r));

  // Emails
  [['HDFC Bank','Loan Statement — May 2026','2026-05-31','urgent','Finance','📧'],
   ['Income Tax Department','TDS Notice AY2025-26 — Action Required','2026-05-30','urgent','Tax','⚠️'],
   ['Axis MF','Partnership MOU — Review Required','2026-05-30','review','Partnerships','🤝'],
   ['SBI Card','Credit Card Statement — May 2026','2026-05-29','info','Finance','💳'],
   ['Zerodha','Portfolio Report — May 2026','2026-05-28','info','Investments','📈'],
   ['Network FP','Salary Slip — May 2026','2026-05-28','info','HR','💼'],
   ['NSDL','PAN Verification Completed','2026-05-27','info','Compliance','🪪'],
   ['Parag Parikh MF','SIP Execution Confirmation','2026-05-30','info','Investments','📈']
  ].forEach(r => db.prepare(`INSERT INTO emails(sender,subject,email_date,priority,category,icon) VALUES(?,?,?,?,?,?)`).run(...r));

  // Net worth history
  [['2025-06',3820000,4300000,480000],['2025-07',3910000,4400000,490000],
   ['2025-08',4040000,4550000,510000],['2025-09',4180000,4730000,550000],
   ['2025-10',4320000,4890000,570000],['2025-11',4490000,5060000,570000],
   ['2025-12',4620000,5200000,580000],['2026-01',4710000,5310000,600000],
   ['2026-02',4840000,5460000,620000],['2026-03',4980000,5620000,640000],
   ['2026-04',5100000,5750000,650000],['2026-05',5240000,5890000,650000],
   ['2026-06',4860000,5374000,514000]
  ].forEach(r => db.prepare(`INSERT INTO net_worth_history(record_date,net_worth,assets,liabilities) VALUES(?,?,?,?)`).run(...r));

  // Cashflow
  [['2025-07',165000,92000],['2025-08',168000,85000],['2025-09',172000,90000],
   ['2025-10',180000,87000],['2025-11',180000,91000],['2025-12',185000,96000],
   ['2026-01',185000,88000],['2026-02',185000,93000],['2026-03',188000,89000],
   ['2026-04',186000,86000],['2026-05',200000,90000],['2026-06',185000,94200]
  ].forEach(r => db.prepare(`INSERT INTO monthly_cashflow(month,income,expenses) VALUES(?,?,?)`).run(...r));

  // Settings
  [['gmail_connected','0'],['calendar_connected','1'],['zerodha_connected','1'],
   ['hdfc_connected','0'],['outlook_connected','0'],['gemini_api_key',''],
   ['gemini_api_active','0'],['ai_spending_alerts','1'],['predictive_insights','1'],
   ['doc_auto_tag','1'],['email_alerts','1'],['emi_reminders','1'],
   ['budget_warnings','1'],['fraud_alerts','1'],['auto_sync','1'],
   ['encryption','1'],['theme','dark'],
   ['google_client_id',''],['google_client_secret','']
  ].forEach(([k,v]) => db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`).run(k,v));

  console.log('✅ Database seeded');
}

initDB();
seedDB();

// Auto-populate Gemini API key from .env if available
if (process.env.GEMINI_API_KEY) {
  db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`).run('gemini_api_key', process.env.GEMINI_API_KEY);
  db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`).run('gemini_api_active', '1');
  console.log('✅ Gemini API key loaded from .env');
}

// Auto-populate Google OAuth credentials from .env if available
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`).run('google_client_id', process.env.GOOGLE_CLIENT_ID);
  db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`).run('google_client_secret', process.env.GOOGLE_CLIENT_SECRET);
  console.log('✅ Google OAuth credentials loaded from .env');
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
const ok  = (res, data)       => res.json({ success: true, data });
const err = (res, msg, code=400) => res.status(code).json({ success: false, error: msg });
const getSetting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || '';

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return err(res, 'Unauthorized', 401);
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(_) {
    return err(res, 'Invalid token', 401);
  }
}

// ─────────────────────────────────────────────
// AUTH ROUTES  (public)
// ─────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return err(res, 'name, email, password required');
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return err(res, 'Email already registered');
  const hash = bcrypt.hashSync(password, 10);
  const initials = name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
  const result = db.prepare(`INSERT INTO users(name,email,password_hash,avatar) VALUES(?,?,?,?)`).run(name,email,hash,initials);
  const token = jwt.sign({ id: result.lastInsertRowid, email, name }, JWT_SECRET, { expiresIn: '7d' });
  ok(res, { token, user: { id: result.lastInsertRowid, name, email, avatar: initials } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return err(res, 'email and password required');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return err(res, 'Invalid email or password', 401);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  ok(res, { token, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id,name,email,avatar,created_at FROM users WHERE id=?').get(req.user.id);
  ok(res, user);
});

app.post('/api/auth/change-password', authMiddleware, (req, res) => {
  const { current, newPassword } = req.body;
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current, user.password_hash)) return err(res, 'Current password incorrect');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  ok(res, { updated: true });
});

// ─────────────────────────────────────────────
// GEMINI AI
// ─────────────────────────────────────────────
async function callGemini(prompt) {
  const apiKey = getSetting('gemini_api_key');
  if (!apiKey || !GoogleGenerativeAI) return null;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch(e) {
    console.error('Gemini error:', e.message);
    return null;
  }
}

function buildFinancialContext() {
  const accounts  = db.prepare('SELECT SUM(balance) as t FROM accounts').get();
  const inv       = db.prepare('SELECT SUM(current_value) as c, SUM(invested) as i FROM investments').get();
  const loans     = db.prepare('SELECT SUM(outstanding) as t, SUM(emi) as emi FROM loans').get();
  const cf        = db.prepare('SELECT * FROM monthly_cashflow ORDER BY month DESC LIMIT 1').get();
  const topSpend  = db.prepare(`SELECT category, SUM(ABS(amount)) as t FROM transactions WHERE amount<0 AND date>=date('now','-30 days') GROUP BY category ORDER BY t DESC LIMIT 5`).all();
  const alerts    = db.prepare('SELECT title FROM alerts WHERE resolved=0').all();
  return {
    net_worth: Math.round((accounts.t||0) + (inv.c||0) - (loans.t||0)),
    monthly_income: cf?.income || 0,
    monthly_expenses: cf?.expenses || 0,
    savings_rate: cf ? (((cf.income-cf.expenses)/cf.income)*100).toFixed(1)+'%' : '0%',
    investments: inv.c || 0,
    total_debt: loans.t || 0,
    monthly_emi: loans.emi || 0,
    top_spend: topSpend,
    active_alerts: alerts.map(a=>a.title),
  };
}

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return err(res, 'message required');

  const ctx = buildFinancialContext();
  const apiKey = getSetting('gemini_api_key');

  let reply;
  if (apiKey && GoogleGenerativeAI) {
    const prompt = `You are PLOS AI, a personal financial assistant for ${req.user.name}.
Current financial snapshot (Indian Rupees):
- Net Worth: ₹${(ctx.net_worth/100000).toFixed(1)}L
- Monthly Income: ₹${ctx.monthly_income.toLocaleString('en-IN')}
- Monthly Expenses: ₹${ctx.monthly_expenses.toLocaleString('en-IN')}
- Savings Rate: ${ctx.savings_rate}
- Investments: ₹${(ctx.investments/100000).toFixed(1)}L
- Total Debt: ₹${(ctx.total_debt/100000).toFixed(1)}L
- Monthly EMI Load: ₹${ctx.monthly_emi.toLocaleString('en-IN')}
- Top spend categories: ${ctx.top_spend.map(s=>`${s.category} ₹${s.t}`).join(', ')}
- Active alerts: ${ctx.active_alerts.join(', ')||'None'}

User question: "${message}"

Answer in 2-3 sentences. Be direct, specific, and actionable. Use ₹ for amounts.`;
    reply = await callGemini(prompt);
  }

  if (!reply) {
    // Rule-based fallback
    const lower = message.toLowerCase();
    if (lower.includes('spend') || lower.includes('spent')) {
      const top = db.prepare(`SELECT category, SUM(ABS(amount)) as t FROM transactions WHERE amount<0 AND date>=date('now','start of month') GROUP BY category ORDER BY t DESC LIMIT 3`).all();
      reply = `This month you've spent ₹${ctx.monthly_expenses.toLocaleString('en-IN')}. Top: ${top.map(t=>`${t.category} ₹${Math.round(t.t).toLocaleString('en-IN')}`).join(' · ')}.`;
    } else if (lower.includes('net worth')) {
      reply = `Your net worth is ₹${(ctx.net_worth/100000).toFixed(1)}L. Assets ₹${((ctx.investments+(db.prepare('SELECT SUM(balance) as t FROM accounts').get().t||0))/100000).toFixed(1)}L minus debt ₹${(ctx.total_debt/100000).toFixed(1)}L.`;
    } else if (lower.includes('emi') || lower.includes('due')) {
      const evts = db.prepare(`SELECT title,event_date,description FROM calendar_events WHERE type='payment' AND event_date>=date('now') ORDER BY event_date LIMIT 3`).all();
      reply = evts.length ? `Upcoming: ${evts.map(e=>`${e.title} on ${e.event_date} (${e.description})`).join(' · ')}.` : 'No upcoming payments found.';
    } else if (lower.includes('invest')) {
      const r = db.prepare('SELECT SUM(current_value) as c, SUM(invested) as i FROM investments').get();
      reply = `Portfolio: ₹${(r.c/100000).toFixed(1)}L current vs ₹${(r.i/100000).toFixed(1)}L invested. Absolute return: +${(((r.c-r.i)/r.i)*100).toFixed(1)}%.`;
    } else if (lower.includes('alert') || lower.includes('risk')) {
      reply = ctx.active_alerts.length ? `Active alerts: ${ctx.active_alerts.slice(0,3).join('; ')}.` : 'No active alerts 🎉';
    } else {
      reply = `💡 Add your Gemini API key in Settings to enable full AI. I can answer questions about spending, EMIs, net worth, investments, and alerts.`;
    }
  }

  // Save conversation
  db.prepare(`INSERT INTO ai_conversations(user_id,message,reply) VALUES(?,?,?)`).run(req.user.id, message, reply);
  ok(res, { reply });
});

app.get('/api/ai/insights', authMiddleware, async (req, res) => {
  const ctx = buildFinancialContext();
  const apiKey = getSetting('gemini_api_key');
  let insights = [];

  if (apiKey && GoogleGenerativeAI) {
    const prompt = `You are PLOS AI, a financial advisor. Generate exactly 3 sharp, data-driven financial insights for this user:
Financial snapshot: ${JSON.stringify(ctx)}
Return a JSON array of 3 objects: [{icon, title, text}]
Icons should be emojis. Titles max 6 words. Text max 25 words. Be specific with numbers.
Return ONLY valid JSON, no markdown.`;
    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
        insights = JSON.parse(cleaned);
      } catch(_) {}
    }
  }

  if (!insights.length) {
    const savingsRate = ctx.monthly_income > 0 ? ((ctx.monthly_income - ctx.monthly_expenses) / ctx.monthly_income * 100).toFixed(0) : 0;
    insights = [
      { icon: '📊', title: 'Savings Rate Analysis', text: `${savingsRate}% savings rate this month. ${savingsRate > 45 ? 'Above target — strong discipline.' : 'Below 45% target. Reduce discretionary spend.'}` },
      { icon: '⚠️', title: 'Active Alerts', text: ctx.active_alerts.length ? `${ctx.active_alerts.length} alerts need attention: ${ctx.active_alerts[0]}` : 'No active alerts — all systems healthy.' },
      { icon: '📈', title: 'Investment Health', text: `Portfolio ₹${(ctx.investments/100000).toFixed(1)}L with positive trajectory. EMI load ₹${(ctx.monthly_emi/1000).toFixed(0)}K/mo.` },
    ];
  }
  ok(res, insights);
});

app.get('/api/ai/conversations', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM ai_conversations WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  ok(res, rows);
});

app.get('/api/ai/weekly-digest', authMiddleware, async (req, res) => {
  const ctx = buildFinancialContext();
  const apiKey = getSetting('gemini_api_key');
  let digest = '';

  if (apiKey && GoogleGenerativeAI) {
    const prompt = `Generate a concise weekly financial digest for a personal finance professional.
Data: ${JSON.stringify(ctx)}
Format: 3-4 bullet points. Focus on: cashflow, investments, risks, opportunity. Max 120 words total.`;
    digest = await callGemini(prompt) || '';
  }

  if (!digest) {
    digest = `• Net worth ₹${(ctx.net_worth/100000).toFixed(1)}L — on growth trajectory\n• Savings rate ${ctx.savings_rate} this month\n• ${ctx.active_alerts.length} active alerts require attention\n• Investment portfolio at ₹${(ctx.investments/100000).toFixed(1)}L`;
  }
  ok(res, { digest });
});

// ─────────────────────────────────────────────
// GMAIL OAUTH
// ─────────────────────────────────────────────
function getOAuth2Client() {
  if (!googleApis) return null;
  const clientId     = getSetting('google_client_id');
  const clientSecret = getSetting('google_client_secret');
  if (!clientId || !clientSecret) return null;
  const base = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  return new googleApis.auth.OAuth2(clientId, clientSecret, `${base}/api/gmail/callback`);
}

app.get('/api/gmail/auth-url', authMiddleware, (req, res) => {
  const client = getOAuth2Client();
  if (!client) return err(res, 'Configure Google OAuth credentials in Settings first');
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email'],
    prompt: 'consent',
  });
  ok(res, { url });
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?gmail=error&reason=' + error);
  const client = getOAuth2Client();
  if (!client) return res.redirect('/?gmail=error&reason=no-credentials');
  try {
    const { tokens } = await client.getToken(code);
    const row = db.prepare('SELECT id FROM gmail_tokens WHERE id=1').get();
    if (row) {
      db.prepare(`UPDATE gmail_tokens SET access_token=?,refresh_token=?,expiry_date=?,scope=? WHERE id=1`).run(tokens.access_token, tokens.refresh_token||null, tokens.expiry_date||null, tokens.scope||null);
    } else {
      db.prepare(`INSERT INTO gmail_tokens(id,access_token,refresh_token,expiry_date,scope) VALUES(1,?,?,?,?)`).run(tokens.access_token, tokens.refresh_token||null, tokens.expiry_date||null, tokens.scope||null);
    }
    db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('gmail_connected','1')`).run();
    res.redirect('/?gmail=connected');
  } catch(e) {
    console.error('Gmail OAuth error:', e.message);
    res.redirect('/?gmail=error&reason=' + encodeURIComponent(e.message));
  }
});

app.get('/api/gmail/status', authMiddleware, (req, res) => {
  const connected = getSetting('gmail_connected') === '1';
  const tokens = db.prepare('SELECT expiry_date FROM gmail_tokens WHERE id=1').get();
  ok(res, { connected, token_valid: tokens ? (tokens.expiry_date > Date.now()) : false });
});

app.post('/api/gmail/sync', authMiddleware, async (req, res) => {
  if (!googleApis) return err(res, 'googleapis package not installed');
  const tokens = db.prepare('SELECT * FROM gmail_tokens WHERE id=1').get();
  if (!tokens?.access_token) return err(res, 'Gmail not connected');

  const client = getOAuth2Client();
  if (!client) return err(res, 'OAuth credentials not configured');
  client.setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });

  try {
    const gmail = googleApis.gmail({ version: 'v1', auth: client });
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'subject:(statement OR EMI OR payment OR credited OR debited OR UPI OR NEFT OR IMPS) newer_than:7d',
      maxResults: 20,
    });

    const messages = listRes.data.messages || [];
    let parsed = 0;

    for (const msg of messages.slice(0, 10)) {
      const existing = db.prepare('SELECT id FROM emails WHERE gmail_id=?').get(msg.id);
      if (existing) continue;

      const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From','Subject','Date'] });
      const headers = detail.data.payload?.headers || [];
      const getH = name => headers.find(h=>h.name===name)?.value || '';

      const subject  = getH('Subject');
      const fromRaw  = getH('From');
      const sender   = fromRaw.replace(/<[^>]+>/, '').trim() || fromRaw;
      const date     = getH('Date');
      const snippet  = detail.data.snippet || '';

      // AI-classify priority
      let priority = 'info';
      const sl = subject.toLowerCase();
      if (sl.includes('notice') || sl.includes('overdue') || sl.includes('action required')) priority = 'urgent';
      else if (sl.includes('statement') || sl.includes('due') || sl.includes('emi')) priority = 'review';

      const category = sl.includes('invest') || sl.includes('mutual') ? 'Investments'
        : sl.includes('loan') || sl.includes('emi') ? 'Loans'
        : sl.includes('tax') || sl.includes('tds') ? 'Tax'
        : sl.includes('salary') || sl.includes('credited') ? 'Income'
        : 'Finance';

      db.prepare(`INSERT INTO emails(sender,subject,email_date,priority,category,icon,gmail_id,body_snippet) VALUES(?,?,?,?,?,?,?,?)`)
        .run(sender.slice(0,80), subject.slice(0,120), date.slice(0,10), priority, category, '📧', msg.id, snippet.slice(0,200));
      parsed++;
    }

    ok(res, { synced: messages.length, parsed, message: `Synced ${parsed} new financial emails` });
  } catch(e) {
    console.error('Gmail sync error:', e.message);
    err(res, 'Gmail sync failed: ' + e.message);
  }
});

// ─────────────────────────────────────────────
// FINANCIAL API ROUTES  (all protected)
// ─────────────────────────────────────────────

app.get('/api/summary', authMiddleware, (req, res) => {
  const accounts = db.prepare('SELECT SUM(balance) as t FROM accounts').get();
  const inv      = db.prepare('SELECT SUM(current_value) as c FROM investments').get();
  const loans    = db.prepare('SELECT SUM(outstanding) as t FROM loans').get();
  const cards    = db.prepare('SELECT SUM(total_due) as t FROM credit_cards').get();
  const cf       = db.prepare(`SELECT * FROM monthly_cashflow WHERE month='2026-06'`).get();
  const cfPrev   = db.prepare(`SELECT * FROM monthly_cashflow WHERE month='2026-05'`).get();
  const totalAssets = (accounts.t||0) + (inv.c||0);
  const totalLiab   = (loans.t||0) + (cards.t||0);
  ok(res, {
    net_worth: totalAssets - totalLiab,
    total_assets: totalAssets, total_liabilities: totalLiab,
    monthly_income: cf?.income||0, monthly_expenses: cf?.expenses||0,
    savings_rate: cf ? +((cf.income-cf.expenses)/cf.income*100).toFixed(1) : 0,
    total_investments: inv.c||0, total_debt: loans.t||0,
    income_change: cfPrev ? (cf?.income||0) - cfPrev.income : 0,
    expense_change: cfPrev ? (cf?.expenses||0) - cfPrev.expenses : 0,
  });
});

app.get('/api/cashflow', authMiddleware, (req, res) => ok(res, db.prepare('SELECT * FROM monthly_cashflow ORDER BY month').all()));

app.get('/api/net-worth-history', authMiddleware, (req, res) => ok(res, db.prepare('SELECT * FROM net_worth_history ORDER BY record_date').all()));

app.get('/api/accounts', authMiddleware, (req, res) => ok(res, db.prepare('SELECT * FROM accounts').all()));
app.put('/api/accounts/:id/balance', authMiddleware, (req, res) => {
  const { balance } = req.body;
  db.prepare('UPDATE accounts SET balance=? WHERE id=?').run(balance, req.params.id);
  ok(res, { updated: true });
});

app.get('/api/transactions', authMiddleware, (req, res) => {
  const { limit=50, offset=0, category, account_id, search } = req.query;
  let q = `SELECT t.*,a.bank,a.account_no FROM transactions t LEFT JOIN accounts a ON t.account_id=a.id WHERE 1=1`;
  const p = [];
  if (category)   { q += ' AND t.category=?';   p.push(category); }
  if (account_id) { q += ' AND t.account_id=?';  p.push(account_id); }
  if (search)     { q += ' AND (t.description LIKE ? OR t.category LIKE ?)'; p.push(`%${search}%`,`%${search}%`); }
  q += ' ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?';
  p.push(+limit, +offset);
  ok(res, { transactions: db.prepare(q).all(...p), total: db.prepare('SELECT COUNT(*) as c FROM transactions').get().c });
});

app.post('/api/transactions', authMiddleware, (req, res) => {
  const { account_id=1, date, description, category, amount, type='UPI', icon='💳' } = req.body;
  if (!description || !category || amount===undefined) return err(res, 'description, category, amount required');
  const d = date || new Date().toISOString().split('T')[0];
  const r = db.prepare(`INSERT INTO transactions(account_id,date,description,category,amount,type,icon) VALUES(?,?,?,?,?,?,?)`).run(account_id,d,description,category,amount,type,icon);
  if (account_id) db.prepare('UPDATE accounts SET balance=balance+? WHERE id=?').run(amount, account_id);
  ok(res, { id: r.lastInsertRowid });
});

app.delete('/api/transactions/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id);
  ok(res, { deleted: true });
});

app.get('/api/banking/heatmap', authMiddleware, (req, res) => ok(res, db.prepare(`
  SELECT strftime('%m',date) as month,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as inflow,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as outflow
  FROM transactions GROUP BY month ORDER BY month`).all()));

app.get('/api/loans', authMiddleware, (req, res) => ok(res, db.prepare('SELECT * FROM loans').all()));
app.put('/api/loans/:id', authMiddleware, (req, res) => {
  db.prepare('UPDATE loans SET outstanding=? WHERE id=?').run(req.body.outstanding, req.params.id);
  ok(res, { updated: true });
});

app.get('/api/credit-cards', authMiddleware, (req, res) => ok(res, db.prepare('SELECT * FROM credit_cards').all()));

app.get('/api/investments', authMiddleware, (req, res) => {
  const holdings = db.prepare('SELECT * FROM investments ORDER BY current_value DESC').all();
  const summary  = db.prepare('SELECT SUM(invested) as total_invested, SUM(current_value) as total_current FROM investments').get();
  ok(res, { holdings, summary });
});
app.put('/api/investments/:id', authMiddleware, (req, res) => {
  db.prepare('UPDATE investments SET current_value=? WHERE id=?').run(req.body.current_value, req.params.id);
  ok(res, { updated: true });
});

app.get('/api/tax', authMiddleware, (req, res) => {
  const items = db.prepare('SELECT * FROM tax_items').all();
  const gross = items.find(i=>i.category==='Gross Income')?.amount||0;
  const std   = items.find(i=>i.category==='Standard Deduction')?.amount||0;
  const ded   = items.filter(i=>i.category.startsWith('80')).reduce((s,i)=>s+i.amount,0);
  const taxable = gross - std - ded;
  let tax = 0;
  if (taxable>1500000) tax=150000+(taxable-1500000)*0.30;
  else if (taxable>1200000) tax=90000+(taxable-1200000)*0.20;
  else if (taxable>900000) tax=45000+(taxable-900000)*0.15;
  else if (taxable>600000) tax=15000+(taxable-600000)*0.10;
  else if (taxable>300000) tax=(taxable-300000)*0.05;
  const total = Math.round(tax * 1.04);
  const tds   = items.find(i=>i.category==='TDS Deducted')?.amount||0;
  const adv   = items.find(i=>i.category==='Advance Tax Paid')?.amount||0;
  ok(res, { items, grossIncome:gross, taxableIncome:taxable, estimatedTax:total, tdsPaid:tds, advanceTax:adv, balanceDue:Math.max(0,total-tds-adv) });
});

app.get('/api/budget', authMiddleware, (req, res) => {
  const month = req.query.month || '2026-06';
  const cats  = db.prepare('SELECT * FROM budget_categories').all();
  const acts  = db.prepare('SELECT category_id,spent FROM budget_actuals WHERE month=?').all(month);
  const map   = {}; acts.forEach(a=>map[a.category_id]=a.spent);
  ok(res, {
    categories: cats.map(c=>({...c, spent:map[c.id]||0, pct:Math.round(((map[c.id]||0)/c.budget)*100)})),
    totalBudget: cats.reduce((s,c)=>s+c.budget,0),
    totalSpent: acts.reduce((s,a)=>s+a.spent,0),
    month,
  });
});

app.put('/api/budget/:id', authMiddleware, (req, res) => {
  db.prepare('UPDATE budget_categories SET budget=? WHERE id=?').run(req.body.budget, req.params.id);
  ok(res, { updated: true });
});

app.post('/api/budget/actual', authMiddleware, (req, res) => {
  const { category_id, month, spent } = req.body;
  const ex = db.prepare('SELECT id FROM budget_actuals WHERE category_id=? AND month=?').get(category_id, month);
  if (ex) db.prepare('UPDATE budget_actuals SET spent=? WHERE id=?').run(spent, ex.id);
  else db.prepare('INSERT INTO budget_actuals(category_id,month,spent) VALUES(?,?,?)').run(category_id,month,spent);
  ok(res, { updated: true });
});

app.get('/api/vault', authMiddleware, (req, res) => {
  const docs  = db.prepare('SELECT * FROM vault_documents ORDER BY category,name').all();
  const exp   = db.prepare(`SELECT COUNT(*) as c FROM vault_documents WHERE expiry_date IS NOT NULL AND expiry_date<=date('now','+90 days') AND status!='Expired'`).get();
  const bycat = db.prepare('SELECT category, COUNT(*) as count FROM vault_documents GROUP BY category').all();
  ok(res, { documents:docs, expiring_count:exp.c, by_category:bycat });
});
app.post('/api/vault', authMiddleware, (req, res) => {
  const { name, doc_type='PDF', category, icon='📄', status='Valid', expiry_date } = req.body;
  if (!name||!category) return err(res,'name and category required');
  const r = db.prepare(`INSERT INTO vault_documents(name,doc_type,category,icon,status,expiry_date) VALUES(?,?,?,?,?,?)`).run(name,doc_type,category,icon,status,expiry_date||null);
  ok(res, { id:r.lastInsertRowid });
});
app.delete('/api/vault/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM vault_documents WHERE id=?').run(req.params.id);
  ok(res, { deleted:true });
});

app.get('/api/passwords', authMiddleware, (req, res) => {
  const rows  = db.prepare('SELECT * FROM passwords ORDER BY strength ASC,site ASC').all();
  const weak  = db.prepare(`SELECT COUNT(*) as c FROM passwords WHERE strength='Weak'`).get();
  const reuse = db.prepare('SELECT COUNT(*) as c FROM passwords WHERE reused=1').get();
  ok(res, { credentials:rows, weak_count:weak.c, reused_count:reuse.c, security_score:Math.max(0,100-weak.c*8-reuse.c*4) });
});
app.post('/api/passwords', authMiddleware, (req, res) => {
  const { site, username, icon='🔐', strength, reused=0 } = req.body;
  if (!site||!username||!strength) return err(res,'site, username, strength required');
  const r = db.prepare(`INSERT INTO passwords(site,username,icon,strength,reused,last_updated) VALUES(?,?,?,?,?,?)`).run(site,username,icon,strength,reused,new Date().toISOString().split('T')[0]);
  ok(res, { id:r.lastInsertRowid });
});
app.delete('/api/passwords/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM passwords WHERE id=?').run(req.params.id);
  ok(res, { deleted:true });
});

app.get('/api/alerts', authMiddleware, (req, res) => {
  const resolved = req.query.resolved==='1' ? 1 : 0;
  ok(res, {
    alerts: db.prepare('SELECT * FROM alerts WHERE resolved=? ORDER BY severity ASC,created_at DESC').all(resolved),
    counts: db.prepare('SELECT severity,COUNT(*) as count FROM alerts WHERE resolved=0 GROUP BY severity').all(),
  });
});
app.patch('/api/alerts/:id/resolve', authMiddleware, (req, res) => {
  db.prepare('UPDATE alerts SET resolved=1 WHERE id=?').run(req.params.id);
  ok(res, { resolved:true });
});

app.get('/api/events', authMiddleware, (req, res) => {
  const { date, month } = req.query;
  let q = 'SELECT * FROM calendar_events WHERE 1=1', p = [];
  if (date)  { q += ' AND event_date=?'; p.push(date); }
  if (month) { q += ` AND event_date LIKE '${month}%'`; }
  ok(res, db.prepare(q + ' ORDER BY event_date ASC,event_time ASC').all(...p));
});
app.post('/api/events', authMiddleware, (req, res) => {
  const { title, event_date, event_time, type='meeting', description='', color='#6366f1' } = req.body;
  if (!title||!event_date||!event_time) return err(res,'title, event_date, event_time required');
  const r = db.prepare(`INSERT INTO calendar_events(title,event_date,event_time,type,description,color) VALUES(?,?,?,?,?,?)`).run(title,event_date,event_time,type,description,color);
  ok(res, { id:r.lastInsertRowid });
});
app.delete('/api/events/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM calendar_events WHERE id=?').run(req.params.id);
  ok(res, { deleted:true });
});

app.get('/api/emails', authMiddleware, (req, res) => {
  const { priority } = req.query;
  let q = 'SELECT * FROM emails WHERE 1=1', p = [];
  if (priority) { q += ' AND priority=?'; p.push(priority); }
  ok(res, db.prepare(q + ` ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'review' THEN 2 ELSE 3 END,email_date DESC`).all(...p));
});
app.patch('/api/emails/:id/read', authMiddleware, (req, res) => {
  db.prepare('UPDATE emails SET is_read=1 WHERE id=?').run(req.params.id);
  ok(res, { updated:true });
});

app.get('/api/insights', authMiddleware, (req, res) => {
  const cf    = db.prepare('SELECT * FROM monthly_cashflow ORDER BY month DESC LIMIT 4').all();
  const spend = db.prepare(`SELECT category, SUM(ABS(amount)) as total FROM transactions WHERE amount<0 AND date>=date('now','-30 days') GROUP BY category ORDER BY total DESC LIMIT 5`).all();
  const inv   = db.prepare('SELECT SUM(invested) as i, SUM(current_value) as c FROM investments').get();
  const avg   = cf.length>1 ? cf.slice(1).reduce((s,r)=>s+(r.income-r.expenses),0)/(cf.length-1) : 0;
  ok(res, { monthly_cashflow:cf, top_spend_categories:spend, avg_monthly_savings:Math.round(avg), investment_return:inv.c-inv.i, investment_return_pct:+((((inv.c-inv.i)/inv.i)*100).toFixed(1)) });
});

app.get('/api/notifications', authMiddleware, (req, res) => {
  const alerts  = db.prepare('SELECT id,title,description,severity,created_at FROM alerts WHERE resolved=0 ORDER BY severity ASC LIMIT 5').all();
  const events  = db.prepare(`SELECT title,event_date,event_time FROM calendar_events WHERE event_date>=date('now') AND event_date<=date('now','+7 days') ORDER BY event_date,event_time LIMIT 3`).all();
  ok(res, { alerts, upcoming_events:events, unread_count:alerts.length });
});

app.get('/api/settings', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const map  = {}; rows.forEach(r => { if (!r.key.includes('secret') && !r.key.includes('token')) map[r.key]=r.value; });
  ok(res, map);
});
app.patch('/api/settings/:key', authMiddleware, (req, res) => {
  const { value } = req.body;
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(req.params.key, String(value));
  ok(res, { updated:true });
});

app.get('/api/search', authMiddleware, (req, res) => {
  const { q } = req.query;
  if (!q||q.length<2) return ok(res,{transactions:[],documents:[],emails:[]});
  const like = `%${q}%`;
  ok(res, {
    transactions: db.prepare(`SELECT 'transaction' as type,id,description as title,category as subtitle,amount FROM transactions WHERE description LIKE ? OR category LIKE ? LIMIT 5`).all(like,like),
    documents:    db.prepare(`SELECT 'document' as type,id,name as title,category as subtitle FROM vault_documents WHERE name LIKE ? OR category LIKE ? LIMIT 5`).all(like,like),
    emails:       db.prepare(`SELECT 'email' as type,id,subject as title,sender as subtitle FROM emails WHERE subject LIKE ? OR sender LIKE ? LIMIT 5`).all(like,like),
  });
});

// ─────────────────────────────────────────────
// CRON SCHEDULER
// ─────────────────────────────────────────────
function setupScheduler() {
  // Daily 9 AM: check EMIs due in 3 days → create alerts
  cron.schedule('0 9 * * *', () => {
    console.log('⏰ Cron: checking upcoming EMIs...');
    const upcoming = db.prepare(`SELECT * FROM calendar_events WHERE type='payment' AND event_date=date('now','+3 days')`).all();
    upcoming.forEach(e => {
      const exists = db.prepare('SELECT id FROM alerts WHERE title=? AND resolved=0').get('Upcoming: ' + e.title);
      if (!exists) {
        db.prepare(`INSERT INTO alerts(title,description,severity,category,created_at) VALUES(?,?,?,?,datetime('now'))`)
          .run('Upcoming: '+e.title, e.description+' due in 3 days', 'warning', 'Payment');
      }
    });
  });

  // Daily midnight: check document expiry
  cron.schedule('0 0 * * *', () => {
    console.log('⏰ Cron: checking document expiry...');
    const expiring = db.prepare(`SELECT * FROM vault_documents WHERE expiry_date IS NOT NULL AND expiry_date<=date('now','+30 days') AND status!='Expired'`).all();
    expiring.forEach(d => {
      db.prepare('UPDATE vault_documents SET status=? WHERE id=?').run('Expiring', d.id);
      const exists = db.prepare(`SELECT id FROM alerts WHERE title LIKE ? AND resolved=0`).get('%'+d.name+'%');
      if (!exists) {
        db.prepare(`INSERT INTO alerts(title,description,severity,category,created_at) VALUES(?,?,?,?,datetime('now'))`)
          .run(d.name+' Expiring Soon', `Expires ${d.expiry_date}. Renew to avoid disruption.`, 'warning', 'Documents');
      }
    });
  });

  // Monday 8 AM: weekly budget check
  cron.schedule('0 8 * * 1', async () => {
    console.log('⏰ Cron: weekly budget review...');
    const cats = db.prepare(`SELECT bc.name, bc.budget, COALESCE(ba.spent,0) as spent FROM budget_categories bc LEFT JOIN budget_actuals ba ON bc.id=ba.category_id AND ba.month=strftime('%Y-%m','now')`).all();
    cats.filter(c => c.spent > c.budget).forEach(c => {
      db.prepare(`INSERT INTO alerts(title,description,severity,category,created_at) VALUES(?,?,?,?,datetime('now'))`)
        .run(`Budget Breach: ${c.name}`, `Spent ₹${c.spent} vs ₹${c.budget} budget (${Math.round(c.spent/c.budget*100)}%)`, 'warning', 'Budget');
    });
  });

  console.log('✅ Scheduler active: EMI reminders · Document expiry · Budget alerts');
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 PLOS Backend  →  http://localhost:${PORT}`);
  console.log(`📊 App           →  http://localhost:${PORT}/plos-saas.html`);
  console.log(`🗄️  DB            →  ${DB_PATH}`);
  console.log(`🤖 Gemini AI     →  ${getSetting('gemini_api_key') ? '✅ Key set' : '⚠️  No key — add in Settings'}`);
  console.log(`📧 Gmail         →  ${getSetting('gmail_connected')==='1' ? '✅ Connected' : '⚠️  Not connected'}\n`);
  setupScheduler();
});
