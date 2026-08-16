# Campus Print Shop

Students send a batch of files from their phone and get a 5-character code. The shop
opens the queue on the counter PC, prints the files, and marks the job done.

Accepted: PDF, photos (JPEG, PNG, WebP, HEIC), and Word (.doc, .docx). One order can hold
up to 20 files, and **each file carries its own copies, ink, and sides** — notes in B&W and
one diagram in colour go in the same order. A "set every file to" row handles the common
case where the whole batch is the same, and new files inherit the last settings used.

The queue flags a mixed-ink order and puts a magenta dot beside each colour file, since a
single colour page hiding in a black-and-white batch is the easiest thing to miss.

## Run it

```sh
npm install
cp .env.example .env   # fill it in, then:
npm start
```

Settings live in `.env`, so `npm start` carries them across restarts. Anything left blank
stays switched off: no `UPI_ID` means no UPI button, no Razorpay keys means no online
payment, and the shop runs on cash at the counter.

- Students: <http://localhost:3000>
- Shop counter: <http://localhost:3000/shop.html>

## Settings

All optional, set as environment variables:

| Variable        | Default  | Meaning                        |
| --------------- | -------- | ------------------------------ |
| `PORT`          | `3000`   | Port to serve on               |
| `SHOP_PASSWORD` | none — **required** | Password for the queue page; the server refuses to start without it |
| `RATE_BW`       | `2`      | ₹ per page, black & white      |
| `RATE_COLOR`    | `10`     | ₹ per page, colour             |
| `MAX_MB`        | `25`     | Largest single file            |
| `MAX_FILES`     | `20`     | Files per order                |
| `MAX_TOTAL_MB`  | `80`     | Total size of one order        |
| `UPI_ID`        | unset    | Shop's UPI ID; unset hides paying online |
| `UPI_NAME`      | `Campus Print Shop` | Payee name shown in the UPI app |

There is no default password. The queue holds students' files and phone numbers, so the
server exits rather than start with an open back door.

## How the pieces fit

- `server.js` — API, uploads, SQLite queries, shop login
- `public/index.html` + `app.js` — student upload form and the counter slip
- `public/shop.html` + `shop.js` — queue, polls every 15 seconds
- `uploads/` — the files themselves, named so two students can't collide
- `printshop.db` — `orders` holds the student, notes, total, and status; `order_files` holds
  one row per file with its own copies, ink, sides, page count, and price

Schema changes are migrated on startup and each step is skipped once applied, so restarting
is safe and existing orders survive.

### Page counts and price

- **PDF** — read out of the file, so the slip shows the real price.
- **Photo** — one page each.
- **Word** — no page count exists to read. A `.docx` repaginates according to the fonts and
  margins of whatever machine opens it, so any count would be a guess. Those orders show
  the total for the countable files plus "quoted at the counter", and the queue marks them
  `+quote` so the shop knows to price them by hand.
- A locked or damaged PDF is treated the same way as Word: queued, priced at the counter.

PDFs and photos open inline in the browser, so the shop prints straight from the tab.
Word files download instead, since the browser can't render them.

## Paying online

Paying never blocks the queue. It changes when the shop can safely print:

- **Unpaid** — print when the student is at the counter with cash.
- **UPI ref … check bank** — the student says they sent it and gave a reference. The shop
  matches it in their bank app and hits *Confirm received*.
- **Paid** — money accounted for. The shop can print and set it aside without the student
  there, which is the whole point for someone ordering from outside campus.

The student gets a UPI deep link (opens GPay/PhonePe directly on a phone) and a QR for
desktop, both carrying the exact amount and the order code as the note. Entering the code
on the front page brings the slip back, so they can pay later from anywhere.

**A UPI transfer goes straight to the shop's own ID, so this app cannot verify it.** A
student could type any digits. That is why a claim shows as *check bank* and only the shop
can mark it paid — treat the chip as a claim until confirmed. Orders with a Word file have
no computed total, so they cannot be prepaid at all and say so.

### Razorpay, for payments that verify themselves

Fill in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` and a **Pay online** button appears
next to the UPI one. Card, netbanking, and UPI all go through the gateway, and the shop
has nothing to check: the job shows *Paid · verified online* on its own.

How the proof works. The server asks Razorpay to create an order and remembers its id.
When the student pays, Razorpay hands the browser a signature — an HMAC of
`order_id|payment_id` made with the key secret. The server recomputes it and compares.
Only someone holding the secret can produce a matching value, and a signature from a
different order is refused, so a student cannot mark their own order paid.

Keys starting `rzp_test_` move no real money and need no KYC — use them to try the whole
flow. Live keys need business KYC, and money settles to the registered bank account in
about two working days rather than instantly, with a per-transaction fee.

Keep UPI switched on alongside it: it is instant and free, which suits walk-in students.
The gateway earns its fee on orders placed from off campus.

## Putting it on the college network

The shop PC and the students' phones need to be on the same network. Run the server
on the shop PC, find its LAN address (`ipconfig getifaddr en0` on a Mac,
`ipconfig` on Windows), and give students `http://that-address:3000`.

For access from outside campus, put it on a small VPS behind nginx with HTTPS —
uploads and phone numbers should not travel over plain HTTP on the open internet.

## Housekeeping

Old files pile up in `uploads/`. To clear jobs collected more than a week ago:

```sh
OLD="status='collected' AND created_at < datetime('now','-7 days')"
sqlite3 printshop.db "SELECT stored_name FROM order_files WHERE order_id IN (SELECT id FROM orders WHERE $OLD)" \
  | xargs -I{} rm -f uploads/{}
sqlite3 printshop.db "DELETE FROM orders WHERE $OLD"
```

Deleting an order removes its `order_files` rows too, so run the file deletion first.
