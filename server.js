require('dotenv').config({ quiet: true });

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const QRCode = require('qrcode');
const Razorpay = require('razorpay');

const db = require('./db');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const SHOP_PASSWORD = process.env.SHOP_PASSWORD || '';
// Set once the shop has a permanent address. Until then the site asks search
// engines to stay away, because a tunnel URL that changes every restart would
// only ever be indexed as a dead link.
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

const UPI_ID = process.env.UPI_ID || '';
const UPI_NAME = process.env.UPI_NAME || 'Printout';

// Razorpay stays dormant until both keys are present, so the shop can run on UPI
// alone and switch the gateway on by filling in .env.
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const razorpay =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
    : null;
const RATE_BW = Number(process.env.RATE_BW || 2);
const RATE_COLOR = Number(process.env.RATE_COLOR || 10);
const MAX_MB = Number(process.env.MAX_MB || 25);
const MAX_FILES = Number(process.env.MAX_FILES || 20);
const MAX_TOTAL_MB = Number(process.env.MAX_TOTAL_MB || 80);

// What the counter can actually print, keyed by extension.
const KINDS = {
  '.pdf': { kind: 'pdf', mime: 'application/pdf', inline: true },
  '.jpg': { kind: 'image', mime: 'image/jpeg', inline: true },
  '.jpeg': { kind: 'image', mime: 'image/jpeg', inline: true },
  '.png': { kind: 'image', mime: 'image/png', inline: true },
  '.webp': { kind: 'image', mime: 'image/webp', inline: true },
  '.heic': { kind: 'image', mime: 'image/heic', inline: false },
  '.heif': { kind: 'image', mime: 'image/heif', inline: false },
  '.doc': { kind: 'word', mime: 'application/msword', inline: false },
  '.docx': {
    kind: 'word',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false,
  },
  '.ppt': { kind: 'slides', mime: 'application/vnd.ms-powerpoint', inline: false },
  '.pptx': {
    kind: 'slides',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    inline: false,
  },
};

// Phones do not always hand over a usable filename — a Word file picked out of
// Drive can arrive as `document` with only its media type to go on. Falling
// back to that type keeps those uploads working.
const BY_MIME = Object.entries(KINDS).reduce((acc, [ext, type]) => {
  if (!acc[type.mime]) acc[type.mime] = { ...type, ext };
  return acc;
}, {});

function typeOf(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (KINDS[ext]) return { ...KINDS[ext], ext };
  const byMime = BY_MIME[(file.mimetype || '').toLowerCase()];
  return byMime || null;
}

// Kinds whose page count cannot be read: Word and PowerPoint both repaginate on
// whatever machine opens them, so the counter prices these by hand.
const COUNTED_AT_COUNTER = new Set(['word', 'slides']);

// The queue holds students' files and phone numbers, so there is no default
// password to fall back on: an unconfigured shop does not start.
if (!SHOP_PASSWORD) {
  console.error(
    'Set SHOP_PASSWORD in .env before starting — the shop queue cannot be left open.'
  );
  process.exit(1);
}

const app = express();
app.use(express.json());

// Search engines: the student page is worth finding, the queue never is.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(
    SITE_URL
      ? `User-agent: *\nAllow: /$\nDisallow: /shop.html\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n'
  );
});

app.get('/sitemap.xml', (req, res) => {
  if (!SITE_URL) return res.status(404).end();
  res.type('application/xml');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc><changefreq>monthly</changefreq></url>\n</urlset>\n`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

// --- shop authentication -----------------------------------------------------
// Sessions live in memory: restarting the server logs the shop out, which is
// fine for a single-counter setup.
const sessions = new Set();

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function requireShop(req, res, next) {
  const token = readCookie(req, 'shop_session');
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Not signed in' });
}

app.post('/api/shop/login', (req, res) => {
  const password = String(req.body?.password || '');
  const expected = Buffer.from(SHOP_PASSWORD);
  const given = Buffer.from(password);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });

  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.cookie('shop_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(SITE_URL),
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post('/api/shop/logout', (req, res) => {
  const token = readCookie(req, 'shop_session');
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'shop_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/shop/session', (req, res) => {
  const token = readCookie(req, 'shop_session');
  res.json({ signedIn: Boolean(token && sessions.has(token)) });
});

// --- student uploads ---------------------------------------------------------
// Uploads land in the system temp folder just long enough to be counted and
// handed to storage. Nothing of value stays on this machine's disk, which is
// what lets the shop run on a host that wipes it.
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      const ext = typeOf(file)?.ext || '';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (typeOf(file)) return cb(null, true);
    cb(new Error(`${file.originalname} is not a PDF, photo, Word or PowerPoint file`));
  },
});

// The student's own name is the code: nothing to memorise, and the counter can
// call it out. It deliberately repeats across a student's orders, so anywhere a
// code is looked up, the most recent order wins.
function codeFromName(name) {
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 40);
}

// Multipart filenames arrive as latin1, so anything beyond plain ASCII — a
// narrow space in a screenshot name, an accent, Devanagari — turns to mojibake
// unless it is read back as UTF-8.
function cleanName(name) {
  return Buffer.from(name, 'latin1').toString('utf8').slice(0, 200);
}

// Pages per file: read out of a PDF, one per image, unknowable for Word — a .docx
// repaginates on whatever machine opens it, so the counter quotes those by hand.
async function countPages(bytes, kind) {
  if (kind === 'image') return 1;
  if (COUNTED_AT_COUNTER.has(kind)) return null;
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return pdf.getPageCount();
  } catch {
    return null; // damaged or password-locked; the shop can still open it
  }
}

app.post('/api/orders', (req, res) => {
  upload.array('files', MAX_FILES)(req, res, async (err) => {
    const files = req.files || [];
    const scratch = () =>
      Promise.all(files.map((file) => fs.promises.unlink(file.path).catch(() => {})));

    if (err) {
      await scratch();
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `One of those files is larger than ${MAX_MB} MB`
          : err.code === 'LIMIT_FILE_COUNT'
            ? `You can send up to ${MAX_FILES} files at a time`
            : err.message;
      return res.status(400).json({ error: message });
    }
    if (files.length === 0) return res.status(400).json({ error: 'Add at least one file' });

    const studentName = String(req.body.studentName || '').trim();
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    const notes = String(req.body.notes || '').trim().slice(0, 300);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

    const reject = async (message) => {
      await scratch();
      res.status(400).json({ error: message });
    };

    if (studentName.length < 2 || studentName.length > 60) return reject('Enter your name');
    if (phone && phone.length !== 10) {
      return reject('That phone number is not 10 digits — leave it blank if you would rather not');
    }
    if (totalBytes > MAX_TOTAL_MB * 1024 * 1024) {
      return reject(`That batch is over the ${MAX_TOTAL_MB} MB total limit`);
    }

    // Each file carries its own copies / ink / sides, sent as a JSON array in the
    // same order the files were appended.
    let specs;
    try {
      specs = JSON.parse(req.body.specs || '[]');
      if (!Array.isArray(specs) || specs.length !== files.length) {
        throw new Error('Print settings did not match the files sent');
      }
    } catch (parseError) {
      return reject(parseError.message);
    }

    for (const spec of specs) {
      const copies = Number.parseInt(spec?.copies, 10);
      if (!Number.isInteger(copies) || copies < 1 || copies > 50) {
        return reject('Copies must be between 1 and 50 for every file');
      }
    }

    const stored = [];
    try {
      const counted = [];
      for (const [index, file] of files.entries()) {
        const type = typeOf(file);
        const bytes = await fs.promises.readFile(file.path);
        const pages = await countPages(bytes, type.kind);
        const copies = Number.parseInt(specs[index].copies, 10);
        const color = specs[index].color === 'color';
        const duplex = specs[index].duplex === 'double';

        await storage.save(file.filename, bytes, type.mime);
        stored.push(file.filename);

        counted.push({
          file,
          kind: type.kind,
          pages,
          copies,
          color,
          duplex,
          price: pages === null ? null : pages * copies * (color ? RATE_COLOR : RATE_BW),
        });
      }

      const quoteNeeded = counted.some((item) => item.price === null);
      const price = counted.reduce((sum, item) => sum + (item.price ?? 0), 0);
      const code = codeFromName(studentName);

      await db.transaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO orders (code, student_name, phone, notes, price, quote_needed)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [code, studentName, phone || null, notes || null, price, quoteNeeded]
        );

        for (const [index, item] of counted.entries()) {
          await client.query(
            `INSERT INTO order_files
              (order_id, position, original_name, stored_name, kind, size_bytes, pages,
               copies, color, duplex, price)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              rows[0].id,
              index,
              cleanName(item.file.originalname),
              item.file.filename,
              item.kind,
              item.file.size,
              item.pages,
              item.copies,
              item.color,
              item.duplex,
              item.price,
            ]
          );
        }
      });

      res.status(201).json({
        code,
        price,
        quoteNeeded,
        files: counted.map((item) => ({
          name: cleanName(item.file.originalname),
          kind: item.kind,
          pages: item.pages,
          copies: item.copies,
          color: item.color,
          duplex: item.duplex,
          price: item.price,
        })),
      });
    } catch (saveError) {
      // An order that never made it into the database must not leave files
      // behind in storage.
      console.error('Order failed:', saveError.message);
      await Promise.all(stored.map((name) => storage.remove(name).catch(() => {})));
      res.status(500).json({ error: 'Could not save that order. Try again in a moment.' });
    } finally {
      await scratch();
    }
  });
});

const filesOfOrder = (orderId) =>
  db.all(
    `SELECT id, original_name, kind, size_bytes, pages, copies, color, duplex, price
       FROM order_files WHERE order_id = $1 ORDER BY position`,
    [orderId]
  );

// Students check their own order with the code they were given.
app.get('/api/orders/:code', async (req, res) => {
  const order = await db.one(
    `SELECT id, code, student_name, price, quote_needed, status, created_at,
            payment_status, payment_method, payment_ref, paid_amount
       FROM orders WHERE code = $1 ORDER BY id DESC LIMIT 1`,
    [String(req.params.code).toUpperCase()]
  );
  if (!order) return res.status(404).json({ error: 'No order with that code' });

  const files = await filesOfOrder(order.id);
  delete order.id;
  res.json({ ...order, files });
});

// --- payment -----------------------------------------------------------------
// UPI is a direct transfer to the shop's own ID, so nothing here can confirm a
// payment on its own: the student records the reference and the shop matches it
// against their bank app. The order code is the only thing gating these routes,
// which is why a claim is never treated as settled money.
const findOrderByCode = (code) =>
  db.one(
    `SELECT id, code, price, quote_needed, payment_status, payment_method, payment_ref,
            paid_amount, payment_order_id
       FROM orders WHERE code = $1 ORDER BY id DESC LIMIT 1`,
    [String(code).toUpperCase()]
  );

function upiLink(order) {
  const params = new URLSearchParams({
    pa: UPI_ID,
    pn: UPI_NAME,
    am: String(order.price),
    cu: 'INR',
    tn: `Print ${order.code}`,
  });
  return `upi://pay?${params}`;
}

function paymentState(order) {
  const priced = !order.quote_needed && order.price > 0;
  const payable = Boolean(UPI_ID) && priced;
  return {
    enabled: Boolean(UPI_ID) || Boolean(razorpay),
    payable,
    gateway: Boolean(razorpay) && priced,
    amount: order.price,
    status: order.payment_status,
    method: order.payment_method,
    reference: order.payment_ref,
    upiId: payable ? UPI_ID : null,
    payeeName: UPI_NAME,
    reason: order.quote_needed
      ? 'This order has a file the shop prices by hand, so pay at the counter.'
      : null,
  };
}

app.get('/api/orders/:code/payment', async (req, res) => {
  const order = await findOrderByCode(req.params.code);
  if (!order) return res.status(404).json({ error: 'No order with that code' });

  const state = paymentState(order);
  if (!state.payable) return res.json(state);

  const link = upiLink(order);
  res.json({
    ...state,
    link,
    qr: await QRCode.toDataURL(link, { margin: 1, width: 320, errorCorrectionLevel: 'M' }),
  });
});

app.post('/api/orders/:code/payment', async (req, res) => {
  const order = await findOrderByCode(req.params.code);
  if (!order) return res.status(404).json({ error: 'No order with that code' });
  if (!paymentState(order).payable) {
    return res.status(400).json({ error: 'This order is paid at the counter' });
  }
  if (order.payment_status === 'paid') {
    return res.status(409).json({ error: 'The shop has already confirmed this payment' });
  }

  // The student just tells us they have sent it. A reference is accepted if one
  // is ever supplied, but the shop confirms against their own app either way.
  const reference = String(req.body?.reference || '').replace(/\s/g, '');
  if (reference && !/^\d{9,18}$/.test(reference)) {
    return res.status(400).json({ error: 'That reference number does not look right' });
  }

  await db.query(
    `UPDATE orders
        SET payment_status = 'claimed', payment_method = 'upi', payment_ref = $1,
            paid_amount = $2, paid_at = now()
      WHERE id = $3`,
    [reference || null, order.price, order.id]
  );

  res.json({ status: 'claimed', amount: order.price });
});

// Razorpay, unlike a plain UPI transfer, comes back with proof: the browser
// returns a signature that only the key secret can produce, so a confirmed
// payment needs no human check.
app.post('/api/orders/:code/razorpay', async (req, res) => {
  if (!razorpay) return res.status(404).json({ error: 'Card payment is not switched on' });

  const order = await findOrderByCode(req.params.code);
  if (!order) return res.status(404).json({ error: 'No order with that code' });
  if (order.quote_needed || order.price <= 0) {
    return res.status(400).json({ error: 'This order is priced at the counter' });
  }
  if (order.payment_status === 'paid') {
    return res.status(409).json({ error: 'This order is already paid' });
  }

  const amount = order.price * 100; // Razorpay counts in paise
  if (amount < 100) {
    return res.status(400).json({ error: 'Orders under ₹1 are settled at the counter' });
  }

  try {
    const gatewayOrder = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: order.code,
      notes: { code: order.code },
    });

    await db.query('UPDATE orders SET payment_order_id = $1 WHERE id = $2', [
      gatewayOrder.id,
      order.id,
    ]);

    res.json({
      keyId: RAZORPAY_KEY_ID,
      orderId: gatewayOrder.id,
      amount: gatewayOrder.amount,
      name: UPI_NAME,
      description: `Print order ${order.code}`,
    });
  } catch (err) {
    console.error('Razorpay order failed:', err?.error?.description || err.message);

    // Bad or revoked keys are the shop's problem to fix, not a student's, so they
    // are worth separating from a gateway that is merely unreachable.
    const authFailed = err?.statusCode === 401;
    res.status(authFailed ? 401 : 500).json({
      error: authFailed
        ? "The shop's payment keys were rejected. Pay by UPI or at the counter."
        : 'Could not reach the payment gateway. Pay by UPI or at the counter.',
    });
  }
});

app.post('/api/orders/:code/razorpay/verify', async (req, res) => {
  if (!razorpay) return res.status(404).json({ error: 'Card payment is not switched on' });

  const order = await findOrderByCode(req.params.code);
  if (!order) return res.status(404).json({ error: 'No order with that code' });

  const gatewayOrderId = String(req.body?.razorpay_order_id || '');
  const paymentId = String(req.body?.razorpay_payment_id || '');
  const signature = String(req.body?.razorpay_signature || '');

  if (!gatewayOrderId || !paymentId || !signature) {
    return res.status(400).json({ error: 'Payment details were incomplete' });
  }

  // The signature is only meaningful against the order we ourselves created.
  if (!order.payment_order_id || gatewayOrderId !== order.payment_order_id) {
    return res.status(400).json({ error: 'That payment belongs to a different order' });
  }

  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${gatewayOrderId}|${paymentId}`)
    .digest('hex');
  const given = Buffer.from(signature);
  const mine = Buffer.from(expected);
  const ok = given.length === mine.length && crypto.timingSafeEqual(given, mine);

  if (!ok) return res.status(400).json({ error: 'Payment could not be verified' });

  await db.query(
    `UPDATE orders
        SET payment_status = 'paid', payment_method = 'razorpay', payment_ref = $1,
            paid_amount = $2, paid_at = now()
      WHERE id = $3`,
    [paymentId, order.price, order.id]
  );

  res.json({ status: 'paid', amount: order.price, reference: paymentId });
});

// --- shop queue -------------------------------------------------------------
app.get('/api/shop/orders', requireShop, async (req, res) => {
  const status = String(req.query.status || 'all');
  const allowed = ['pending', 'printed', 'collected'];

  // "prepaid" is the queue the shop can work through without the student
  // present, so it gets its own view rather than being buried in Waiting.
  const rows =
    status === 'prepaid'
      ? await db.all(
          `SELECT * FROM orders
            WHERE status = 'pending' AND payment_status IN ('paid', 'claimed')
            ORDER BY id DESC LIMIT 200`
        )
      : allowed.includes(status)
        ? await db.all('SELECT * FROM orders WHERE status = $1 ORDER BY id DESC LIMIT 200', [
            status,
          ])
        : await db.all('SELECT * FROM orders ORDER BY id DESC LIMIT 200');

  const counts = (await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')).reduce(
    (acc, row) => ({ ...acc, [row.status]: Number(row.n) }),
    {}
  );

  counts.prepaid = Number(
    (
      await db.one(
        `SELECT COUNT(*) AS n FROM orders
          WHERE status = 'pending' AND payment_status IN ('paid', 'claimed')`
      )
    ).n
  );

  // One query for every file in the list rather than one per order — the queue
  // polls every second, so a hundred round trips a second is not an option.
  const files = rows.length
    ? await db.all(
        `SELECT id, order_id, original_name, kind, size_bytes, pages, copies, color,
                duplex, price
           FROM order_files WHERE order_id = ANY($1) ORDER BY order_id, position`,
        [rows.map((order) => order.id)]
      )
    : [];

  const byOrder = new Map();
  for (const file of files) {
    const { order_id: orderId, ...rest } = file;
    if (!byOrder.has(orderId)) byOrder.set(orderId, []);
    byOrder.get(orderId).push(rest);
  }

  res.json({
    orders: rows.map((order) => ({ ...order, files: byOrder.get(order.id) || [] })),
    counts,
  });
});

app.get('/api/shop/files/:id', requireShop, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad file id' });

  const file = await db.one(
    'SELECT stored_name, original_name FROM order_files WHERE id = $1',
    [id]
  );
  if (!file) return res.status(404).json({ error: 'File not found' });

  const type = KINDS[path.extname(file.stored_name).toLowerCase()] || {
    mime: 'application/octet-stream',
    inline: false,
  };
  const safeName = file.original_name.replace(/[^\w.\- ]/g, '_');

  try {
    const bytes = await storage.read(file.stored_name);
    res.type(type.mime);
    res.setHeader(
      'Content-Disposition',
      `${type.inline ? 'inline' : 'attachment'}; filename="${safeName}"`
    );
    res.send(bytes);
  } catch (readError) {
    console.error('Could not read', file.stored_name, readError.message);
    res.status(404).json({ error: 'That file is no longer in storage' });
  }
});

// The shop has the final word on money: confirm what they can see in their bank
// app, or push it back to unpaid if the reference does not check out.
app.post('/api/shop/orders/:id/payment', requireShop, async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['unpaid', 'paid'].includes(status)) {
    return res.status(400).json({ error: 'Unknown payment status' });
  }

  const order = await db.one('SELECT id, price FROM orders WHERE id = $1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (status === 'paid') {
    await db.query(
      `UPDATE orders
          SET payment_status = 'paid', paid_amount = COALESCE(paid_amount, $1),
              paid_at = COALESCE(paid_at, now())
        WHERE id = $2`,
      [order.price, order.id]
    );
  } else {
    await db.query(
      `UPDATE orders
          SET payment_status = 'unpaid', payment_method = NULL, payment_ref = NULL,
              paid_amount = NULL, paid_at = NULL
        WHERE id = $1`,
      [order.id]
    );
  }

  res.json({ ok: true });
});

// Clearing a whole tab at once. Scoped to what the shop is actually looking at
// rather than a blanket wipe, so "delete all" means the list on screen.
const QUEUE_FILTERS = {
  pending: "status = 'pending'",
  printed: "status = 'printed'",
  collected: "status = 'collected'",
  prepaid: "status = 'pending' AND payment_status IN ('paid', 'claimed')",
  all: 'TRUE',
};

app.delete('/api/shop/orders', requireShop, async (req, res) => {
  const status = String(req.query.status || '');
  const where = QUEUE_FILTERS[status];
  if (!where) return res.status(400).json({ error: 'Unknown queue' });

  const files = await db.all(
    `SELECT stored_name FROM order_files
      WHERE order_id IN (SELECT id FROM orders WHERE ${where})`
  );
  const result = await db.query(`DELETE FROM orders WHERE ${where}`);

  await Promise.all(files.map((file) => storage.remove(file.stored_name).catch(() => {})));

  console.log(`Shop cleared ${result.rowCount} order(s) from "${status}"`);
  res.json({ ok: true, ordersRemoved: result.rowCount, filesRemoved: files.length });
});

// Housekeeping: clearing a finished job takes its files with it, so storage does
// not fill up with prints nobody will ask for again.
app.delete('/api/shop/orders/:id', requireShop, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad order id' });

  const files = await db.all('SELECT stored_name FROM order_files WHERE order_id = $1', [id]);

  // The row goes first: a file left behind is untidy, but a row pointing at a
  // file that is already gone is broken.
  const result = await db.query('DELETE FROM orders WHERE id = $1', [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found' });

  await Promise.all(files.map((file) => storage.remove(file.stored_name).catch(() => {})));

  res.json({ ok: true, filesRemoved: files.length });
});

app.post('/api/shop/orders/:id/status', requireShop, async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['pending', 'printed', 'collected'].includes(status)) {
    return res.status(400).json({ error: 'Unknown status' });
  }
  const result = await db.query('UPDATE orders SET status = $1 WHERE id = $2', [
    status,
    req.params.id,
  ]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({
    rateBw: RATE_BW,
    rateColor: RATE_COLOR,
    maxMb: MAX_MB,
    maxFiles: MAX_FILES,
    maxTotalMb: MAX_TOTAL_MB,
    accepts: Object.keys(KINDS),
    onlinePayment: Boolean(UPI_ID),
  });
});

async function start() {
  await db.init();
  await storage.ready();
  app.listen(PORT, () => {
    console.log(`Printout running on port ${PORT}`);
    console.log(`Files: ${storage.isRemote ? 'object storage' : 'local uploads folder'}`);
  });
}

start().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
