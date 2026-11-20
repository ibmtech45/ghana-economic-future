require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '5mb' })); // Allows article images to be saved cleanly
app.use(express.static(__dirname));

const PAYSTACK_SECRET = (process.env.PAYSTACK_SECRET_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const EMAIL_USER = (process.env.EMAIL_USER || 'ibmtech45@gmail.com').trim();
const EMAIL_PASS = (process.env.EMAIL_PASS || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'Ghana2027!').trim();

const ARTICLES_FILE = path.join(__dirname, 'articles.json');

// Helper functions to read and write articles.json
function readArticles() {
  if (!fs.existsSync(ARTICLES_FILE)) {
    fs.writeFileSync(ARTICLES_FILE, '[]', 'utf8');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf8'));
  } catch (err) {
    console.error('❌ Error reading articles.json:', err.message);
    return [];
  }
}

function writeArticles(articles) {
  fs.writeFileSync(ARTICLES_FILE, JSON.stringify(articles, null, 2), 'utf8');
}

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

// ================= ARTICLES API =================

// Get all published articles
app.get('/api/articles', (req, res) => {
  const articles = readArticles();
  res.json(articles);
});

// Publish a new article (Admin Password Protected)
app.post('/api/articles', (req, res) => {
  const { password, title, category, summary, content, image } = req.body;

  if (!password || password.trim() !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Incorrect admin password.' });
  }
  if (!title || !content) {
    return res.status(400).json({ success: false, message: 'Title and article content are required.' });
  }

  const articles = readArticles();
  const newArticle = {
    id: Date.now().toString(),
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

  articles.unshift(newArticle); // Put newest article at the top
  writeArticles(articles);

  console.log(`📰 NEW ARTICLE PUBLISHED: ${newArticle.title}`);
  res.json({ success: true, article: newArticle });
});

// Delete an article (Admin Password Protected)
app.delete('/api/articles/:id', (req, res) => {
  const password = (req.headers['x-admin-password'] || '').trim();
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Incorrect admin password.' });
  }

  const articles = readArticles();
  const filtered = articles.filter((a) => a.id !== req.params.id);

  if (filtered.length === articles.length) {
    return res.status(404).json({ success: false, message: 'Article not found.' });
  }

  writeArticles(filtered);
  console.log(`🗑️ ARTICLE DELETED: ${req.params.id}`);
  res.json({ success: true, message: 'Article deleted.' });
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

app.listen(port, () => {
  console.log(`✅ Ghana Economic Future server is running on port ${port}`);
});