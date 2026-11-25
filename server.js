require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '5mb' })); // Allows article images to be saved cleanly

// Always allow Google and social crawlers
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\n');
});

// Never serve server code, package files or node_modules to the public
app.use((req, res, next) => {
  if (/^\/(server\.js|import\.js|package(-lock)?\.json|node_modules)(\/|$)/i.test(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(__dirname, {
  dotfiles: 'deny', // blocks .env, .gitignore and any other dotfile
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('ai-robot.png')) {
      res.setHeader('Content-Type', 'image/webp');
    }
  }
}));

const PAYSTACK_SECRET = (process.env.PAYSTACK_SECRET_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const EMAIL_USER = (process.env.EMAIL_USER || 'ibmtech45@gmail.com').trim();
const EMAIL_PASS = (process.env.EMAIL_PASS || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Ghana2027!').trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

// Serve index.html as the main homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Dynamic Sitemap for Google Search Console
app.get('/sitemap.xml', async (req, res) => {
  const siteUrl = `https://${req.get('host')}`;
  let urls = [
    `  <url><loc>${siteUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`
  ];

  if (supabase) {
    try {
      const { data } = await supabase
        .from('articles')
        .select('id, created_at')
        .order('created_at', { ascending: false });

      if (data) {
        for (const a of data) {
          const lastmod = a.created_at ? new Date(a.created_at).toISOString().split('T')[0] : '';
          urls.push(
            `  <url><loc>${siteUrl}/article/${a.id}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.8</priority></url>`
          );
        }
      }
    } catch (err) {
      console.error('❌ Sitemap error:', err.message);
    }
  }

  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

// ================= ARTICLES API (SUPABASE) =================

// Get all published articles
app.get('/api/articles', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase credentials are missing in environment variables.' });
  }

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('❌ Error fetching articles from Supabase:', err.message);
    res.status(500).json({ error: 'Could not load articles.' });
  }
});

// Publish a new article (Admin Password Protected)
app.post('/api/articles', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ success: false, message: 'Supabase credentials are missing in environment variables.' });
  }

  const { password, title, category, summary, content, image } = req.body;

  if (!password || password.trim() !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Incorrect admin password.' });
  }
  if (!title || !content) {
    return res.status(400).json({ success: false, message: 'Title and article content are required.' });
  }

  const newArticle = {
    title: title.trim(),
    category: (category || 'Economic Policy').trim(),
    summary: (summary || content.slice(0, 140) + '...').trim(),
    content: content.trim(),
    image: (image || 'portrait.jpg').trim(),
    date: new Date().toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
  };

  try {
    const { data, error } = await supabase
      .from('articles')
      .insert([newArticle])
      .select()
      .single();

    if (error) throw error;

    console.log(`📰 NEW ARTICLE PUBLISHED TO SUPABASE: ${data.title}`);
    res.json({ success: true, article: data });
  } catch (err) {
    console.error('❌ Error saving article to Supabase:', err.message);
    res.status(500).json({ success: false, message: 'Could not save article to database.' });
  }
});

// Delete an article (Admin Password Protected)
app.delete('/api/articles/:id', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ success: false, message: 'Supabase credentials are missing in environment variables.' });
  }

  const password = (req.headers['x-admin-password'] || '').trim();
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Incorrect admin password.' });
  }

  try {
    const { data, error } = await supabase
      .from('articles')
      .delete()
      .eq('id', req.params.id)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: 'Article not found.' });
    }

    console.log(`🗑️ ARTICLE DELETED FROM SUPABASE: ${req.params.id}`);
    res.json({ success: true, message: 'Article deleted.' });
  } catch (err) {
    console.error('❌ Error deleting article from Supabase:', err.message);
    res.status(500).json({ success: false, message: 'Could not delete article.' });
  }
});

// ================= ARTICLE SHARE PAGES (Facebook / WhatsApp thumbnails) =================

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// Serves an uploaded (base64) article image as a real image file with accurate Content-Type
app.get('/article-image/:id', async (req, res) => {
  if (!supabase) return res.status(404).end();

  const { data } = await supabase
    .from('articles')
    .select('image')
    .eq('id', req.params.id)
    .single();

  const m = data && data.image && data.image.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!m) return res.status(404).end();

  const buf = Buffer.from(m[2], 'base64');

  // Detect real image format from bytes so social crawlers never reject a mismatched header
  let mime = m[1];
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    mime = 'image/webp';
  } else if (buf[0] === 0x89 && buf[1] === 0x50) {
    mime = 'image/png';
  } else if (buf[0] === 0xFF && buf[1] === 0xD8) {
    mime = 'image/jpeg';
  }

  res.set('Content-Type', mime);
  res.set('Content-Length', buf.length);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buf);
});

// Each article gets its own link with its own preview tags
app.get('/article/:id', async (req, res) => {
  if (!supabase) return res.redirect('/');

  const { data: a } = await supabase
    .from('articles')
    .select('id, title, summary, image')
    .eq('id', req.params.id)
    .single();

  if (!a) return res.redirect('/');

  const siteUrl = `https://${req.get('host')}`;
  let image = a.image || 'portrait.jpg';
  if (image.startsWith('data:')) image = `${siteUrl}/article-image/${a.id}`;
  else if (!/^https?:\/\//i.test(image)) image = `${siteUrl}/${image.replace(/^\//, '')}`;

  const title = escapeHtml(a.title);
  const desc = escapeHtml(a.summary || '');
  const img = escapeHtml(image);
  const shareUrl = `${siteUrl}/article/${a.id}`;
  const target = `/?article=${a.id}#articles`;

  res.set('Cache-Control', 'no-cache');
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Ghana's Economic Future">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${shareUrl}">
<meta property="og:image" content="${img}">
<meta property="og:image:secure_url" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${img}">
</head><body>
<p>Opening article… <a href="${target}">Continue</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body></html>`);
});

// ================= COMMENTS API (SUPABASE) =================

const commentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 5,                 // 5 comments per IP per window
  message: { error: 'Too many comments. Please try again later.' }
});

// Load comments for one article
app.get('/api/comments/:articleId', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  const { data, error } = await supabase
    .from('comments')
    .select('id, author_name, comment_text, created_at')
    .eq('article_id', req.params.articleId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('❌ Error loading comments:', error.message);
    return res.status(500).json({ error: 'Could not load comments' });
  }
  res.json(data);
});

// Post a comment
app.post('/api/comments', commentLimiter, async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });

  const { article_id, author_name, comment_text, website } = req.body;

  // Honeypot: real users never fill this hidden field, bots do
  if (website) return res.json({ ok: true });

  const name = String(author_name || '').trim();
  const text = String(comment_text || '').trim();
  const articleId = String(article_id || '').trim();

  if (!articleId || !name || !text) {
    return res.status(400).json({ error: 'Name and comment are required.' });
  }
  if (name.length > 50 || text.length > 1000) {
    return res.status(400).json({ error: 'Name or comment is too long.' });
  }

  const { error } = await supabase
    .from('comments')
    .insert({ article_id: articleId, author_name: name, comment_text: text });

  if (error) {
    console.error('❌ Error saving comment:', error.message);
    return res.status(500).json({ error: 'Could not save comment' });
  }
  res.json({ ok: true });
});

// ================= EXISTING ROUTES =================

// 1. Quote / Partnership Request Route
app.post('/api/quote', async (req, res) => {
  try {
    const { name, phone, service, details } = req.body;
    const { error } = await supabase
      .from('submissions')
      .insert([{ name, phone, service, details }]);

    if (error) throw error;
    res.json({ success: true, message: 'Submission saved.' });
  } catch (err) {
    console.error('❌ Error saving submission:', err);
    res.status(500).json({ error: 'Failed to save submission.' });
  }
});

// 2. Initialize Paystack Payment
app.post('/api/paystack/initialize', async (req, res) => {
  const { email, amount, item } = req.body;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ status: false, message: 'Paystack key is missing in environment variables.' });
  }
  if (!email || !amount || Number(amount) <= 0) {
    return res.status(400).json({ status: false, message: 'Valid email and amount are required.' });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: Math.round(Number(amount) * 100),
        callback_url: `${baseUrl}/index.html`,
        metadata: { item: item || 'Ghana Economic Future Support' }
      })
    });

    const data = await response.json();
    if (data.status) {
      console.log(`💳 PAYMENT STARTED: ${amount} GHS by ${email}`);
    }
    res.json(data);
  } catch (error) {
    console.error('❌ Paystack Init Error:', error);
    res.status(500).json({ status: false, message: 'Could not initialize payment.' });
  }
});

// 3. Verify Paystack Payment
app.get('/api/paystack/verify/:reference', async (req, res) => {
  const { reference } = req.params;

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });

    const data = await response.json();

    if (data.status && data.data.status === 'success') {
      const paidAmount = data.data.amount / 100;
      const customerEmail = data.data.customer.email;
      console.log(`💰 PAYMENT VERIFIED: ${paidAmount} from ${customerEmail}`);

      return res.json({
        verified: true,
        amount: paidAmount,
        currency: data.data.currency,
        reference
      });
    }

    res.status(400).json({ verified: false, message: 'Payment was not successful.' });
  } catch (error) {
    console.error('❌ Paystack Verify Error:', error);
    res.status(500).json({ verified: false, message: 'Verification failed.' });
  }
});

// 4. AI Agent Route (Reads live Supabase articles + Forex + Guides visitors)
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  console.log('🤖 AI Agent request received');

  if (!GEMINI_KEY) {
    return res.status(500).json({ reply: 'AI key is missing in environment variables.' });
  }

  // Pull latest published articles from Supabase so the Agent knows your real content
  let articlesContext = 'No published articles loaded.';
  if (supabase) {
    try {
      const { data: articles } = await supabase
        .from('articles')
        .select('id, title, category, summary, date')
        .order('created_at', { ascending: false })
        .limit(15);

      if (articles && articles.length > 0) {
        articlesContext = articles
          .map(
            (a) =>
              `- "${a.title}" (${a.category || 'Policy'}, ${a.date || ''}): ${a.summary || ''} | Link: https://ghana-economic-future.onrender.com/article/${a.id}`
          )
          .join('\n');
      }
    } catch (e) {
      console.error('Agent Supabase fetch error:', e.message);
    }
  }

  // Pull cached live forex rates if available
  const forexContext =
    typeof forexCache !== 'undefined' && forexCache && forexCache.data
      ? `Live cached forex data: ${JSON.stringify(forexCache.data).slice(0, 600)}`
      : 'Live forex rates are available in the #forex section of this site.';

  const models = ['gemini-3.5-flash-lite', 'gemini-3.0-flash'];
  const payload = {
    system_instruction: {
      parts: [
        {
          text: `You are the AI Agent for "Ghana's Economic Future", an independent civic and economic information platform following Dr. Cassiel Ato Forson's economic policies, the 2027 Budget, and national development.

Your Capabilities & Rules:
1. Recommend and link directly to relevant published articles from the list below whenever a visitor asks about a topic covered on the site.
2. Answer questions using the live forex context if asked about Cedi exchange rates.
3. Guide visitors to site sections when helpful: About (#about), Forex (#forex), Articles (#articles), Join/Volunteer (#movement), and Support/Contribute via Paystack (#payForm).
4. Keep answers clear, accurate, concise, and helpful.

Published Articles on this Platform:
${articlesContext}

${forexContext}`
        }
      ]
    },
    contents: (() => {
      const normalized = (Array.isArray(history) ? history.slice(-8) : [])
        .map((m) => {
          const who = String(m.role || m.who || m.sender || m.from || '').toLowerCase();
          const role = ['model', 'bot', 'assistant', 'ai', 'agent'].includes(who) ? 'model' : 'user';
          const text = String(m.parts?.[0]?.text || m.text || m.content || m.message || '').trim();
          return { role, parts: [{ text }] };
        })
        .filter((m) => m.parts[0].text);

      const currentText = String(message || 'Hello').trim();
      normalized.push({ role: 'user', parts: [{ text: currentText }] });

      while (normalized.length && normalized[0].role !== 'user') {
        normalized.shift();
      }
      const turns = [];
      for (const item of normalized) {
        const prev = turns[turns.length - 1];
        if (prev && prev.role === item.role) {
          if (!prev.parts[0].text.includes(item.parts[0].text)) {
            prev.parts[0].text += '\n\n' + item.parts[0].text;
          }
        } else {
          turns.push(item);
        }
      }
      return turns;
    })(),
    generationConfig: { maxOutputTokens: 450, temperature: 0.7 }
  };

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_KEY
          },
          body: JSON.stringify(payload)
        }
      );

      const data = await response.json();
      if (!response.ok || data.error) {
        console.error(`❌ Chat ${model} API error:`, JSON.stringify(data.error || data));
        continue;
      }

      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) {
        return res.json({ reply });
      }
    } catch (error) {
      console.error(`❌ Chat ${model} error:`, error.message);
    }
  }

  res.status(503).json({ reply: 'Sorry, I could not respond right now. Please try again later.' });
});

// 4B. Admin Auto-SEO & Social Share Pack Generator (Password Protected)
app.post('/api/admin/seo-share', async (req, res) => {
  const { password, title, category, summary, content, articleUrl } = req.body;

  if (!password || password.trim() !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Incorrect admin password.' });
  }
  if (!GEMINI_KEY) {
    return res.status(500).json({ success: false, message: 'AI key is missing in environment variables.' });
  }
  if (!title && !content) {
    return res.status(400).json({ success: false, message: 'Enter a title or article content first.' });
  }

  const link = articleUrl || 'https://ghana-economic-future.onrender.com/#articles';
  const prompt = `You are an expert Ghanaian digital news editor and SEO strategist for "Ghana's Economic Future".
Analyze this draft article and return ONLY valid JSON (no markdown, no extra text) with these exact keys:
{
  "seoTitle": "60-char max SEO headline",
  "metaTitle": "60-char max SEO headline",
  "metaDescription": "155-char max meta description",
  "keywords": "comma-separated SEO keywords",
  "slug": "url-friendly-article-slug",
  "facebook": "Engaging Facebook post with call to action and ${link}",
  "facebookPost": "Engaging Facebook post with call to action and ${link}",
  "twitter": "Punchy X/Twitter post under 260 chars with hashtags and ${link}",
  "xPost": "Punchy X/Twitter post under 260 chars with hashtags and ${link}",
  "whatsapp": "Formatted WhatsApp broadcast summary with ${link}",
  "whatsappPost": "Formatted WhatsApp broadcast summary with ${link}"
}

Draft Title: ${title || ''}
Category: ${category || 'Economic Policy'}
Draft Summary: ${summary || ''}
Draft Content: ${(content || '').slice(0, 3500)}`;

  const models = ['gemini-3.5-flash-lite', 'gemini-3.0-flash'];

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_KEY
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2500,
              responseMimeType: 'application/json'
            }
          })
        }
      );

      const data = await response.json();
      if (!response.ok || data.error) {
        console.error(`❌ SEO ${model} API error:`, JSON.stringify(data.error || data));
        continue;
      }

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        const cleaned = rawText.replace(/```json|```/gi, '').trim();
        const seo = JSON.parse(cleaned);
        return res.json({ success: true, seo });
      }
    } catch (error) {
      console.error(`❌ SEO Generator ${model} error:`, error.message);
    }
  }

  res.status(503).json({ success: false, message: 'Could not generate SEO pack right now. Try again.' });
});

// 5. Live Forex / Currency Rate Route (All World Currencies, Cached 1 hour)
let forexCache = { data: null, updatedAt: 0 };

app.get('/api/forex', async (req, res) => {
  const now = Date.now();
  if (forexCache.data && now - forexCache.updatedAt < 60 * 60 * 1000) {
    return res.json(forexCache.data);
  }

  try {
    const response = await fetch('https://open.er-api.com/v6/latest/GHS');
    const json = await response.json();

    if (json.result !== 'success' || !json.rates) {
      throw new Error('Invalid forex response');
    }

    const toGHS = {};
    for (const [code, rate] of Object.entries(json.rates)) {
      if (rate > 0 && code !== 'GHS') {
        const val = 1 / rate;
        toGHS[code] = Number(val.toFixed(val < 0.1 ? 4 : 2));
      }
    }

    const payload = {
      updated: json.time_last_update_utc,
      toGHS
    };

    forexCache = { data: payload, updatedAt: now };
    res.json(payload);
  } catch (error) {
    console.error('❌ Forex fetch error:', error.message);
    res.status(500).json({ error: 'Could not load live exchange rates.' });
  }
});

app.listen(port, () => {
  console.log(`✅ Ghana Economic Future server is running on port ${port}`);
});