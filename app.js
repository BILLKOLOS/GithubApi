require('dotenv').config();
const express = require('express');
const axios = require('axios');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const session = require('express-session');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MongoDB Connection ────────────────────────────────────────────────────────
mongoose.connect(process.env.DATABASE_URL)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ─── Schemas ──────────────────────────────────────────────────────────────────
const appUserSchema = new mongoose.Schema({
  username:    { type: String, unique: true, required: true },
  password:    { type: String, required: true },
  googleId:    String,
  displayName: String,
  createdAt:   { type: Date, default: Date.now }
});
const AppUser = mongoose.model('AppUser', appUserSchema);

const githubCacheSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  data:     Object,
  cachedAt: { type: Date, default: Date.now, expires: 86400 }
});
const GithubCache = mongoose.model('GithubCache', githubCacheSchema);

// ─── App Setup ─────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'github-explorer-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// ─── Passport ─────────────────────────────────────────────────────────────────
passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const user = await AppUser.findOne({ username: username.toLowerCase() });
    if (!user) return done(null, false, { message: 'User not found.' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return done(null, false, { message: 'Incorrect password.' });
    return done(null, user);
  } catch (err) { return done(err); }
}));

passport.use(new GoogleStrategy({
  clientID:    process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await AppUser.findOne({ googleId: profile.id });
    if (!user) {
      const email = profile.emails?.[0]?.value || `google_${profile.id}`;
      user = await AppUser.create({
        username:    email.toLowerCase(),
        googleId:    profile.id,
        displayName: profile.displayName,
        password:    await bcrypt.hash(Math.random().toString(36) + Date.now(), 10)
      });
    }
    return done(null, user);
  } catch (err) { return done(err); }
}));

passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
  try { done(null, await AppUser.findById(id)); }
  catch (err) { done(err); }
});

function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ─── GitHub API Client ─────────────────────────────────────────────────────────
const githubAxios = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'GitHub-Contact-Explorer/2.1',
    ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` })
  },
  timeout: 15000
});

async function fetchWithConcurrency(items, fn, limit = 8) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch   = items.slice(i, i + limit);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
    if (i + limit < items.length) await new Promise(r => setTimeout(r, 120));
  }
  return results;
}

// ─── Contact Extraction ────────────────────────────────────────────────────────
function extractContacts(user) {
  const bioRaw  = user.bio     || '';
  const blog    = user.blog    || '';
  const company = user.company || '';
  const combined = `${bioRaw} ${blog} ${company}`;

  const email    = user.email || extractEmail(combined);
  const phones   = extractAllPhones(combined);
  const linkedin = extractLinkedIn(combined) || (blog.toLowerCase().includes('linkedin.com') ? normalizeUrl(blog) : null);
  const twitter  = user.twitter_username
    ? `https://twitter.com/${user.twitter_username}`
    : extractTwitterFromText(combined);
  const others   = extractOthers(blog, bioRaw, linkedin, twitter);

  return { email, phones, linkedin, twitter, others };
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// ─── Aggressive all-numbers phone parser ──────────────────────────────────────
// Returns array of { number, url, isWhatsApp }
function extractAllPhones(text) {
  const found = [];
  const seen  = new Set();

  function add(raw, isWA) {
    const cleaned = raw.replace(/[\s()\-\./]/g, '');
    if (cleaned.length < 7 || cleaned.length > 16) return;
    if (!/^\+?\d+$/.test(cleaned)) return;         // must be digits only after clean
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    const waNum = cleaned.replace(/^\+/, '');
    found.push({ number: cleaned, url: `https://wa.me/${waNum}`, isWhatsApp: isWA });
  }

  // 1. wa.me links — definite WhatsApp
  for (const m of text.matchAll(/(?:https?:\/\/)?wa\.me\/(\+?[\d\s\-]{7,16})/gi))
    add(m[1], true);

  // 2. WhatsApp label before a number
  for (const m of text.matchAll(/(?:whatsapp|whatsapp\s*me|wa)[:\s#*\-]?\s*(\+?[\d][\d\s()\-\.]{7,18})/gi))
    add(m[1], true);

  // 3. "call / reach / find me on / contact me at / phone / tel / mobile / cell / msg"
  for (const m of text.matchAll(/(?:call|text|reach|find me|contact|phone|tel(?:ephone)?|mobile|cell|msg|message|dm)\s*(?:me\s*)?(?:at|on|via|:|;)?\s*(\+?[\d][\d\s()\-\.]{7,18})/gi))
    add(m[1], false);

  // 4. Explicit phrase: "You can find me too on +254768228055"
  for (const m of text.matchAll(/(?:find me|reach me|contact me|talk to me|hit me up)[\w\s,]*(?:on|at|via)?\s*(\+?[\d][\d\s()\-\.]{8,18})/gi))
    add(m[1], false);

  // 5. International format: + followed by 1-4 digit country code + rest
  for (const m of text.matchAll(/(\+\d{1,4}[\s\-\.]?\(?\d{1,4}\)?[\s\-\.]?\d{2,5}[\s\-\.]?\d{2,5}[\s\-\.]?\d{0,5})/g)) {
    const stripped = m[1].replace(/[\s()\-\.]/g, '');
    if (stripped.length >= 9 && stripped.length <= 16) add(m[1], false);
  }

  // 6. African/common local formats: 07xx or 01xx (10 digits)
  for (const m of text.matchAll(/\b(0[17]\d{8})\b/g))
    add(m[1], false);

  // 7. Bare 10-13 digit blocks (conservative — only on their own or after space/punctuation)
  for (const m of text.matchAll(/(?<![\/\d])(\d{10,13})(?!\d)/g)) {
    const n = m[1];
    // Skip things that look like GitHub IDs or years
    if (/^20\d{2}/.test(n) || n.length > 13) continue;
    add(n, false);
  }

  return found;
}

function extractLinkedIn(text) {
  const m = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)\/?/i);
  return m ? `https://linkedin.com/in/${m[1]}` : null;
}

function extractTwitterFromText(text) {
  const m = text.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{1,20})/i);
  return m ? `https://twitter.com/${m[1]}` : null;
}

function normalizeUrl(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `https://${url}`;
}

function extractOthers(blog, bio, linkedin, twitter) {
  const others = [];
  const seen   = new Set();

  if (blog) {
    const bl = blog.toLowerCase();
    const skip = bl.includes('linkedin.com') || bl.includes('twitter.com') || bl.includes('x.com');
    if (!skip) { others.push({ label: 'Website', url: normalizeUrl(blog) }); seen.add('website'); }
  }

  const patterns = [
    { label: 'Telegram',  re: /(?:t\.me|telegram\.(?:me|org))\/([a-zA-Z0-9_]+)/i,     base: 'https://t.me/' },
    { label: 'Instagram', re: /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]+)\/?/i,  base: 'https://instagram.com/' },
    { label: 'YouTube',   re: /youtube\.com\/(?:c\/|channel\/|@)?([a-zA-Z0-9_\-]+)/i,  base: 'https://youtube.com/@' },
    { label: 'Dev.to',    re: /dev\.to\/([a-zA-Z0-9_]+)/i,                              base: 'https://dev.to/' },
    { label: 'Medium',    re: /medium\.com\/@([a-zA-Z0-9_]+)/i,                         base: 'https://medium.com/@' },
    { label: 'Hashnode',  re: /([a-zA-Z0-9\-]+)\.hashnode\.dev/i,                       base: 'https://', suffix: '.hashnode.dev' },
  ];

  for (const { label, re, base, suffix } of patterns) {
    if (seen.has(label.toLowerCase())) continue;
    const m = bio.match(re);
    if (m) {
      others.push({ label, url: suffix ? `${base}${m[1]}${suffix}` : `${base}${m[1]}` });
      seen.add(label.toLowerCase());
    }
  }
  return others;
}

// ─── Activity Helpers ──────────────────────────────────────────────────────────
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

function isActiveWithin3Months(d) {
  return d ? (Date.now() - new Date(d).getTime()) < THREE_MONTHS_MS : false;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Unknown';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  if (days < 365) return `${Math.floor(days/30)}mo ago`;
  return `${Math.floor(days/365)}y ago`;
}

// ─── Tech Stacks ──────────────────────────────────────────────────────────────
const STACKS = {
  all:          { lang: null,         label: 'All Stacks' },
  frontend:     { lang: 'javascript', label: 'Frontend (JS/TS)' },
  backend:      { lang: 'python',     label: 'Backend (Python)' },
  backend_node: { lang: 'typescript', label: 'Backend (Node/TS)' },
  mern:         { lang: 'javascript', keyword: 'MERN',         label: 'MERN Stack' },
  mean:         { lang: 'javascript', keyword: 'MEAN',         label: 'MEAN Stack' },
  fullstack:    { lang: 'javascript', keyword: 'fullstack',    label: 'Fullstack' },
  edtech:       { lang: null,         keyword: 'edtech',       label: 'EdTech' },
  mobile:       { lang: 'dart',       label: 'Mobile (Flutter)' },
  react_native: { lang: 'javascript', keyword: 'react-native', label: 'React Native' },
  devops:       { lang: 'shell',      label: 'DevOps / SRE' },
  datascience:  { lang: 'python',     keyword: 'data-science', label: 'Data Science' },
  blockchain:   { lang: 'solidity',   label: 'Blockchain / Web3' },
  java:         { lang: 'java',       label: 'Java' },
  php:          { lang: 'php',        label: 'PHP' },
  golang:       { lang: 'go',         label: 'Go / Golang' },
  ruby:         { lang: 'ruby',       label: 'Ruby / Rails' },
};

// ─── Target Personas ──────────────────────────────────────────────────────────
const PERSONAS = {
  any:          { keywords: [],                                                              label: 'Any Role' },
  developer:    { keywords: ['developer','engineer','programmer','software'],                label: '👨‍💻 Developer / Engineer' },
  investor:     { keywords: ['investor','venture capital','angel investor','fund','VC'],     label: '💰 Investor / VC / Angel' },
  teacher:      { keywords: ['teacher','educator','lecturer','tutor','instructor'],          label: '🎓 Teacher / Educator' },
  school_owner: { keywords: ['school owner','principal','headmaster','head teacher','school director'], label: '🏫 School Owner / Principal' },
  edtech:       { keywords: ['edtech','education technology','e-learning','learning platform','lms'], label: '📱 EdTech Professional' },
  simulation:   { keywords: ['simulation','virtual lab','interactive learning','VR education','3D model'], label: '🔬 Simulation Expert' },
  pilot_user:   { keywords: ['early adopter','beta tester','product tester','startup user'], label: '🚀 Pilot / Early Adopter' },
  researcher:   { keywords: ['researcher','research scientist','PhD','academic','professor'], label: '🔭 Researcher / Academic' },
  designer:     { keywords: ['designer','UI UX','product designer','graphic designer'],     label: '🎨 Designer' },
  founder:      { keywords: ['founder','CEO','co-founder','startup','entrepreneur'],        label: '🏢 Founder / CEO / Startup' },
};

// ─── Process a single GitHub profile ──────────────────────────────────────────
function processProfile(profile) {
  const contacts = extractContacts(profile);
  return {
    login:       profile.login,
    name:        profile.name || profile.login,
    avatar:      profile.avatar_url,
    url:         profile.html_url,
    bio:         profile.bio || '',
    location:    profile.location || '',
    company:     profile.company || '',
    publicRepos: profile.public_repos || 0,
    followers:   profile.followers || 0,
    updatedAt:   profile.updated_at,
    active:      isActiveWithin3Months(profile.updated_at),
    lastSeen:    formatRelativeTime(profile.updated_at),
    contacts,
    hasContacts: !!(contacts.email || contacts.phones.length || contacts.linkedin || contacts.twitter || contacts.others.length)
  };
}

async function fetchUserProfile(login) {
  try {
    const cached = await GithubCache.findOne({ username: login });
    if (cached) return cached.data;

    const res = await githubAxios.get(`/users/${login}`);
    await GithubCache.findOneAndUpdate(
      { username: login },
      { data: res.data, cachedAt: new Date() },
      { upsert: true, new: true }
    );
    return res.data;
  } catch (err) {
    if (err.response?.status !== 404) console.error(`Failed ${login}:`, err.message);
    return null;
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.render('index', { user: req.user, stacks: STACKS, personas: PERSONAS, error: null });
});

app.get('/search', async (req, res) => {
  const { q = '', location = '', stack = 'all', persona = 'any', active = 'false', batch = '50' } = req.query;

  const batchSize    = Math.min(Math.max(parseInt(batch) || 50, 5), 500);
  const filterActive = active === 'true';
  const stackConfig  = STACKS[stack]    || STACKS.all;
  const personaConf  = PERSONAS[persona] || PERSONAS.any;

  try {
    let queryParts = [];
    if (q.trim()) queryParts.push(q.trim());

    // Persona keywords — OR-joined to increase breadth
    if (personaConf.keywords.length > 0) {
      const kw = personaConf.keywords.slice(0, 3).map(k => `"${k}"`).join(' OR ');
      queryParts.push(`(${kw})`);
    }

    if (location.trim()) queryParts.push(`location:"${location.trim()}"`);
    if (stackConfig.lang) queryParts.push(`language:${stackConfig.lang}`);
    if (stackConfig.keyword) queryParts.push(stackConfig.keyword);
    if (!queryParts.length) queryParts.push('repos:>0');

    const searchQuery = queryParts.join(' ');

    // Fetch pages (max 5 pages × 100 = 500)
    const needPages = Math.ceil(batchSize / 100);
    let allItems = [];
    let totalCount = 0;

    for (let pg = 1; pg <= Math.min(needPages, 5); pg++) {
      const perPage = Math.min(100, batchSize - (pg - 1) * 100);
      if (perPage <= 0) break;

      const res = await githubAxios.get('/search/users', {
        params: { q: searchQuery, per_page: perPage, page: pg, sort: 'joined', order: 'desc' }
      });

      if (pg === 1) totalCount = res.data.total_count || 0;
      allItems.push(...(res.data.items || []));
      if ((res.data.items || []).length < perPage) break;
      if (pg < needPages) await new Promise(r => setTimeout(r, 250));
    }

    const profiles = await fetchWithConcurrency(allItems.slice(0, batchSize), item => fetchUserProfile(item.login), 8);
    let users = profiles.map(processProfile);

    if (filterActive) users = users.filter(u => u.active);

    users.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    const stats = {
      total:        users.length,
      withEmail:    users.filter(u => u.contacts.email).length,
      withPhone:    users.filter(u => u.contacts.phones.length > 0).length,
      withLinkedIn: users.filter(u => u.contacts.linkedin).length,
      active:       users.filter(u => u.active).length,
    };

    res.render('results', {
      users, query: req.query, totalCount, batchSize,
      stacks: STACKS, personas: PERSONAS,
      stackLabel: stackConfig.label, personaLabel: personaConf.label,
      stats, user: req.user,
    });

  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    let errMsg = 'Something went wrong. Please try again.';
    if (err.response?.status === 403) errMsg = 'GitHub API rate limit hit. Add GITHUB_TOKEN to .env.';
    else if (err.response?.status === 422) errMsg = 'Invalid search query. Try simpler keywords.';
    else if (err.code === 'ECONNABORTED') errMsg = 'Request timed out. Please try again.';

    res.render('index', { user: req.user, stacks: STACKS, personas: PERSONAS, error: errMsg });
  }
});

// ─── Auth ───────────────────────────────────────────────────────────────────────
app.get('/signup', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('auth', { page: 'signup', error: null });
});
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password?.trim())
    return res.render('auth', { page: 'signup', error: 'Username and password required.' });
  try {
    if (await AppUser.findOne({ username: username.toLowerCase() }))
      return res.render('auth', { page: 'signup', error: 'Username already taken.' });
    await AppUser.create({ username: username.toLowerCase(), password: await bcrypt.hash(password, 12) });
    res.redirect('/login');
  } catch { res.render('auth', { page: 'signup', error: 'Error creating account.' }); }
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('auth', { page: 'login', error: null });
});
app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.render('auth', { page: 'login', error: info?.message || 'Login failed.' });
    req.logIn(user, err => { if (err) return next(err); res.redirect('/'); });
  })(req, res, next);
});

app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/')
);

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 GitHub Contact Explorer v2.1 → http://0.0.0.0:${PORT}`));
