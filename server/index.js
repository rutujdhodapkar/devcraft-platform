import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import admin, { db, auth, isConfigured, getData, setData, pushData, updateData, removeData } from './firebase-admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Express Setup ──────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5000', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Session ────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-craft-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

// ─── Passport Google OAuth ──────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const user = {
      id: profile.id,
      uid: profile.id,
      email: profile.emails?.[0]?.value || '',
      displayName: profile.displayName || '',
      photoURL: profile.photos?.[0]?.value || '',
      provider: 'google',
    };
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ─── EJS Setup ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────
const encodeEmail = (e) => e.toLowerCase().trim().replace(/\./g, ',');
const snapToArray = (val) => val ? Object.entries(val).map(([id, data]) => ({ id, ...data })) : [];
const INQUIRIES_FILE = path.join(__dirname, 'inquiries.json');
const REFERRALS_FILE = path.join(__dirname, 'referrals.json');
const VISITS_FILE = path.join(__dirname, 'referral-visits.json');
const ADMINS_FILE = path.join(__dirname, 'admins.json');

async function readJson(filePath, fallback = []) {
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch { return fallback; }
}
async function writeJson(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function generateInternId(uid = '') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const source = String(uid || 'anonymous-user');
  let hashA = 2166136261, hashB = 0x9e3779b9;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    hashA ^= code; hashA = Math.imul(hashA, 16777619);
    hashB ^= code + i; hashB = Math.imul(hashB, 1597334677);
  }
  let value = (BigInt(hashA >>> 0) << 32n) | BigInt(hashB >>> 0);
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars[Number(value % BigInt(chars.length))];
    value /= BigInt(chars.length);
  }
  return `dev-craft-${result}`;
}

function renderPage(res, page, data = {}) {
  const user = res.req?.user || null;
  res.render(page, {
    user,
    isAdmin: user?.isAdmin || false,
    path: res.req?.path || '/',
    ...data,
  });
}

// ─── Passport middleware ──────────────────────────────────────────────────
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/auth');
}

async function checkAdmin(req, res, next) {
  if (!req.user) return res.redirect('/auth');
  const email = req.user.email?.toLowerCase().trim();
  if (email === 'rutujdhodapkar@gmail.com') { req.user.isAdmin = true; return next(); }
  try {
    if (isConfigured) {
      const snap = await getData(`admins/${encodeEmail(email)}`);
      req.user.isAdmin = !!snap;
    } else {
      const admins = await readJson(ADMINS_FILE);
      req.user.isAdmin = admins.some(a => a.toLowerCase().trim() === email);
    }
  } catch { req.user.isAdmin = false; }
  next();
}

// ─── Auth Routes ────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  renderPage(res, 'auth');
});

app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account',
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth?error=login_failed' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) console.error('Logout error:', err);
    res.redirect('/');
  });
});

// ─── SSR Page Routes ──────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  let careerPaths = [], howItWorks = [], faqs = [];
  try {
    if (isConfigured) {
      const [cp, hiw, f] = await Promise.all([
        getData('careerPaths'), getData('howItWorks'), getData('faqs'),
      ]);
      careerPaths = snapToArray(cp);
      howItWorks = snapToArray(hiw).sort((a, b) => (a.step || 0) - (b.step || 0));
      faqs = snapToArray(f);
    }
  } catch (e) { console.error('Error fetching data:', e.message); }

  const DEFAULT_PATHS = [
    { id: 'path_python', title: 'Python Development', duration: '4 Weeks', description: 'Gain hands-on software development experience with Python scripting, data structures, and backends.', features: ['Basic Python syntax & scripting', 'OOP & Data structures', 'Flask & Django web development', 'Final capstone project'], projects: [{ title: 'Personal Portfolio Website', description: 'Build a personal portfolio website using Python Flask', type: 'text' }, { title: 'Weather Web App', description: 'Create a weather web application fetching real-time data', type: 'text' }, { title: 'Python Basics Quiz', description: 'Test your understanding of Python fundamentals', type: 'quiz' }] },
    { id: 'path_java', title: 'Java Development', duration: '4 Weeks', description: 'Build enterprise-ready applications using Java Core, Spring Boot microservices, and databases.', features: ['Java Core & JVM concepts', 'OOP & Interface Design', 'Spring Boot microservices', 'Database integration & SQL'], projects: [{ title: 'Library Management System', description: 'Design a console-based library management system', type: 'text' }, { title: 'REST API Backend', description: 'Build a RESTful API backend with Spring Boot', type: 'text' }, { title: 'Java Fundamentals Quiz', description: 'Test your knowledge of Java core concepts', type: 'quiz' }] },
    { id: 'path_web', title: 'Web Development', duration: '4 Weeks', description: 'Learn to design and deploy modern, responsive frontend user interfaces using React.js and CSS.', features: ['HTML5 & CSS3 layout systems', 'JavaScript ES6+ fundamentals', 'React.js frontend frameworks', 'State management & deployment'], projects: [{ title: 'Responsive Portfolio', description: 'Build a responsive personal portfolio website', type: 'text' }, { title: 'Admin Dashboard UI', description: 'Create an admin dashboard interface with React', type: 'text' }, { title: 'Web Development Quiz', description: 'Test your understanding of web technologies', type: 'quiz' }] },
  ];

  const DEFAULT_HIW = [
    { step: 1, title: 'Select Domain', description: 'Browse our available career paths and select your preferred domain.' },
    { step: 2, title: 'Instant Offer Letter', description: 'Log in with Google, fill in your profile, and receive your official offer letter instantly.' },
    { step: 3, title: 'Complete Projects', description: 'Work through structured real-world tasks and submit them.' },
    { step: 4, title: 'Get Certified', description: 'Once verified, download your industry-ready internship completion certificate.' },
  ];

  const DEFAULT_FAQS = [
    { question: 'Are the internships really 100% free?', answer: 'Yes, all our virtual internships are 100% free of cost. There are no hidden fees or charges for learning and certification.' },
    { question: 'Who is eligible to apply?', answer: 'Any college student or self-taught learner looking to gain practical software development and coding experience is welcome to apply.' },
    { question: 'How will my internship progress be tracked?', answer: 'You will work on self-paced projects. Once you complete the projects, you submit them through the student area, and the team will verify your completion.' },
    { question: 'Is the certificate verified?', answer: 'Yes, every certificate has a unique ID and can be verified publicly on our website through the verify button.' },
  ];

  renderPage(res, 'index', {
    careerPaths: careerPaths.length >= 3 ? careerPaths : DEFAULT_PATHS,
    howItWorks: howItWorks.length ? howItWorks : DEFAULT_HIW,
    faqs: faqs.length ? faqs : DEFAULT_FAQS,
  });
});

app.get('/dashboard', ensureAuth, async (req, res) => {
  let enrollments = [], referralCode = null;
  try {
    if (isConfigured) {
      const all = await getData('enrollments');
      const allEnrollments = snapToArray(all);
      enrollments = allEnrollments.filter(e => e.uid === req.user.id);
      const codeSnap = await getData(`selfReferralOwners/${req.user.id}`);
      if (codeSnap) referralCode = codeSnap.code;
    }
  } catch (e) { console.error(e.message); }
  renderPage(res, 'dashboard', { enrollments, referralCode });
});

app.get('/admin', ensureAuth, checkAdmin, async (req, res) => {
  if (!req.user.isAdmin) return res.redirect('/');
  let enrollments = [], referrals = [], referralUsers = {}, siteVisits = [];
  try {
    if (isConfigured) {
      const [e, r, ru, sv] = await Promise.all([
        getData('enrollments'), getData('referrals'), getData('referralUsers'), getData('siteVisits'),
      ]);
      enrollments = snapToArray(e).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      referrals = snapToArray(r);
      referralUsers = ru || {};
      siteVisits = snapToArray(sv);
    }
  } catch (e) { console.error(e.message); }
  renderPage(res, 'admin', { enrollments, referrals, referralUsers, siteVisits });
});

app.get('/verify', (req, res) => {
  renderPage(res, 'verify');
});

// ─── API Routes ────────────────────────────────────────────────────────────
// Inquiries
app.post('/api/inquire', async (req, res) => {
  const { name, email, phone, projectType, planTier } = req.body;
  if (!name || !email || !phone || !projectType || !planTier) {
    return res.status(400).json({ success: false, message: 'Please provide all required fields.' });
  }
  const inquiry = { id: `INQ-${Date.now()}`, createdAt: new Date().toISOString(), ...req.body, status: 'contacted', progress: 'New request' };
  try {
    const inquiries = await readJson(INQUIRIES_FILE);
    inquiries.push(inquiry);
    await writeJson(INQUIRIES_FILE, inquiries);
    return res.status(201).json({ success: true, message: 'Inquiry received!', inquiryId: inquiry.id });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Error saving inquiry.' });
  }
});

app.get('/api/inquiries', async (req, res) => {
  const inquiries = await readJson(INQUIRIES_FILE);
  res.json({ success: true, data: inquiries });
});

app.delete('/api/inquiries/:id', async (req, res) => {
  const inquiries = await readJson(INQUIRIES_FILE);
  await writeJson(INQUIRIES_FILE, inquiries.filter(i => i.id !== req.params.id));
  res.json({ success: true });
});

// Rates
let cachedRates = null, lastFetchTime = 0;
const CACHE_DURATION = 1000 * 60 * 60;
const fallbackRates = { USD: 1, INR: 83.5, EUR: 0.93, GBP: 0.79, CAD: 1.37, AUD: 1.51, JPY: 157.4 };

app.get('/api/rates', async (req, res) => {
  const now = Date.now();
  if (cachedRates && (now - lastFetchTime < CACHE_DURATION)) {
    return res.json({ success: true, rates: cachedRates, source: 'cache' });
  }
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (response.ok) {
      const data = await response.json();
      if (data?.rates) { cachedRates = data.rates; lastFetchTime = now; return res.json({ success: true, rates: cachedRates, source: 'network' }); }
    }
  } catch {}
  res.json({ success: true, rates: fallbackRates, source: 'fallback' });
});

// Admin
app.post('/api/check-admin', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ success: false, message: 'Email required.' });
  if (email === 'rutujdhodapkar@gmail.com') return res.json({ success: true, isAdmin: true });
  if (isConfigured) {
    const snap = await getData(`admins/${encodeEmail(email)}`);
    return res.json({ success: true, isAdmin: !!snap });
  }
  const admins = await readJson(ADMINS_FILE);
  res.json({ success: true, isAdmin: admins.some(a => a.toLowerCase().trim() === email) });
});

app.get('/api/admins', async (req, res) => {
  if (isConfigured) {
    const snap = await getData('admins');
    const admins = snap ? Object.keys(snap).map(k => k.replace(/,/g, '.')) : [];
    return res.json({ success: true, data: admins });
  }
  const admins = await readJson(ADMINS_FILE);
  res.json({ success: true, data: admins });
});

app.post('/api/admins', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ success: false, message: 'Email required.' });
  if (isConfigured) {
    await setData(`admins/${encodeEmail(email)}`, { email, addedAt: new Date().toISOString() });
    return res.json({ success: true });
  }
  const admins = await readJson(ADMINS_FILE);
  if (!admins.includes(email)) admins.push(email);
  await writeJson(ADMINS_FILE, admins);
  res.json({ success: true, data: admins });
});

app.delete('/api/admins/:email', async (req, res) => {
  const email = req.params.email?.toLowerCase().trim();
  if (isConfigured) {
    await removeData(`admins/${encodeEmail(email)}`);
    return res.json({ success: true });
  }
  const admins = await readJson(ADMINS_FILE);
  await writeJson(ADMINS_FILE, admins.filter(a => a.toLowerCase().trim() !== email));
  res.json({ success: true });
});

// Enrollments API
app.post('/api/enroll', ensureAuth, async (req, res) => {
  try {
    const { domainId, title, duration, projects } = req.body;
    if (!domainId || !title) return res.status(400).json({ success: false, message: 'Domain info required.' });

    const existing = await getData('enrollments');
    const existingList = snapToArray(existing).filter(e => e.uid === req.user.id);
    if (existingList.some(e => e.domainId === domainId || e.domain === title)) {
      return res.json({ success: true, data: existingList.find(e => e.domainId === domainId || e.domain === title) });
    }

    const internId = generateInternId(req.user.id);
    let refCode = '';
    try {
      const userData = await getData(`users/${req.user.id}`);
      refCode = userData?.selfReferralCode || '';
    } catch {}

    const enrollment = {
      internId, uid: req.user.id, name: req.user.displayName || '', email: req.user.email || '',
      domainId, domain: title, duration: duration || '4 Weeks', projects: projects || [],
      status: 'Active', submissions: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      referralCode: refCode,
    };
    const id = await pushData('enrollments', enrollment);
    enrollment.id = id;
    res.status(201).json({ success: true, data: enrollment });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/enrollments', async (req, res) => {
  if (isConfigured) {
    const all = await getData('enrollments');
    return res.json({ success: true, data: snapToArray(all) });
  }
  res.json({ success: true, data: [] });
});

app.get('/api/enrollments/user/:uid', async (req, res) => {
  if (isConfigured) {
    const all = await getData('enrollments');
    const list = snapToArray(all).filter(e => e.uid === req.params.uid);
    return res.json({ success: true, data: list });
  }
  res.json({ success: true, data: [] });
});

app.get('/api/enrollments/:id', async (req, res) => {
  if (isConfigured) {
    const data = await getData(`enrollments/${req.params.id}`);
    return res.json({ success: true, data });
  }
  res.json({ success: true, data: null });
});

app.post('/api/enrollments/:id/submit', ensureAuth, async (req, res) => {
  const { projectIndex, submissionText } = req.body;
  if (projectIndex === undefined || !submissionText) {
    return res.status(400).json({ success: false, message: 'Project index and submission text required.' });
  }
  if (isConfigured) {
    await updateData(`enrollments/${req.params.id}/submissions/${projectIndex}`, {
      text: submissionText, submittedAt: new Date().toISOString(), verified: false, verifiedAt: null, resubmit: false,
    });
    await updateData(`enrollments/${req.params.id}`, { updatedAt: new Date().toISOString() });
    return res.json({ success: true });
  }
  res.json({ success: true });
});

app.post('/api/enrollments/:id/verify/:projectIndex', ensureAuth, async (req, res) => {
  if (isConfigured) {
    await updateData(`enrollments/${req.params.id}/submissions/${req.params.projectIndex}`, {
      verified: true, verifiedAt: new Date().toISOString(),
    });
    await updateData(`enrollments/${req.params.id}`, { updatedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

app.post('/api/enrollments/:id/reject/:projectIndex', ensureAuth, async (req, res) => {
  const { feedback } = req.body;
  if (isConfigured) {
    await updateData(`enrollments/${req.params.id}/submissions/${req.params.projectIndex}`, {
      verified: false, resubmit: true, feedback, rejectedAt: new Date().toISOString(), submittedAt: null,
    });
    await updateData(`enrollments/${req.params.id}`, { updatedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

app.post('/api/enrollments/:id/status', ensureAuth, async (req, res) => {
  const { status } = req.body;
  if (isConfigured) {
    await updateData(`enrollments/${req.params.id}`, { status, updatedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

app.delete('/api/enrollments/:id', ensureAuth, async (req, res) => {
  if (isConfigured) await removeData(`enrollments/${req.params.id}`);
  res.json({ success: true });
});

app.post('/api/enrollments/:id/certificate', ensureAuth, async (req, res) => {
  const { allowed } = req.body;
  if (isConfigured) {
    await updateData(`enrollments/${req.params.id}`, { allowedCertificate: allowed, updatedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

// Referrals API
app.get('/api/referrals', async (req, res) => {
  if (isConfigured) {
    const r = await getData('referrals');
    return res.json({ success: true, data: snapToArray(r) });
  }
  res.json({ success: true, data: await readJson(REFERRALS_FILE) });
});

app.post('/api/referrals', async (req, res) => {
  const code = `REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const payload = { ...req.body, code, visited: 0, selected: 0, loggedIn: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (isConfigured) {
    await setData(`referrals/${code}`, payload);
    return res.status(201).json({ success: true, data: payload });
  }
  const referrals = await readJson(REFERRALS_FILE);
  referrals.push(payload);
  await writeJson(REFERRALS_FILE, referrals);
  res.status(201).json({ success: true, data: payload });
});

app.post('/api/referrals/self', ensureAuth, async (req, res) => {
  const { name, email, phone, college, city, country, upiId } = req.body;
  if (!name || !email || !phone || !college || !city || !country || !upiId) {
    return res.status(400).json({ success: false, message: 'All fields required.' });
  }
  const prefix = name.replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const code = `${prefix}-${suffix}`;
  const payload = { code, name, email, phone, college, city, country, upiId, createdBy: req.user.id, isSelfReferral: true, visited: 0, selected: 0, loggedIn: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (isConfigured) {
    await setData(`referrals/${code}`, payload);
    await setData(`selfReferralOwners/${req.user.id}`, { code, createdAt: payload.createdAt });
    await updateData(`users/${req.user.id}`, { selfReferralCode: code });
    return res.status(201).json({ success: true, data: payload });
  }
  res.status(500).json({ success: false, message: 'Database not configured.' });
});

app.get('/api/referrals/self/:uid', async (req, res) => {
  if (isConfigured) {
    const d = await getData(`selfReferralOwners/${req.params.uid}`);
    return res.json({ success: true, data: d ? d.code : null });
  }
  res.json({ success: true, data: null });
});

app.get('/api/referrals/dashboard/:uid', async (req, res) => {
  if (!isConfigured) return res.json({ success: true, data: null });
  const codeData = await getData(`selfReferralOwners/${req.params.uid}`);
  if (!codeData?.code) return res.json({ success: true, data: null });
  const code = codeData.code.toUpperCase();
  const [referral, enrollments, visits, referralUsers] = await Promise.all([
    getData(`referrals/${code}`), getData('enrollments'), getData('referralVisits'), getData(`referralUsers/${code}`),
  ]);
  const allEnrollments = snapToArray(enrollments).filter(e => (e.referralCode || '').toUpperCase() === code);
  const allVisits = snapToArray(visits).filter(v => (v.referralCode || '').toUpperCase() === code);
  res.json({ success: true, data: { referral, enrollments: allEnrollments, visits: allVisits, referralUsers: Object.values(referralUsers || {}) } });
});

app.delete('/api/referrals/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (isConfigured) {
    await removeData(`referrals/${code}`);
    try { await removeData(`referralUsers/${code}`); } catch {}
    return res.json({ success: true });
  }
  const referrals = await readJson(REFERRALS_FILE);
  await writeJson(REFERRALS_FILE, referrals.filter(r => (r.code || '').toUpperCase() !== code));
  res.json({ success: true });
});

app.post('/api/referrals/:code/contacted', async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (isConfigured) {
    const ref = await getData(`referrals/${code}`);
    if (ref) await updateData(`referrals/${code}`, { selected: (ref.selected || 0) + 1, lastSelectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

app.post('/api/referral-visits', async (req, res) => {
  const code = String(req.body.referralCode || '').toUpperCase();
  const visit = { id: `VIS-${Date.now()}`, ...req.body, referralCode: code, visitedAt: new Date().toISOString(), action: 'visited' };
  if (isConfigured) {
    const ref = await getData(`referrals/${code}`);
    visit.matched = !!ref;
    const refKey = await pushData('referralVisits', visit);
    if (ref) await updateData(`referrals/${code}`, { visited: (ref.visited || 0) + 1, lastVisitedAt: visit.visitedAt, updatedAt: new Date().toISOString() });
    return res.status(201).json({ success: true, data: visit });
  }
  const [referrals, visits] = await Promise.all([readJson(REFERRALS_FILE), readJson(VISITS_FILE)]);
  const matched = referrals.find(r => (r.code || '').toUpperCase() === code);
  visit.matched = !!matched;
  visits.push(visit);
  if (matched) matched.visited = (matched.visited || 0) + 1;
  await Promise.all([writeJson(VISITS_FILE, visits), writeJson(REFERRALS_FILE, referrals)]);
  res.status(201).json({ success: true, data: visit });
});

// User Profile
app.get('/api/users/:uid', async (req, res) => {
  if (isConfigured) {
    const data = await getData(`users/${req.params.uid}`);
    return res.json({ success: true, data });
  }
  res.json({ success: true, data: null });
});

app.post('/api/users/:uid', async (req, res) => {
  if (isConfigured) {
    await updateData(`users/${req.params.uid}`, { ...req.body, updatedAt: new Date().toISOString() });
    return res.json({ success: true });
  }
  res.json({ success: true });
});

// Admin Messages
app.get('/api/admin-messages', async (req, res) => {
  if (isConfigured) {
    const msgs = await getData('adminMessages');
    return res.json({ success: true, data: snapToArray(msgs) });
  }
  res.json({ success: true, data: [] });
});

app.post('/api/admin-messages', ensureAuth, async (req, res) => {
  const msg = { id: `MSG-${Date.now()}`, ...req.body, createdAt: new Date().toISOString(), createdBy: req.user.email };
  if (isConfigured) {
    await pushData('adminMessages', msg);
    return res.status(201).json({ success: true, data: msg });
  }
  res.status(201).json({ success: true, data: msg });
});

app.post('/api/admin-messages/:id/acknowledge', async (req, res) => {
  if (isConfigured) {
    await pushData(`adminMessageAcks/${req.params.id}`, { ...req.body, acknowledgedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

// Site Visits
app.post('/api/site-visits', async (req, res) => {
  if (isConfigured) {
    await pushData('siteVisits', { ...req.body, visitedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

// AI Verification
app.post('/api/ai/verify-task', async (req, res) => {
  const { taskTitle, taskDescription, taskNotices, submissionText, submissionUrl, internName, codeFiles } = req.body;
  if (!taskTitle || !submissionText) {
    return res.status(400).json({ success: false, message: 'Task title and submission text are required.' });
  }
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, message: 'NVIDIA API key not configured.' });

  try {
    const promptParts = [`Task Title: ${taskTitle}`, `Task Description: ${taskDescription || ''}`];
    if (taskNotices?.trim()) promptParts.push(`Task Instructions/Notices:\n${taskNotices}`);
    promptParts.push(`Student Name: ${internName || 'Unknown'}`, `Student's Submission Text: ${submissionText}`);
    if (submissionUrl) promptParts.push(`Submission URL: ${submissionUrl}`);
    if (codeFiles?.length) {
      promptParts.push(`\n=== ACTUAL CODE FETCHED FROM REPOSITORY ===`);
      for (const f of codeFiles) promptParts.push(`\n--- File: ${f.path || f.name || 'unknown'} ---\n${f.content}`);
      promptParts.push(`\n=== END OF CODE ===`);
    } else {
      promptParts.push(`\nIMPORTANT: No actual code could be fetched. Set verified to false.`);
    }

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'meta/llama-3.3-70b-instruct',
        messages: [{ role: 'system', content: 'You are an AI internship task verifier. Respond ONLY with JSON: { "verified": boolean, "confidence": number, "reason": "string", "message": "string" }' }, { role: 'user', content: promptParts.join('\n') }],
        temperature: 0.3, max_tokens: 600,
      }),
    });
    if (!response.ok) throw new Error(`NVIDIA API error ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { verified: false, confidence: 0, reason: 'Could not parse AI response', message: 'AI verification failed.' };
    return res.json({ success: true, data: { ...result, rawResponse: content } });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'AI verification failed: ' + e.message });
  }
});

// Quiz grading
app.post('/api/grade-quiz-text', async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ success: false });
  res.json({ success: true, correct: false, reason: 'Manual review required' });
});

// ─── User data helper (for dashboard rendering) ────────────────────────────
app.get('/api/user/profile', ensureAuth, async (req, res) => {
  if (isConfigured) {
    const data = await getData(`users/${req.user.id}`);
    return res.json({ success: true, data });
  }
  res.json({ success: true, data: null });
});

app.post('/api/user/profile', ensureAuth, async (req, res) => {
  if (isConfigured) {
    await updateData(`users/${req.user.id}`, { ...req.body, updatedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

// Ban check
app.post('/api/check-ban', async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  if (!email || !isConfigured) return res.json({ success: true, data: null });
  const all = await getData('bannedUsers');
  const bans = snapToArray(all);
  const ban = bans.find(b => b.email?.toLowerCase().trim() === email);
  res.json({ success: true, data: ban || null });
});

app.post('/api/ban-user', ensureAuth, async (req, res) => {
  const { email, banType, reason } = req.body;
  if (!email) return res.status(400).json({ success: false });
  if (isConfigured) {
    const existing = await getData('bannedUsers');
    const bans = snapToArray(existing).filter(b => b.email?.toLowerCase().trim() !== email.toLowerCase().trim());
    bans.push({ email: email.toLowerCase().trim(), banType: banType || 'both', reason: reason || '', bannedAt: new Date().toISOString() });
    await setData('bannedUsers', bans.reduce((acc, b) => { acc[b.email.replace(/\./g, ',')] = b; return acc; }, {}));
  }
  res.json({ success: true });
});

app.post('/api/unban-user', ensureAuth, async (req, res) => {
  const { email } = req.body;
  if (!email || !isConfigured) return res.json({ success: true });
  const existing = await getData('bannedUsers');
  const bans = snapToArray(existing).filter(b => b.email?.toLowerCase().trim() !== email.toLowerCase().trim());
  await setData('bannedUsers', bans.reduce((acc, b) => { acc[b.email.replace(/\./g, ',')] = b; return acc; }, {}));
  res.json({ success: true });
});

// Site visits tracking
app.post('/api/track-visit', async (req, res) => {
  if (isConfigured) {
    await pushData('siteVisits', { ...req.body, visitedAt: new Date().toISOString() });
  }
  res.json({ success: true });
});

// ─── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DEV/CRAFT server running on http://localhost:${PORT}`);
  console.log(`Firebase configured: ${isConfigured}`);
});
