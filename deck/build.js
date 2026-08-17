const path = require('path');
const PptxGenJS = require('pptxgenjs');

/* ===========================================================================
   EDIT HERE — everything below this block is layout, not words.
   Change the text, run `npm run deck`, and both the .pptx and .pdf rebuild.
   =========================================================================== */
const TEXT = {
  shopName: 'PRINTOUT',
  tagline: 'Students send their files from their phone. You print them.',
  siteUrl: 'printout-w5pr.onrender.com',
  queueUrl: 'printout-w5pr.onrender.com/shop.html',
  contact: 'Questions? Ask Farhan.',

  rateBw: 2,
  rateColour: 10,

  problems: [
    'Students queue up holding a pen drive, waiting for a free machine',
    'Files come over WhatsApp and get lost among other chats',
    'You ask every student: how many copies? colour? both sides?',
    'Mistakes mean reprinting — your paper and your toner',
    'Everyone arrives at the same time between classes',
  ],

  promise: 'Printout takes all of that off the counter and puts it on the student’s phone.',

  steps: [
    ['Student scans your QR poster', 'It opens the website on their phone.'],
    ['They add files and choose settings', 'Copies, colour or B&W, one side or both — per file.'],
    ['The job appears on your screen', 'Instantly, with everything already decided.'],
    ['You print and they collect', 'They give their name at the counter.'],
  ],

  queueNotes: [
    'Opens on a computer or your phone',
    'Needs your password — students cannot see it',
    'New orders appear on their own, every second',
    'Nothing to install',
  ],

  priceNotes: [
    'The website counts the pages inside every PDF',
    'Price = pages × copies × your rate',
    'Photos count as one page each',
    'Word files cannot be counted — those say “+ quote”, so you price them by hand',
    'Rates can be changed whenever you want',
  ],

  needs: [
    'Any phone, tablet or computer with internet',
    'The queue link, saved as a bookmark',
    'Your password — keep it to yourself',
    'The QR poster stuck up at the counter',
    'Your UPI ID set on the website, so payments reach you',
  ],

  closing: [
    'No pen drives at the counter',
    'No asking how many copies, or colour or not',
    'Students can pay before they arrive, so prints are ready',
    'You keep a record of every job of the day',
    'Nothing to install, and nothing to pay for',
  ],

  paymentWarning:
    'Important: a student can tap “I have paid” without paying. Only press ₹ received after you see the money in your app.',
};

/* =========================== end of editable text ========================= */

// A deck for the person behind the counter, not for a developer: what lands on
// their screen, what each colour means, and which button to press.
const INK = '15171B';
const PAPER = 'FFFFFF';
const MUTED = '5A6069';
const MAGENTA = 'D6006E';
const CYAN = '0089C7';
const YELLOW = 'F5B301';
const RULE = 'CBCDD3';

const HEAD = 'Arial Black';
const BODY = 'Arial';

const deck = new PptxGenJS();
// LAYOUT_16x9 is 10 x 5.63in; LAYOUT_WIDE is the 13.33 x 7.5in these
// coordinates are drawn for.
deck.layout = 'LAYOUT_WIDE';
deck.author = 'Printout';
deck.title = TEXT.shopName + ' — how it works at the counter';

const W = 13.33;
const H = 7.5;

function slide({ eyebrow, title, tint = MAGENTA }) {
  const s = deck.addSlide();
  s.background = { color: PAPER };

  // The toner bar from the site, so the deck and the screen match.
  const bar = [CYAN, MAGENTA, YELLOW, INK];
  bar.forEach((colour, i) => {
    s.addShape(deck.ShapeType.rect, {
      x: (W / 4) * i,
      y: 0,
      w: W / 4,
      h: 0.16,
      fill: { color: colour },
      line: { none: true },
    });
  });

  if (eyebrow) {
    s.addText(eyebrow.toUpperCase(), {
      x: 0.7,
      y: 0.45,
      w: 11.9,
      h: 0.3,
      fontFace: BODY,
      fontSize: 12,
      bold: true,
      color: tint,
      charSpacing: 2,
    });
  }

  if (title) {
    s.addText(title, {
      x: 0.7,
      y: 0.8,
      w: 11.9,
      h: 0.9,
      fontFace: HEAD,
      fontSize: 34,
      color: INK,
    });
  }

  return s;
}

function bullets(s, items, opts = {}) {
  s.addText(
    items.map((t) => ({
      text: t,
      options: { bullet: { code: '2022' }, breakLine: true },
    })),
    {
      x: opts.x ?? 0.75,
      y: opts.y ?? 2.0,
      w: opts.w ?? 6.0,
      h: opts.h ?? 4.2,
      fontFace: BODY,
      fontSize: opts.fontSize ?? 17,
      color: INK,
      lineSpacingMultiple: 1.5,
      valign: 'top',
    }
  );
}

const shot = (name) => path.join(__dirname, name);

/* 1 — title ---------------------------------------------------------------- */
{
  const s = slide({});
  s.addImage({ path: shot('../public/apple-touch-icon.png'), x: 0.7, y: 1.5, w: 1.1, h: 1.1 });
  s.addText(TEXT.shopName, {
    x: 0.7,
    y: 2.8,
    w: 11.9,
    h: 1.1,
    fontFace: HEAD,
    fontSize: 60,
    color: INK,
  });
  s.addText(TEXT.tagline, {
    x: 0.75,
    y: 3.9,
    w: 11.5,
    h: 0.5,
    fontFace: BODY,
    fontSize: 22,
    color: MUTED,
  });
  s.addText(TEXT.siteUrl, {
    x: 0.75,
    y: 5.6,
    w: 11.5,
    h: 0.4,
    fontFace: 'Courier New',
    fontSize: 16,
    bold: true,
    color: MAGENTA,
  });
}

/* 2 — the problem ---------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'Today', title: 'What slows the counter down' });
  bullets(s, TEXT.problems);
  s.addShape(deck.ShapeType.rect, {
    x: 7.2,
    y: 2.0,
    w: 5.4,
    h: 3.4,
    fill: { color: 'F4F4F6' },
    line: { color: RULE, width: 1 },
  });
  s.addText(TEXT.promise, {
    x: 7.6,
    y: 2.4,
    w: 4.6,
    h: 2.6,
    fontFace: BODY,
    fontSize: 20,
    bold: true,
    color: INK,
  });
}

/* 3 — how it works --------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'How it works', title: 'Four steps, start to finish' });
  const steps = TEXT.steps.map(([head, sub], i) => [String(i + 1), head, sub]);
  steps.forEach(([n, head, sub], i) => {
    const y = 2.05 + i * 1.15;
    s.addShape(deck.ShapeType.ellipse, {
      x: 0.75,
      y,
      w: 0.55,
      h: 0.55,
      fill: { color: INK },
      line: { none: true },
    });
    s.addText(n, {
      x: 0.75,
      y,
      w: 0.55,
      h: 0.55,
      fontFace: HEAD,
      fontSize: 18,
      color: PAPER,
      align: 'center',
      valign: 'middle',
    });
    s.addText(head, {
      x: 1.5,
      y: y - 0.03,
      w: 6.2,
      h: 0.4,
      fontFace: HEAD,
      fontSize: 18,
      color: INK,
    });
    s.addText(sub, {
      x: 1.5,
      y: y + 0.35,
      w: 6.6,
      h: 0.4,
      fontFace: BODY,
      fontSize: 14,
      color: MUTED,
    });
  });
  s.addImage({ path: shot('shot-student.png'), x: 8.9, y: 1.75, w: 1.95, h: 4.4 });
  s.addImage({ path: shot('shot-slip.png'), x: 11.0, y: 1.75, w: 1.85, h: 3.8 });
}

/* 4 — your screen ---------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'Your screen', title: 'The queue', tint: CYAN });
  s.addText(TEXT.queueUrl, {
    x: 0.75,
    y: 1.7,
    w: 11.9,
    h: 0.35,
    fontFace: 'Courier New',
    fontSize: 14,
    bold: true,
    color: MAGENTA,
  });
  s.addImage({ path: shot('shot-queue.png'), x: 0.75, y: 2.15, w: 8.6, h: 5.0 });
  bullets(
    s,
    TEXT.queueNotes,
    { x: 9.6, y: 2.3, w: 3.2, fontSize: 15 }
  );
}

/* 5 — reading a job -------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'Reading a job', title: 'Everything you need is on the card' });
  const rows = [
    ['GAURAV KUMAR', 'The name the student gives at the counter', INK],
    ['₹26', 'What to collect from them', INK],
    ['4 pages · 2 copies', 'How much paper it needs', YELLOW],
    ['COLOUR', 'Print this file in colour — pink label', MAGENTA],
    ['BOTH SIDES', 'Print on both sides — blue label', CYAN],
    ['MIXED INK', 'This order has colour and B&W files together', MAGENTA],
  ];
  rows.forEach(([label, meaning, colour], i) => {
    const y = 1.95 + i * 0.78;
    s.addShape(deck.ShapeType.roundRect, {
      x: 0.75,
      y,
      w: 3.1,
      h: 0.55,
      fill: { color: colour === INK ? 'F4F4F6' : colour },
      line: { color: colour === INK ? RULE : colour, width: 1 },
      rectRadius: 0.05,
    });
    s.addText(label, {
      x: 0.75,
      y,
      w: 3.1,
      h: 0.55,
      fontFace: HEAD,
      fontSize: 15,
      color: colour === INK ? INK : PAPER,
      align: 'center',
      valign: 'middle',
    });
    s.addText(meaning, {
      x: 4.1,
      y,
      w: 8.4,
      h: 0.55,
      fontFace: BODY,
      fontSize: 16,
      color: INK,
      valign: 'middle',
    });
  });
}

/* 6 — buttons -------------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'What you press', title: 'Three buttons, that is all' });
  const acts = [
    ['MARK PRINTED', 'Press once you have printed it. The job turns blue and waits for pickup.'],
    ['COLLECTED', 'Press when the student has taken their prints and paid.'],
    ['DELETE', 'Clears the job and its files. Asks twice. Use it to tidy up finished work.'],
  ];
  acts.forEach(([label, meaning], i) => {
    const y = 2.1 + i * 1.5;
    s.addShape(deck.ShapeType.roundRect, {
      x: 0.75,
      y,
      w: 3.2,
      h: 0.7,
      fill: { color: i === 2 ? PAPER : INK },
      line: { color: i === 2 ? MAGENTA : INK, width: 1.5 },
      rectRadius: 0.05,
    });
    s.addText(label, {
      x: 0.75,
      y,
      w: 3.2,
      h: 0.7,
      fontFace: HEAD,
      fontSize: 16,
      color: i === 2 ? MAGENTA : PAPER,
      align: 'center',
      valign: 'middle',
    });
    s.addText(meaning, {
      x: 4.3,
      y,
      w: 8.3,
      h: 0.8,
      fontFace: BODY,
      fontSize: 16,
      color: INK,
      valign: 'middle',
    });
  });
  s.addText('The tabs at the top — Waiting, Prepaid, Printed, Collected — sort the same jobs.', {
    x: 0.75,
    y: 6.5,
    w: 11.9,
    h: 0.4,
    fontFace: BODY,
    fontSize: 14,
    italic: true,
    color: MUTED,
  });
}

/* 7 — money ---------------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'Money', title: 'Who has paid, and who has not' });
  const states = [
    ['UNPAID', '5A6069', 'Collect cash when they come. Print when they are standing there.'],
    ['SAYS PAID — CHECK YOUR APP', '8A5A00', 'The student sent money by UPI. Check Paytm, then press ₹ received.'],
    ['PAID', '0A7A4B', 'Money confirmed. You can print now, even if they come later.'],
  ];
  states.forEach(([label, colour, meaning], i) => {
    const y = 2.0 + i * 1.35;
    s.addShape(deck.ShapeType.roundRect, {
      x: 0.75,
      y,
      w: 4.3,
      h: 0.65,
      fill: { color: PAPER },
      line: { color: colour, width: 1.5 },
      rectRadius: 0.05,
    });
    s.addText(label, {
      x: 0.75,
      y,
      w: 4.3,
      h: 0.65,
      fontFace: BODY,
      fontSize: 13,
      bold: true,
      color: colour,
      align: 'center',
      valign: 'middle',
    });
    s.addText(meaning, {
      x: 5.4,
      y,
      w: 7.2,
      h: 0.8,
      fontFace: BODY,
      fontSize: 16,
      color: INK,
      valign: 'middle',
    });
  });
  s.addShape(deck.ShapeType.rect, {
    x: 0.75,
    y: 6.15,
    w: 11.85,
    h: 0.85,
    fill: { color: 'FFF4F9' },
    line: { color: MAGENTA, width: 1 },
  });
  s.addText(TEXT.paymentWarning, {
    x: 1.0,
    y: 6.15,
    w: 11.4,
    h: 0.85,
    fontFace: BODY,
    fontSize: 15,
    bold: true,
    color: INK,
    valign: 'middle',
  });
}

/* 8 — prices --------------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'Prices', title: 'The bill adds itself up' });
  bullets(s, [
    TEXT.priceNotes[0],
    TEXT.priceNotes[1],
    `Right now: ₹${TEXT.rateBw} a page black & white, ₹${TEXT.rateColour} a page colour`,
    ...TEXT.priceNotes.slice(2),
  ]);
  s.addShape(deck.ShapeType.rect, {
    x: 7.4,
    y: 2.1,
    w: 5.2,
    h: 2.5,
    fill: { color: 'F4F4F6' },
    line: { color: RULE, width: 1 },
  });
  s.addText(`4 pages × 2 copies × ₹${TEXT.rateBw}`, {
    x: 7.7,
    y: 2.4,
    w: 4.6,
    h: 0.5,
    fontFace: BODY,
    fontSize: 18,
    color: MUTED,
  });
  s.addText(`= ₹${4 * 2 * TEXT.rateBw}`, {
    x: 7.7,
    y: 3.0,
    w: 4.6,
    h: 1.0,
    fontFace: HEAD,
    fontSize: 44,
    color: INK,
  });
}

/* 9 — getting started ------------------------------------------------------ */
{
  const s = slide({ eyebrow: 'To start', title: 'What you need' });
  bullets(s, TEXT.needs);
  s.addShape(deck.ShapeType.rect, {
    x: 7.3,
    y: 2.0,
    w: 5.3,
    h: 3.6,
    fill: { color: PAPER },
    line: { color: INK, width: 2 },
  });
  s.addText('Scan. Send. Collect.', {
    x: 7.6,
    y: 2.35,
    w: 4.7,
    h: 0.6,
    fontFace: HEAD,
    fontSize: 24,
    color: INK,
  });
  s.addText(
    'Print the A4 poster and stick it where students queue. That is the only thing they need to see.',
    { x: 7.6, y: 3.0, w: 4.7, h: 2.2, fontFace: BODY, fontSize: 16, color: MUTED }
  );
}

/* 10 — close --------------------------------------------------------------- */
{
  const s = slide({ eyebrow: 'In short', title: 'Less asking. Less reprinting.' });
  bullets(s, TEXT.closing);
  s.addText(TEXT.contact, {
    x: 0.75,
    y: 6.4,
    w: 11.9,
    h: 0.4,
    fontFace: BODY,
    fontSize: 16,
    bold: true,
    color: MAGENTA,
  });
}

deck
  .writeFile({ fileName: path.join(__dirname, 'printout-for-the-shop.pptx') })
  .then((f) => console.log('written:', f));
