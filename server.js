require('dotenv').config({ quiet: true });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const { PDFDocument } = require('pdf-lib');
const QRCode = require('qrcode');
const Razorpay = require('razorpay');

const PORT = process.env.PORT || 3000;
const SHOP_PASSWORD = process.env.SHOP_PASSWORD || '';
const UPI_ID = process.env.UPI_ID || '';
const UPI_NAME = process.env.UPI_NAME || 'Campus Print Shop';

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
};

// The queue holds students' files and phone numbers, so there is no default
// password to fall back on: an unconfigured shop does not start.
if (!SHOP_PASSWORD) {
  console.error(
    'Set SHOP_PASSWORD in .env before starting — the shop queue cannot be left open.'
  );
  process.exit(1);
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(__dirname, 'printshop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    notes TEXT,
    price INTEGER,
    quote_needed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    pages INTEGER,
    copies INTEGER NOT NULL DEFAULT 1,
    color INTEGER NOT NULL DEFAULT 0,
    duplex INTEGER NOT NULL DEFAULT 0,
    price INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id DESC);
  CREATE INDEX IF NOT EXISTS idx_files_order ON order_files(order_id, position);
`);

// --- schema migrations ------------------------------------------------------
// Each step is skipped once its shape is already in place, so restarts are safe.
const columnsOf = (table) =>
  db
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((column) => column.name);

// 1. Orders used to hold a single file inline. Move those into order_files.
if (columnsOf('orders').includes('stored_name')) {
  const addQuoteColumn = columnsOf('orders').includes('quote_needed')
    ? ''
    : 'ALTER TABLE orders ADD COLUMN quote_needed INTEGER NOT NULL DEFAULT 0;';
  db.exec(`
    BEGIN;
    INSERT INTO order_files (order_id, position, original_name, stored_name, kind, size_bytes, pages)
      SELECT id, 0, original_name, stored_name, 'pdf', size_bytes, pages FROM orders;
    ${addQuoteColumn}
    ALTER TABLE orders DROP COLUMN original_name;
    ALTER TABLE orders DROP COLUMN stored_name;
    ALTER TABLE orders DROP COLUMN size_bytes;
    ALTER TABLE orders DROP COLUMN pages;
    COMMIT;
  `);
  console.log('Moved single-file orders into order_files.');
}

// 2. Copies, ink, and sides were once per order; they belong to each file.
const fileColumns = columnsOf('order_files');
const missing = [
  ['copies', 'INTEGER NOT NULL DEFAULT 1'],
  ['color', 'INTEGER NOT NULL DEFAULT 0'],
  ['duplex', 'INTEGER NOT NULL DEFAULT 0'],
  ['price', 'INTEGER'],
].filter(([name]) => !fileColumns.includes(name));

for (const [name, type] of missing) {
  db.exec(`ALTER TABLE order_files ADD COLUMN ${name} ${type}`);
}

// 3. Payment lives on the order: unpaid → claimed (student says they sent it) → paid
//    (shop matched it in their bank app).
const paymentColumns = [
  ['payment_status', "TEXT NOT NULL DEFAULT 'unpaid'"],
  ['payment_method', 'TEXT'],
  ['payment_ref', 'TEXT'],
  ['paid_amount', 'INTEGER'],
  ['paid_at', 'TEXT'],
  ['payment_order_id', 'TEXT'],
].filter(([name]) => !columnsOf('orders').includes(name));

for (const [name, type] of paymentColumns) {
  db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
}

if (columnsOf('orders').includes('copies')) {
  db.exec(`
    BEGIN;
    UPDATE order_files SET
      copies = (SELECT copies FROM orders WHERE orders.id = order_files.order_id),
      color  = (SELECT color  FROM orders WHERE orders.id = order_files.order_id),
      duplex = (SELECT duplex FROM orders WHERE orders.id = order_files.order_id);
    UPDATE order_files SET
      price = pages * copies * (CASE WHEN color = 1 THEN ${RATE_COLOR} ELSE ${RATE_BW} END)
      WHERE pages IS NOT NULL;
    ALTER TABLE orders DROP COLUMN copies;
    ALTER TABLE orders DROP COLUMN color;
    ALTER TABLE orders DROP COLUMN duplex;
    COMMIT;
  `);
  console.log('Moved print settings from orders onto each file.');
}

const app = express();
app.use(express.json());
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
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (KINDS[ext]) return cb(null, true);
    cb(new Error(`${file.originalname} is not a PDF, image, or Word file`));
  },
});

function newOrderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  const exists = db.prepare('SELECT 1 FROM orders WHERE code = ?');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < 5; i += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!exists.get(code)) return code;
  }
  throw new Error('Could not allocate an order code');
}

// Pages per file: read out of a PDF, one per image, unknowable for Word — a .docx
// repaginates on whatever machine opens it, so the counter quotes those by hand.
async function countPages(filePath, kind) {
  if (kind === 'image') return 1;
  if (kind === 'word') return null;
  try {
    const bytes = await fs.promises.readFile(filePath);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return pdf.getPageCount();
  } catch {
    return null; // damaged or password-locked; the shop can still open it
  }
}

app.post('/api/orders', (req, res) => {
  upload.array('files', MAX_FILES)(req, res, async (err) => {
    const files = req.files || [];
    const cleanup = () =>
      Promise.all(files.map((file) => fs.promises.unlink(file.path).catch(() => {})));

    if (err) {
      await cleanup();
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
      await cleanup();
      res.status(400).json({ error: message });
    };

    if (studentName.length < 2 || studentName.length > 60) return reject('Enter your name');
    if (phone.length !== 10) return reject('Enter a 10-digit phone number');
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

    const counted = [];
    for (const [index, file] of files.entries()) {
      const kind = KINDS[path.extname(file.originalname).toLowerCase()].kind;
      const pages = await countPages(file.path, kind);
      const copies = Number.parseInt(specs[index].copies, 10);
      const color = specs[index].color === 'color';
      const duplex = specs[index].duplex === 'double';
      counted.push({
        file,
        kind,
        pages,
        copies,
        color,
        duplex,
        price: pages === null ? null : pages * copies * (color ? RATE_COLOR : RATE_BW),
      });
    }

    const quoteNeeded = counted.some((item) => item.price === null);
    const price = counted.reduce((sum, item) => sum + (item.price ?? 0), 0);
    const code = newOrderCode();

    const save = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO orders (code, student_name, phone, notes, price, quote_needed)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(code, studentName, phone, notes || null, price, quoteNeeded ? 1 : 0);

      const insertFile = db.prepare(
        `INSERT INTO order_files
          (order_id, position, original_name, stored_name, kind, size_bytes, pages,
           copies, color, duplex, price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      counted.forEach((item, index) => {
        insertFile.run(
          lastInsertRowid,
          index,
          item.file.originalname.slice(0, 200),
          item.file.filename,
          item.kind,
          item.file.size,
          item.pages,
          item.copies,
          item.color ? 1 : 0,
          item.duplex ? 1 : 0,
          item.price
        );
      });
    });

    save();

    res.status(201).json({
      code,
      price,
      quoteNeeded,
      files: counted.map((item) => ({
        name: item.file.originalname,
        kind: item.kind,
        pages: item.pages,
        copies: item.copies,
        color: item.color,
        duplex: item.duplex,
        price: item.price,
      })),
    });
  });
});

const filesOfOrder = db.prepare(
  `SELECT id, original_name, kind, size_bytes, pages, copies, color, duplex, price
     FROM order_files WHERE order_id = ? ORDER BY position`
);

// Students check their own order with the code they were given.
app.get('/api/orders/:code', (req, res) => {
  const order = db
    .prepare(
      `SELECT id, code, student_name, price, quote_needed, status, created_at,
              payment_status, payment_method, payment_ref, paid_amount
         FROM orders WHERE code = ?`
    )
    .get(String(req.params.code).toUpperCase());
  if (!order) return res.status(404).json({ error: 'No order with that code' });

  const files = filesOfOrder.all(order.id);
  delete order.id;
  res.json({ ...order, files });
});

// --- payment -----------------------------------------------------------------
// UPI is a direct transfer to the shop's own ID, so nothing here can confirm a
// payment on its own: the student records the reference and the shop matches it
// against their bank app. The order code is the only thing gating these routes,
// which is why a claim is never treated as settled money.
const findOrderByCode = db.prepare(
  `SELECT id, code, price, quote_needed, payment_status, payment_method, payment_ref,
          paid_amount, payment_order_id
     FROM orders WHERE code = ?`
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
  const order = findOrderByCode.get(String(req.params.code).toUpperCase());
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

app.post('/api/orders/:code/payment', (req, res) => {
  const order = findOrderByCode.get(String(req.params.code).toUpperCase());
  if (!order) return res.status(404).json({ error: 'No order with that code' });
  if (!paymentState(order).payable) {
    return res.status(400).json({ error: 'This order is paid at the counter' });
  }
  if (order.payment_status === 'paid') {
    return res.status(409).json({ error: 'The shop has already confirmed this payment' });
  }

  const reference = String(req.body?.reference || '').replace(/\s/g, '');
  if (!/^\d{9,18}$/.test(reference)) {
    return res.status(400).json({
      error: 'Enter the reference or UTR number from your payment app — digits only',
    });
  }

  db.prepare(
    `UPDATE orders
        SET payment_status = 'claimed', payment_method = 'upi', payment_ref = ?,
            paid_amount = ?, paid_at = datetime('now')
      WHERE id = ?`
  ).run(reference, order.price, order.id);

  res.json({ status: 'claimed', amount: order.price });
});

// Razorpay, unlike a plain UPI transfer, comes back with proof: the browser
// returns a signature that only the key secret can produce, so a confirmed
// payment needs no human check.
app.post('/api/orders/:code/razorpay', async (req, res) => {
  if (!razorpay) return res.status(404).json({ error: 'Card payment is not switched on' });

  const order = findOrderByCode.get(String(req.params.code).toUpperCase());
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

    db.prepare('UPDATE orders SET payment_order_id = ? WHERE id = ?').run(
      gatewayOrder.id,
      order.id
    );

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
        ? 'The shop\'s payment keys were rejected. Pay by UPI or at the counter.'
        : 'Could not reach the payment gateway. Pay by UPI or at the counter.',
    });
  }
});

app.post('/api/orders/:code/razorpay/verify', (req, res) => {
  if (!razorpay) return res.status(404).json({ error: 'Card payment is not switched on' });

  const order = findOrderByCode.get(String(req.params.code).toUpperCase());
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

  db.prepare(
    `UPDATE orders
        SET payment_status = 'paid', payment_method = 'razorpay', payment_ref = ?,
            paid_amount = ?, paid_at = datetime('now')
      WHERE id = ?`
  ).run(paymentId, order.price, order.id);

  res.json({ status: 'paid', amount: order.price, reference: paymentId });
});

// --- shop queue -------------------------------------------------------------
app.get('/api/shop/orders', requireShop, (req, res) => {
  const status = String(req.query.status || 'all');
  const allowed = ['pending', 'printed', 'collected'];

  // "prepaid" is the queue the shop can work through without the student
  // present, so it gets its own view rather than being buried in Waiting.
  const rows =
    status === 'prepaid'
      ? db
          .prepare(
            `SELECT * FROM orders
              WHERE status = 'pending' AND payment_status IN ('paid', 'claimed')
              ORDER BY id DESC LIMIT 200`
          )
          .all()
      : allowed.includes(status)
        ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 200').all(status)
        : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all();

  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status')
    .all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {});

  counts.prepaid = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE status = 'pending' AND payment_status IN ('paid', 'claimed')`
    )
    .get().n;

  res.json({
    orders: rows.map((order) => ({ ...order, files: filesOfOrder.all(order.id) })),
    counts,
  });
});

app.get('/api/shop/files/:id', requireShop, (req, res) => {
  const file = db
    .prepare('SELECT stored_name, original_name FROM order_files WHERE id = ?')
    .get(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const type = KINDS[path.extname(file.stored_name).toLowerCase()] || {
    mime: 'application/octet-stream',
    inline: false,
  };
  const safeName = file.original_name.replace(/[^\w.\- ]/g, '_');
  res.type(type.mime);
  res.setHeader(
    'Content-Disposition',
    `${type.inline ? 'inline' : 'attachment'}; filename="${safeName}"`
  );
  res.sendFile(path.join(UPLOAD_DIR, file.stored_name));
});

// The shop has the final word on money: confirm what they can see in their bank
// app, or push it back to unpaid if the reference does not check out.
app.post('/api/shop/orders/:id/payment', requireShop, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['unpaid', 'paid'].includes(status)) {
    return res.status(400).json({ error: 'Unknown payment status' });
  }

  const order = db.prepare('SELECT id, price FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (status === 'paid') {
    db.prepare(
      `UPDATE orders
          SET payment_status = 'paid', paid_amount = COALESCE(paid_amount, ?),
              paid_at = COALESCE(paid_at, datetime('now'))
        WHERE id = ?`
    ).run(order.price, order.id);
  } else {
    db.prepare(
      `UPDATE orders
          SET payment_status = 'unpaid', payment_method = NULL, payment_ref = NULL,
              paid_amount = NULL, paid_at = NULL
        WHERE id = ?`
    ).run(order.id);
  }

  res.json({ ok: true });
});

app.post('/api/shop/orders/:id/status', requireShop, (req, res) => {
  const status = String(req.body?.status || '');
  if (!['pending', 'printed', 'collected'].includes(status)) {
    return res.status(400).json({ error: 'Unknown status' });
  }
  const result = db
    .prepare('UPDATE orders SET status = ? WHERE id = ?')
    .run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
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

app.listen(PORT, () => {
  console.log(`Print shop running at http://localhost:${PORT}`);
  console.log(`Shop dashboard at http://localhost:${PORT}/shop.html`);
});
