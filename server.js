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

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// Serves an uploaded (base64) article image as a real image file
app.get('/article-image/:id', async (req, res) => {
  if (!supabase) return res.status(404).end();

  const { data } = await supabase
    .from('articles')
    .select('image')
    .eq('id', req.params.id)
    .single();

  const m = data && data.image && data.image.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!m) return res.status(404).end();

  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(m[2], 'base64'));
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

  const siteUrl = `${req.protocol}://${req.get('host')}`;
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
app.post('/api/quote', (req, res) => {
  const { name, phone, service, details } = req.body;
  console.log('🚨 NEW LEAD / QUOTE REQUEST:', name);

  const mailOptions = {
    from: EMAIL_USER,
    to: EMAIL_USER,
    subject: `New GEF Lead: ${service || 'Partnership'} - ${name}`,
    text: `Name/Org: ${name}\nContact: ${phone}\nDetails: ${details}`
  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) {
      console.error('❌ Error sending email:', error);
      return res.status(500).json({ message: 'Error sending email alert.' });
    }
    console.log('✅ Quote email alert sent!');
    res.json({ message: 'Success! Your request was received.' });
  });
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

// 4. AI Chat Assistant Route
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  console.log('💬 AI Chat request received');

  if (!GEMINI_KEY) {
    return res.status(500).json({ reply: 'AI key is missing in environment variables.' });
  }

  const models = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];
  const payload = {
    system_instruction: {
      parts: [{
        text: `You are the civic and economic information assistant for "Ghana’s Economic Future", a platform following the policies, budgets, and leadership of Dr. Cassiel Ato Forson (Minister for Finance, Ghana).
Rules:
- Answer questions accurately based on the platform's focus on transparency, economic growth, and the 2027 Budget / New Economy plan.
- Keep answers concise, helpful, and professional.`
      }]
    },
    contents: history && history.length > 0 ? history.slice(-8) : [{ role: 'user', parts: [{ text: message || 'Hello' }] }],
    generationConfig: { maxOutputTokens: 150, temperature: 0.7 }
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
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (reply) {
        return res.json({ reply });
      }
    } catch (error) {
      console.error(`❌ ${model} error:`, error.message);
    }
  }

  res.status(503).json({ reply: 'Sorry, I could not respond right now. Please try again later.' });
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