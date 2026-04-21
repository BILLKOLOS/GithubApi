# GitHub Contact Explorer v2

Find GitHub developers and extract their contact information — emails, WhatsApp numbers, LinkedIn profiles, and more.

## Features

- **Contact Extraction** — Pulls emails, WhatsApp numbers (wa.me links + phone patterns), LinkedIn, Twitter, Telegram, and other socials from GitHub profiles
- **Stack Filtering** — Filter by Frontend, Backend, MERN, MEAN, Fullstack, EdTech, Mobile, DevOps, and more
- **Location Filtering** — Filter by city or country (e.g. "Nairobi", "Kenya", "Zambia")
- **Activity Filter** — Exclude users inactive for more than 3 months
- **Batch Size** — Display 50, 100, or 200 users per search
- **Smart Ranking** — Results sorted: active users first, then by most recently active
- **MongoDB Cache** — GitHub profiles cached for 24 hours to respect rate limits
- **Auth** — Local signup/login + Google OAuth

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description |
|---|---|
| `DATABASE_URL` | MongoDB Atlas connection string |
| `GITHUB_TOKEN` | **Important!** Personal access token from [github.com/settings/tokens](https://github.com/settings/tokens). Without it: 60 req/hr. With it: 5000 req/hr. |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | Must match exactly in Google Console |
| `SESSION_SECRET` | Any long random string |

### 3. Run

```bash
# Development
npm run dev

# Production
npm start
```

---

## Google OAuth Setup

In [Google Cloud Console](https://console.cloud.google.com):

1. Go to **APIs & Services → Credentials**
2. Edit your OAuth client
3. Add to **Authorized redirect URIs**:
   - `https://githubapi-ox7c.onrender.com/auth/google/callback`

---

## Deployment on Render

1. Push to GitHub
2. Create new **Web Service** on Render
3. Set **Build Command**: `npm install`
4. Set **Start Command**: `node app.js`
5. Add all environment variables from `.env` in the Render dashboard
6. Deploy

---

## Notes on Rate Limits

GitHub's unauthenticated API allows **60 requests/hour**. Searching 50 users requires ~51 requests (1 search + 50 profiles). Without a token, you can only search small batches.

**Get a token:** [github.com/settings/tokens](https://github.com/settings/tokens) → Generate new token (classic) → No scopes needed for public data → Add to `.env` as `GITHUB_TOKEN`.

With a token you get **5,000 requests/hour** — enough for multiple 200-user searches.
