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
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  googleId: String,
  displayName: String,
  createdAt: { type: Date, default: Date.now }
});
const AppUser = mongoose.model('AppUser', appUserSchema);

// Cache GitHub profiles for 24 hours to avoid rate limits
const githubCacheSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  data: Object,
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
  secret: process.env.SESSION_SECRET || 'github-explorer-dev-secret',
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
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await AppUser.findOne({ googleId: profile.id });
    if (!user) {
      const email = profile.emails?.[0]?.value || `google_${profile.id}`;
      user = await AppUser.create({
        username: email.toLowerCase(),
        googleId: profile.id,
        displayName: profile.displayName,
        password: await bcrypt.hash(Math.random().toString(36) + Date.now(), 10)
      });
    }
    return done(null, user);
  } catch (err) { return done(err); }
}));

passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await AppUser.findById(id);
    done(null, user);
  } catch (err) { done(err); }
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
    'User-Agent': 'GitHub-Contact-Explorer/2.0',
    ...(process.env.GITHUB_TOKEN && {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
    })
  },
  timeout: 15000
});

// Concurrency-limited batch fetcher
async function fetchWithConcurrency(items, fn, limit = 8) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
    }
    // Small delay between batches to be kind to the API
    if (i + limit < items.length) await new Promise(r => setTimeout(r, 120));
  }
  return results;
}

// ─── Contact Extraction ────────────────────────────────────────────────────────
function extractContacts(user) {
  const bioRaw = user.bio || '';
  const blog = user.blog || '';
  const company = user.company || '';
  const combined = `${bioRaw} ${blog} ${company}`;

  const email = user.email || extractEmail(combined);
  const whatsapp = extractWhatsApp(combined);
  const linkedin = extractLinkedIn(combined) || (blog.toLowerCase().includes('linkedin.com') ? normalizeUrl(blog) : null);
  const twitter = user.twitter_username
    ? `https://twitter.com/${user.twitter_username}`
    : extractTwitterFromText(combined);
  const others = extractOthers(blog, bioRaw, linkedin, twitter);

  return { email, whatsapp, linkedin, twitter, others };
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractWhatsApp(text) {
  // Priority 1: explicit wa.me link
  const waMe = text.match(/(?:https?:\/\/)?wa\.me\/(\+?[\d]{7,15})/i);
  if (waMe) {
    const num = waMe[1].replace(/\+/, '');
    return { number: waMe[1], url: `https://wa.me/${num}`, source: 'wa.me' };
  }

  // Priority 2: "WhatsApp" / "WA:" label next to a number
  const waLabel = text.match(/(?:whatsapp|wa)[:\s#*]+(\+?[\d\s()\-]{9,16})/i);
  if (waLabel) {
    const raw = waLabel[1].replace(/[\s()\-]/g, '');
    if (raw.length >= 9) {
      const num = raw.replace(/^\+/, '');
      return { number: raw, url: `https://wa.me/${num}`, source: 'label' };
    }
  }

  // Priority 3: International African/global phone format (+254, +255, +256, +27, +234 etc.)
  const intl = text.match(/(\+(?:254|255|256|260|263|27|234|233|221|44|91|1)\d{8,12})/);
  if (intl) {
    const num = intl[1].replace(/^\+/, '');
    return { number: intl[1], url: `https://wa.me/${num}`, source: 'intl' };
  }

  return null;
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
  const seen = new Set();

  // Website / blog
  if (blog) {
    const blogNorm = blog.toLowerCase();
    const isLinkedIn = blogNorm.includes('linkedin.com');
    const isTwitter = blogNorm.includes('twitter.com') || blogNorm.includes('x.com');
    if (!isLinkedIn && !isTwitter) {
      others.push({ label: 'Website', url: normalizeUrl(blog) });
      seen.add('website');
    }
  }

  // Social media in bio
  const patterns = [
    { label: 'Telegram',  re: /(?:t\.me|telegram\.(?:me|org))\/([a-zA-Z0-9_]+)/i,    base: 'https://t.me/' },
    { label: 'Instagram', re: /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]+)\/?/i, base: 'https://instagram.com/' },
    { label: 'YouTube',   re: /youtube\.com\/(?:c\/|channel\/|@)?([a-zA-Z0-9_\-]+)/i,  base: 'https://youtube.com/@' },
    { label: 'Dev.to',    re: /dev\.to\/([a-zA-Z0-9_]+)/i,                             base: 'https://dev.to/' },
    { label: 'Medium',    re: /medium\.com\/@([a-zA-Z0-9_]+)/i,                        base: 'https://medium.com/@' },
    { label: 'Hashnode',  re: /([a-zA-Z0-9\-]+)\.hashnode\.dev/i,                      base: 'https://', suffix: '.hashnode.dev' },
  ];

  for (const { label, re, base, suffix } of patterns) {
    if (seen.has(label.toLowerCase())) continue;
    const m = bio.match(re);
    if (m) {
      const url = suffix ? `${base}${m[1]}${suffix}` : `${base}${m[1]}`;
      others.push({ label, url });
      seen.add(label.toLowerCase());
    }
  }

  return others;
}

// ─── Activity Helpers ──────────────────────────────────────────────────────────
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

function isActiveWithin3Months(updatedAt) {
  if (!updatedAt) return false;
  return (Date.now() - new Date(updatedAt).getTime()) < THREE_MONTHS_MS;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

// ─── Stack → GitHub Search Mapping ────────────────────────────────────────────
const STACKS = {
  all:          { lang: null,         label: 'All Stacks' },
  frontend:     { lang: 'javascript', label: 'Frontend (JS/TS/CSS)' },
  backend:      { lang: 'python',     label: 'Backend (Python)' },
  backend_node: { lang: 'typescript', label: 'Backend (Node/TS)' },
  mern:         { lang: 'javascript', label: 'MERN Stack' },
  mean:         { lang: 'javascript', label: 'MEAN Stack' },
  fullstack:    { lang: 'javascript', label: 'Fullstack' },
  edtech:       { lang: null,         keyword: 'edtech', label: 'EdTech' },
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

// ─── Process a single GitHub profile ──────────────────────────────────────────
function processProfile(profile) {
  const contacts = extractContacts(profile);
  return {
    login: profile.login,
    name: profile.name || profile.login,
    avatar: profile.avatar_url,
    url: profile.html_url,
    bio: profile.bio || '',
    location: profile.location || '',
    company: profile.company || '',
    publicRepos: profile.public_repos || 0,
    followers: profile.followers || 0,
    updatedAt: profile.updated_at,
    createdAt: profile.created_at,
    active: isActiveWithin3Months(profile.updated_at),
    lastSeen: formatRelativeTime(profile.updated_at),
    contacts,
    hasContacts: !!(contacts.email || contacts.whatsapp || contacts.linkedin || contacts.twitter || contacts.others.length)
  };
}

// ─── Fetch and cache a single user profile ─────────────────────────────────────
async function fetchUserProfile(login) {
  try {
    const cached = await GithubCache.findOne({ username: login });
    if (cached) return cached.data;

    const res = await githubAxios.get(`/users/${login}`);
    const profile = res.data;

    await GithubCache.findOneAndUpdate(
      { username: login },
      { data: profile, cachedAt: new Date() },
      { upsert: true, new: true }
    );
    return profile;
  } catch (err) {
    if (err.response?.status !== 404) console.error(`Failed to fetch ${login}:`, err.message);
    return null;
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.render('index', { user: req.user, stacks: STACKS, error: null });
});

// Main search
app.get('/search', async (req, res) => {
  const {
    q = '',
    location = '',
    stack = 'all',
    active = 'false',
    batch = '50',
  } = req.query;

  const batchSize = Math.min(Math.max(parseInt(batch) || 50, 10), 200);
  const filterActive = active === 'true';
  const stackConfig = STACKS[stack] || STACKS.all;

  try {
    // Build search query string
    let queryParts = [];
    if (q.trim()) queryParts.push(q.trim());
    if (location.trim()) queryParts.push(`location:"${location.trim()}"`);
    if (stackConfig.lang) queryParts.push(`language:${stackConfig.lang}`);
    if (stackConfig.keyword) queryParts.push(stackConfig.keyword);
    if (queryParts.length === 0) queryParts.push('type:user repos:>0');

    const searchQuery = queryParts.join(' ');

    // Determine how many pages to fetch
    const needPages = batchSize > 100 ? 2 : 1;
    let allSearchItems = [];

    for (let pg = 1; pg <= needPages; pg++) {
      const perPage = pg === 1 ? Math.min(batchSize, 100) : batchSize - 100;
      if (perPage <= 0) break;

      const searchRes = await githubAxios.get('/search/users', {
        params: { q: searchQuery, per_page: perPage, page: pg, sort: 'joined', order: 'desc' }
      });
      allSearchItems.push(...(searchRes.data.items || []));

      if (pg === 1) {
        // Store total count from first page
        req._totalCount = searchRes.data.total_count || 0;
      }

      // If we got fewer results than requested, no point fetching next page
      if ((searchRes.data.items || []).length < perPage) break;
    }

    const totalCount = req._totalCount || allSearchItems.length;

    // Fetch full profiles in parallel (concurrency-limited)
    const profiles = await fetchWithConcurrency(
      allSearchItems.slice(0, batchSize),
      (item) => fetchUserProfile(item.login),
      8
    );

    // Process and sort
    let users = profiles.map(processProfile);

    if (filterActive) {
      users = users.filter(u => u.active);
    }

    // Sort: active users first, then by most recently updated
    users.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    // Stats
    const stats = {
      total: users.length,
      withEmail: users.filter(u => u.contacts.email).length,
      withWhatsApp: users.filter(u => u.contacts.whatsapp).length,
      withLinkedIn: users.filter(u => u.contacts.linkedin).length,
      active: users.filter(u => u.active).length,
    };

    res.render('results', {
      users,
      query: req.query,
      totalCount,
      batchSize,
      stacks: STACKS,
      stackLabel: stackConfig.label,
      stats,
      user: req.user,
    });

  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);

    let errMsg = 'Something went wrong. Please try again.';
    if (err.response?.status === 403) {
      errMsg = 'GitHub API rate limit reached. Add a GITHUB_TOKEN to your .env to get 5000 requests/hour.';
    } else if (err.response?.status === 422) {
      errMsg = 'Invalid search query. Try different keywords or filters.';
    } else if (err.code === 'ECONNABORTED') {
      errMsg = 'Request timed out. GitHub may be slow — please try again.';
    }

    res.render('index', { user: req.user, stacks: STACKS, error: errMsg });
  }
});

// ─── Auth Routes ────────────────────────────────────────────────────────────────

app.get('/signup', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('auth', { page: 'signup', error: null });
});

app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password?.trim()) {
    return res.render('auth', { page: 'signup', error: 'Username and password are required.' });
  }
  try {
    const existing = await AppUser.findOne({ username: username.toLowerCase() });
    if (existing) return res.render('auth', { page: 'signup', error: 'Username already taken.' });
    const hashed = await bcrypt.hash(password, 12);
    await AppUser.create({ username: username.toLowerCase(), password: hashed });
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('auth', { page: 'signup', error: 'Error creating account. Please try again.' });
  }
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('auth', { page: 'login', error: null });
});

app.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.render('auth', { page: 'login', error: info?.message || 'Login failed.' });
    req.logIn(user, (err) => {
      if (err) return next(err);
      res.redirect('/');
    });
  })(req, res, next);
});

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/')
);

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GitHub Contact Explorer running at http://0.0.0.0:${PORT}`);
});
