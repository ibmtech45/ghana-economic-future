// ================= ARTICLE SHARE PAGES (Facebook / WhatsApp thumbnails) =================

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
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

  // Detect real image format from bytes so Facebook never rejects a mismatched header
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