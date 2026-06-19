import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ─── Firebase Admin (graceful on Vercel) ──────────────────────────────
let db = null, auth = null, isConfigured = false;
try {
  const pkg = (await import('firebase-admin')).default;
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;
  if (serviceAccount?.projectId) {
    if (!pkg.apps?.length) {
      pkg.initializeApp({
        credential: pkg.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://login-data-680b9-default-rtdb.firebaseio.com',
      });
    }
    db = pkg.database();
    auth = pkg.auth();
    isConfigured = true;
  }
} catch (e) { console.warn('Firebase Admin unavailable:', e.message); }

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ─────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-craft-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' },
}));

// ─── Passport ──────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/auth/google/callback` : '/auth/google/callback'),
}, async (accessToken, refreshToken, profile, done) => {
  done(null, { id: profile.id, uid: profile.id, email: profile.emails?.[0]?.value || '', displayName: profile.displayName || '', photoURL: profile.photos?.[0]?.value || '', provider: 'google' });
}));
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));
app.use(passport.initialize());
app.use(passport.session());

// ─── Views & Static ────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'server', 'views'));
app.use(express.static(path.join(rootDir, 'server', 'public')));

// ─── Helpers ───────────────────────────────────────────────────────────
const encodeEmail = (e) => e.toLowerCase().trim().replace(/\./g, ',');
const snapToArray = (v) => v ? Object.entries(v).map(([id, data]) => ({ id, ...data })) : [];
const INQUIRIES = path.join(rootDir, 'server', 'inquiries.json');
const REFERRALS = path.join(rootDir, 'server', 'referrals.json');
const VISITS = path.join(rootDir, 'server', 'referral-visits.json');
const ADMINS = path.join(rootDir, 'server', 'admins.json');
const rj = (p, f = []) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : f;
const wj = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8');

const giid = (uid = '') => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = String(uid);
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) { a ^= s.charCodeAt(i); a = Math.imul(a, 16777619); b ^= s.charCodeAt(i) + i; b = Math.imul(b, 1597334677); }
  let v = (BigInt(a >>> 0) << 32n) | BigInt(b >>> 0), r = '';
  for (let i = 0; i < 8; i++) { r += c[Number(v % BigInt(c.length))]; v /= BigInt(c.length); }
  return `dev-craft-${r}`;
};

const gd = async (p) => { if (!db) return null; const s = await db.ref(p).once('value'); return s.exists() ? s.val() : null; };
const sd = async (p, d) => { if (db) await db.ref(p).set(d); };
const pd = async (p, d) => { if (!db) return null; const r = db.ref(p).push(); await r.set(d); return r.key; };
const ud = async (p, d) => { if (db) await db.ref(p).update(d); };
const rd = async (p) => { if (db) await db.ref(p).remove(); };

function render(res, page, data = {}) {
  const u = res.req?.user || null;
  res.render(page, { user: u, isAdmin: u?.isAdmin || false, path: res.req?.path || '/', ...data });
}

function ensure(req, res, next) { if (req.isAuthenticated()) return next(); res.redirect('/auth'); }
async function chkAdmin(req, res, next) {
  if (!req.user) return res.redirect('/auth');
  const email = req.user.email?.toLowerCase().trim();
  if (email === 'rutujdhodapkar@gmail.com') { req.user.isAdmin = true; return next(); }
  try {
    if (isConfigured) { const s = await gd(`admins/${encodeEmail(email)}`); req.user.isAdmin = !!s; }
    else { req.user.isAdmin = rj(ADMINS).some(a => a.toLowerCase().trim() === email); }
  } catch { req.user.isAdmin = false; }
  next();
}

// ─── Auth Routes ───────────────────────────────────────────────────────
app.get('/auth', (req, res) => render(res, 'auth'));
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/auth?error=login_failed' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// ─── SSR Pages ─────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  let cp = [], hiw = [], fqs = [];
  try {
    if (isConfigured) { const [c, h, f] = await Promise.all([gd('careerPaths'), gd('howItWorks'), gd('faqs')]); cp = snapToArray(c); hiw = snapToArray(h).sort((a, b) => (a.step||0)-(b.step||0)); fqs = snapToArray(f); }
  } catch {}
  const D = [{id:'path_python',title:'Python Development',duration:'4 Weeks',description:'Gain hands-on software development experience with Python.',features:['Basic Python syntax & scripting','OOP & Data structures','Flask & Django','Final capstone'],projects:[{title:'Personal Portfolio',description:'Build a portfolio with Flask',type:'text'},{title:'Weather App',description:'Fetch real-time weather data',type:'text'},{title:'Python Quiz',description:'Test Python fundamentals',type:'quiz'}]},{id:'path_java',title:'Java Development',duration:'4 Weeks',description:'Build enterprise apps with Java and Spring Boot.',features:['Java Core & JVM','OOP & Interface Design','Spring Boot microservices','Database integration'],projects:[{title:'Library System',description:'Console-based library management',type:'text'},{title:'REST API',description:'CRUD API with Spring Boot',type:'text'},{title:'Java Quiz',description:'Test Java concepts',type:'quiz'}]},{id:'path_web',title:'Web Development',duration:'4 Weeks',description:'Learn modern frontend with React.js.',features:['HTML5 & CSS3','JavaScript ES6+','React.js','State management & deployment'],projects:[{title:'Responsive Portfolio',description:'Personal portfolio website',type:'text'},{title:'Dashboard UI',description:'Admin dashboard with React',type:'text'},{title:'Web Dev Quiz',description:'Test web technologies',type:'quiz'}]}];
  render(res, 'index', { careerPaths: cp.length >= 3 ? cp : D, howItWorks: hiw.length ? hiw : [{step:1,title:'Select Domain',description:'Browse career paths and select your domain.'},{step:2,title:'Instant Offer Letter',description:'Log in with Google and get your offer letter.'},{step:3,title:'Complete Projects',description:'Work through real-world tasks.'},{step:4,title:'Get Certified',description:'Download your verified certificate.'}], faqs: fqs.length ? fqs : [{question:'Are internships really free?',answer:'Yes, 100% free. No hidden fees.'},{question:'Who can apply?',answer:'Any college student or self-taught learner.'},{question:'How is progress tracked?',answer:'Submit projects through your dashboard for review.'},{question:'Is the certificate verified?',answer:'Yes, each has a unique ID for public verification.'}] });
});

app.get('/dashboard', ensure, async (req, res) => {
  let enrollments = [], referralCode = null;
  try {
    if (isConfigured) { const all = await gd('enrollments'); enrollments = snapToArray(all).filter(e => e.uid === req.user.id); const cs = await gd(`selfReferralOwners/${req.user.id}`); if (cs) referralCode = cs.code; }
  } catch {}
  render(res, 'dashboard', { enrollments, referralCode });
});

app.get('/admin', ensure, chkAdmin, async (req, res) => {
  if (!req.user.isAdmin) return res.redirect('/');
  let enrollments = [], referrals = [], referralUsers = {}, siteVisits = [];
  try {
    if (isConfigured) { const [e, r, ru, sv] = await Promise.all([gd('enrollments'), gd('referrals'), gd('referralUsers'), gd('siteVisits')]); enrollments = snapToArray(e).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')); referrals = snapToArray(r); referralUsers = ru||{}; siteVisits = snapToArray(sv); }
  } catch {}
  render(res, 'admin', { enrollments, referrals, referralUsers, siteVisits });
});

app.get('/verify', (req, res) => render(res, 'verify'));

// ─── API Routes ────────────────────────────────────────────────────────
app.post('/api/inquire', (req, res) => {
  const { name, email, phone, projectType, planTier } = req.body;
  if (!name || !email || !phone || !projectType || !planTier) return res.status(400).json({ success: false, message: 'Required fields missing.' });
  const inquiry = { id: `INQ-${Date.now()}`, createdAt: new Date().toISOString(), ...req.body, status: 'contacted', progress: 'New request' };
  try { const d = rj(INQUIRIES); d.push(inquiry); wj(INQUIRIES, d); return res.status(201).json({ success: true, message: 'Inquiry received!', inquiryId: inquiry.id }); } catch { return res.status(500).json({ success: false }); }
});

app.get('/api/inquiries', (req, res) => res.json({ success: true, data: rj(INQUIRIES) }));
app.delete('/api/inquiries/:id', (req, res) => { const d = rj(INQUIRIES); wj(INQUIRIES, d.filter(i => i.id !== req.params.id)); res.json({ success: true }); });

let cachedRates = null, lastFetch = 0;
const FR = { USD: 1, INR: 83.5, EUR: 0.93, GBP: 0.79, CAD: 1.37, AUD: 1.51, JPY: 157.4 };
app.get('/api/rates', async (req, res) => {
  const now = Date.now();
  if (cachedRates && now - lastFetch < 3600000) return res.json({ success: true, rates: cachedRates, source: 'cache' });
  try { const r = await fetch('https://open.er-api.com/v6/latest/USD'); if (r.ok) { const d = await r.json(); if (d?.rates) { cachedRates = d.rates; lastFetch = now; return res.json({ success: true, rates: cachedRates, source: 'network' }); } } } catch {}
  res.json({ success: true, rates: FR, source: 'fallback' });
});

app.post('/api/check-admin', async (req, res) => {
  const e = req.body.email?.toLowerCase().trim();
  if (!e) return res.status(400).json({ success: false });
  if (e === 'rutujdhodapkar@gmail.com') return res.json({ success: true, isAdmin: true });
  if (isConfigured) { const s = await gd(`admins/${encodeEmail(e)}`); return res.json({ success: true, isAdmin: !!s }); }
  res.json({ success: true, isAdmin: rj(ADMINS).some(a => a.toLowerCase().trim() === e) });
});

app.get('/api/admins', async (req, res) => {
  if (isConfigured) { const s = await gd('admins'); const a = s ? Object.keys(s).map(k => k.replace(/,/g, '.')) : []; return res.json({ success: true, data: a }); }
  res.json({ success: true, data: rj(ADMINS) });
});

app.post('/api/admins', async (req, res) => {
  const e = req.body.email?.toLowerCase().trim();
  if (!e) return res.status(400).json({ success: false });
  if (isConfigured) { await sd(`admins/${encodeEmail(e)}`, { email: e, addedAt: new Date().toISOString() }); return res.json({ success: true }); }
  const d = rj(ADMINS); if (!d.includes(e)) d.push(e); wj(ADMINS, d); res.json({ success: true });
});

app.delete('/api/admins/:email', async (req, res) => {
  const e = req.params.email?.toLowerCase().trim();
  if (isConfigured) { await rd(`admins/${encodeEmail(e)}`); return res.json({ success: true }); }
  wj(ADMINS, rj(ADMINS).filter(a => a.toLowerCase().trim() !== e)); res.json({ success: true });
});

app.post('/api/enroll', ensure, async (req, res) => {
  try {
    const { domainId, title, duration, projects } = req.body;
    if (!domainId || !title) return res.status(400).json({ success: false, message: 'Domain info required.' });
    if (isConfigured) {
      const existing = snapToArray(await gd('enrollments')).filter(e => e.uid === req.user.id);
      if (existing.some(e => e.domainId === domainId)) return res.json({ success: true, data: existing.find(e => e.domainId === domainId) });
      const internId = giid(req.user.id);
      let refCode = ''; try { const u = await gd(`users/${req.user.id}`); if (u?.selfReferralCode) refCode = u.selfReferralCode; } catch {}
      const enrollment = { internId, uid: req.user.id, name: req.user.displayName||'', email: req.user.email||'', domainId, domain: title, duration: duration||'4 Weeks', projects: projects||[], status: 'Active', submissions: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), referralCode: refCode };
      const id = await pd('enrollments', enrollment); enrollment.id = id;
      return res.status(201).json({ success: true, data: enrollment });
    }
    res.status(500).json({ success: false, message: 'Database not configured.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/enrollments', async (req, res) => {
  if (isConfigured) { const a = await gd('enrollments'); return res.json({ success: true, data: snapToArray(a) }); }
  res.json({ success: true, data: [] });
});

app.get('/api/enrollments/user/:uid', async (req, res) => {
  if (isConfigured) { const a = await gd('enrollments'); return res.json({ success: true, data: snapToArray(a).filter(e => e.uid === req.params.uid) }); }
  res.json({ success: true, data: [] });
});

app.get('/api/enrollments/:id', async (req, res) => {
  if (isConfigured) { const d = await gd(`enrollments/${req.params.id}`); return res.json({ success: true, data: d }); }
  res.json({ success: true, data: null });
});

app.post('/api/enrollments/:id/submit', ensure, async (req, res) => {
  const { projectIndex, submissionText } = req.body;
  if (projectIndex === undefined || !submissionText) return res.status(400).json({ success: false });
  if (isConfigured) { await ud(`enrollments/${req.params.id}/submissions/${projectIndex}`, { text: submissionText, submittedAt: new Date().toISOString(), verified: false, verifiedAt: null, resubmit: false }); await ud(`enrollments/${req.params.id}`, { updatedAt: new Date().toISOString() }); }
  res.json({ success: true });
});

app.post('/api/enrollments/:id/verify/:projectIndex', ensure, async (req, res) => {
  if (isConfigured) { await ud(`enrollments/${req.params.id}/submissions/${req.params.projectIndex}`, { verified: true, verifiedAt: new Date().toISOString() }); await ud(`enrollments/${req.params.id}`, { updatedAt: new Date().toISOString() }); }
  res.json({ success: true });
});

app.post('/api/enrollments/:id/reject/:projectIndex', ensure, async (req, res) => {
  const { feedback } = req.body;
  if (isConfigured) { await ud(`enrollments/${req.params.id}/submissions/${req.params.projectIndex}`, { verified: false, resubmit: true, feedback, rejectedAt: new Date().toISOString(), submittedAt: null }); await ud(`enrollments/${req.params.id}`, { updatedAt: new Date().toISOString() }); }
  res.json({ success: true });
});

app.post('/api/enrollments/:id/status', ensure, async (req, res) => {
  const { status } = req.body;
  if (isConfigured) { await ud(`enrollments/${req.params.id}`, { status, updatedAt: new Date().toISOString() }); }
  res.json({ success: true });
});

app.delete('/api/enrollments/:id', ensure, async (req, res) => {
  if (isConfigured) await rd(`enrollments/${req.params.id}`);
  res.json({ success: true });
});

app.post('/api/enrollments/:id/certificate', ensure, async (req, res) => {
  const { allowed } = req.body;
  if (isConfigured) { await ud(`enrollments/${req.params.id}`, { allowedCertificate: allowed, updatedAt: new Date().toISOString() }); }
  res.json({ success: true });
});

app.get('/api/referrals', async (req, res) => {
  if (isConfigured) { const r = await gd('referrals'); return res.json({ success: true, data: snapToArray(r) }); }
  res.json({ success: true, data: rj(REFERRALS) });
});

app.post('/api/referrals', async (req, res) => {
  const code = `REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const payload = { ...req.body, code, visited: 0, selected: 0, loggedIn: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (isConfigured) { await sd(`referrals/${code}`, payload); return res.status(201).json({ success: true, data: payload }); }
  const d = rj(REFERRALS); d.push(payload); wj(REFERRALS, d); res.status(201).json({ success: true, data: payload });
});

app.post('/api/referrals/self', ensure, async (req, res) => {
  const { name, email, phone, college, city, country, upiId } = req.body;
  if (!name || !email || !phone || !college || !city || !country || !upiId) return res.status(400).json({ success: false, message: 'All fields required.' });
  const prefix = name.replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const code = `${prefix}-${suffix}`;
  const payload = { code, name, email, phone, college, city, country, upiId, createdBy: req.user.id, isSelfReferral: true, visited: 0, selected: 0, loggedIn: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (isConfigured) { await sd(`referrals/${code}`, payload); await sd(`selfReferralOwners/${req.user.id}`, { code, createdAt: payload.createdAt }); await ud(`users/${req.user.id}`, { selfReferralCode: code }); return res.status(201).json({ success: true, data: payload }); }
  res.status(500).json({ success: false, message: 'Database not configured.' });
});

app.get('/api/referrals/self/:uid', async (req, res) => {
  if (isConfigured) { const d = await gd(`selfReferralOwners/${req.params.uid}`); return res.json({ success: true, data: d ? d.code : null }); }
  res.json({ success: true, data: null });
});

app.get('/api/referrals/dashboard/:uid', async (req, res) => {
  if (!isConfigured) return res.json({ success: true, data: null });
  const cd = await gd(`selfReferralOwners/${req.params.uid}`);
  if (!cd?.code) return res.json({ success: true, data: null });
  const code = cd.code.toUpperCase();
  const [referral, enrollments, visits, referralUsers] = await Promise.all([gd(`referrals/${code}`), gd('enrollments'), gd('referralVisits'), gd(`referralUsers/${code}`)]);
  res.json({ success: true, data: { referral, enrollments: snapToArray(enrollments).filter(e => (e.referralCode||'').toUpperCase() === code), visits: snapToArray(visits).filter(v => (v.referralCode||'').toUpperCase() === code), referralUsers: Object.values(referralUsers||{}) } });
});

app.delete('/api/referrals/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (isConfigured) { await rd(`referrals/${code}`); try { await rd(`referralUsers/${code}`); } catch {} return res.json({ success: true }); }
  wj(REFERRALS, rj(REFERRALS).filter(r => (r.code||'').toUpperCase() !== code)); res.json({ success: true });
});

app.post('/api/referrals/:code/contacted', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (isConfigured) { const ref = await gd(`referrals/${code}`); if (ref) await ud(`referrals/${code}`, { selected: (ref.selected||0)+1, lastSelectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
  res.json({ success: true });
});

app.post('/api/referral-visits', async (req, res) => {
  const code = String(req.body.referralCode||'').toUpperCase();
  const visit = { id: `VIS-${Date.now()}`, ...req.body, referralCode: code, visitedAt: new Date().toISOString(), action: 'visited' };
  if (isConfigured) { const ref = await gd(`referrals/${code}`); visit.matched = !!ref; await pd('referralVisits', visit); if (ref) await ud(`referrals/${code}`, { visited: (ref.visited||0)+1, lastVisitedAt: visit.visitedAt, updatedAt: new Date().toISOString() }); return res.status(201).json({ success: true, data: visit }); }
  const [refs, vis] = [rj(REFERRALS), rj(VISITS)];
  const matched = refs.find(r => (r.code||'').toUpperCase() === code);
  visit.matched = !!matched; vis.push(visit);
  if (matched) matched.visited = (matched.visited||0)+1;
  wj(VISITS, vis); wj(REFERRALS, refs); res.status(201).json({ success: true, data: visit });
});

app.get('/api/users/:uid', async (req, res) => {
  if (isConfigured) { const d = await gd(`users/${req.params.uid}`); return res.json({ success: true, data: d }); }
  res.json({ success: true, data: null });
});

app.post('/api/users/:uid', async (req, res) => {
  if (isConfigured) await ud(`users/${req.params.uid}`, { ...req.body, updatedAt: new Date().toISOString() });
  res.json({ success: true });
});

app.get('/api/admin-messages', async (req, res) => {
  if (isConfigured) { const m = await gd('adminMessages'); return res.json({ success: true, data: snapToArray(m) }); }
  res.json({ success: true, data: [] });
});

app.post('/api/admin-messages', ensure, async (req, res) => {
  const msg = { id: `MSG-${Date.now()}`, ...req.body, createdAt: new Date().toISOString(), createdBy: req.user.email };
  if (isConfigured) { const id = await pd('adminMessages', msg); msg.id = id; return res.status(201).json({ success: true, data: msg }); }
  res.status(201).json({ success: true, data: msg });
});

app.post('/api/admin-messages/:id/acknowledge', async (req, res) => {
  if (isConfigured) await pd(`adminMessageAcks/${req.params.id}`, { ...req.body, acknowledgedAt: new Date().toISOString() });
  res.json({ success: true });
});

app.post('/api/site-visits', async (req, res) => {
  if (isConfigured) await pd('siteVisits', { ...req.body, visitedAt: new Date().toISOString() });
  res.json({ success: true });
});

app.post('/api/ai/verify-task', async (req, res) => {
  const { taskTitle, submissionText, taskDescription, taskNotices, submissionUrl, internName, codeFiles } = req.body;
  if (!taskTitle || !submissionText) return res.status(400).json({ success: false, message: 'Task title and submission text required.' });
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, message: 'NVIDIA API key not configured.' });
  try {
    const parts = [`Task Title: ${taskTitle}`, `Task Description: ${taskDescription||''}`];
    if (taskNotices?.trim()) parts.push(`Task Notices:\n${taskNotices}`);
    parts.push(`Student Name: ${internName||'Unknown'}`, `Submission: ${submissionText}`);
    if (submissionUrl) parts.push(`URL: ${submissionUrl}`);
    if (codeFiles?.length) { parts.push('\n=== CODE ==='); for (const f of codeFiles) parts.push(`\n--- ${f.path||f.name||'file'} ---\n${f.content}`); parts.push('\n=== END CODE ==='); } else parts.push('\nNo code fetched.');
    const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'meta/llama-3.3-70b-instruct', messages: [{ role: 'system', content: 'You are an AI task verifier. Respond JSON only: { "verified": boolean, "confidence": number, "reason": "string", "message": "string" }' }, { role: 'user', content: parts.join('\n') }], temperature: 0.3, max_tokens: 600 }),
    });
    if (!resp.ok) throw new Error(`NVIDIA error ${resp.status}`);
    const d = await resp.json();
    const c = d.choices?.[0]?.message?.content || '';
    const m = c.match(/\{[\s\S]*\}/);
    const r = m ? JSON.parse(m[0]) : { verified: false, confidence: 0, reason: 'Parse failed', message: 'AI verification failed.' };
    res.json({ success: true, data: { ...r, rawResponse: c } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/grade-quiz-text', (req, res) => res.json({ success: true, correct: false, reason: 'Manual review' }));

app.get('/api/user/profile', ensure, async (req, res) => {
  if (isConfigured) { const d = await gd(`users/${req.user.id}`); return res.json({ success: true, data: d }); }
  res.json({ success: true, data: null });
});

app.post('/api/user/profile', ensure, async (req, res) => {
  if (isConfigured) await ud(`users/${req.user.id}`, { ...req.body, updatedAt: new Date().toISOString() });
  res.json({ success: true });
});

app.post('/api/check-ban', async (req, res) => {
  const e = req.body.email?.toLowerCase().trim();
  if (!e || !isConfigured) return res.json({ success: true, data: null });
  const bans = snapToArray(await gd('bannedUsers'));
  res.json({ success: true, data: bans.find(b => b.email?.toLowerCase().trim() === e) || null });
});

app.post('/api/ban-user', ensure, async (req, res) => {
  const { email, banType, reason } = req.body;
  if (!email || !isConfigured) return res.status(400).json({ success: false });
  const existing = snapToArray(await gd('bannedUsers')).filter(b => b.email?.toLowerCase().trim() !== email.toLowerCase().trim());
  existing.push({ email: email.toLowerCase().trim(), banType: banType||'both', reason: reason||'', bannedAt: new Date().toISOString() });
  await sd('bannedUsers', existing.reduce((a, b) => { a[b.email.replace(/\./g, ',')] = b; return a; }, {}));
  res.json({ success: true });
});

app.post('/api/unban-user', ensure, async (req, res) => {
  const { email } = req.body;
  if (!email || !isConfigured) return res.json({ success: true });
  const existing = snapToArray(await gd('bannedUsers')).filter(b => b.email?.toLowerCase().trim() !== email.toLowerCase().trim());
  await sd('bannedUsers', existing.reduce((a, b) => { a[b.email.replace(/\./g, ',')] = b; return a; }, {}));
  res.json({ success: true });
});

app.post('/api/track-visit', async (req, res) => {
  if (isConfigured) await pd('siteVisits', { ...req.body, visitedAt: new Date().toISOString() });
  res.json({ success: true });
});

// ─── Export for Vercel ─────────────────────────────────────────────────
export default app;

// ─── Local dev ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const localPort = process.env.PORT || 5000;
  app.listen(localPort, () => {
    console.log(`DEV/CRAFT running on http://localhost:${localPort}`);
    console.log(`Firebase configured: ${isConfigured}`);
  });
}
