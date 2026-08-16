const queueView = document.getElementById('queue-view');
const signinView = document.getElementById('signin-view');
const jobsBox = document.getElementById('jobs');
const tabs = document.getElementById('tabs');

let filter = 'pending';
let timer = null;

function show(view) {
  queueView.classList.toggle('hidden', view !== 'queue');
  signinView.classList.toggle('hidden', view !== 'signin');
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function when(iso) {
  if (!iso) return '';
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC.
  const date = new Date(`${iso.replace(' ', 'T')}Z`);
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return today ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

const kindLabel = { pdf: 'PDF', image: 'IMG', word: 'DOC' };

function fileRow(file) {
  const spec = [
    file.pages ? `${file.pages}p` : 'pages ?',
    `×${file.copies}`,
    file.color ? '<span class="flag">COLOUR</span>' : 'B&W',
    file.duplex ? '<span class="flag">BOTH</span>' : 'single',
  ].join(' · ');

  return `
    <li class="job-file" data-kind="${file.kind}" data-ink="${file.color ? 'color' : 'bw'}">
      <span class="job-file-kind">${kindLabel[file.kind] || 'FILE'}</span>
      <a href="/api/shop/files/${file.id}" target="_blank" rel="noopener">${escape(file.original_name)}</a>
      <span class="job-file-spec">${spec}</span>
    </li>`;
}

function jobCard(job) {
  const sheets = job.files.reduce((sum, file) => sum + (file.pages || 0) * file.copies, 0);
  const inks = new Set(job.files.map((file) => (file.color ? 'colour' : 'bw')));
  const mixed = inks.size > 1;
  const spec = [
    `${sheets} page${sheets === 1 ? '' : 's'} to print${job.quote_needed ? ' +?' : ''}`,
    mixed ? '<span class="flag">MIXED INK</span>' : inks.has('colour') ? '<span class="flag">ALL COLOUR</span>' : 'all B&W',
  ].join(' · ');

  const money = job.quote_needed ? `₹${job.price}+quote` : `₹${job.price}`;

  // Paid means the shop can print now; unpaid means wait until the student is at
  // the counter with cash. That distinction is the point of the chip.
  const payment =
    job.payment_status === 'paid'
      ? `<span class="chip chip--paid">Paid ₹${job.paid_amount ?? job.price}${
          job.payment_method === 'razorpay' ? ' · verified online' : ''
        }</span>`
      : job.payment_status === 'claimed'
        ? `<span class="chip chip--claimed">Says paid ₹${job.price} · ref ${escape(job.payment_ref)} · ${when(job.paid_at)}</span>`
        : '<span class="chip chip--unpaid">Unpaid · collect at counter</span>';

  // A claim is only a claim until the shop finds it in their bank app, so both
  // answers are one click: it arrived, or it did not.
  const paymentAction =
    job.payment_status === 'claimed'
      ? `<button class="btn btn--small" data-id="${job.id}" data-pay="paid" type="button">₹${job.price} received</button>
         <button class="btn btn--ghost btn--small" data-id="${job.id}" data-pay="unpaid" type="button">Not found</button>`
      : job.payment_status === 'paid'
        ? `<button class="btn btn--ghost btn--small" data-id="${job.id}" data-pay="unpaid" type="button">Undo paid</button>`
        : '';

  const actions =
    job.status === 'pending'
      ? `<button class="btn btn--small" data-id="${job.id}" data-next="printed" type="button">Mark printed</button>`
      : job.status === 'printed'
        ? `<button class="btn btn--small" data-id="${job.id}" data-next="collected" type="button">Collected</button>`
        : `<button class="btn btn--ghost btn--small" data-id="${job.id}" data-next="pending" type="button">Reopen</button>`;

  return `
    <article class="job" data-status="${job.status}" data-payment="${job.payment_status}">
      <div class="job-code">${escape(job.code)}</div>
      <div>
        <ul class="job-files">${job.files.map(fileRow).join('')}</ul>
        <div class="job-meta">
          ${spec} · ${money} · ${escape(job.student_name)} · ${escape(job.phone)} · ${when(job.created_at)}
        </div>
        <div class="job-payment">${payment}</div>
        ${job.notes ? `<div class="job-note">${escape(job.notes)}</div>` : ''}
      </div>
      <div class="job-actions">${paymentAction}${actions}</div>
    </article>`;
}

const emptyStates = {
  prepaid: ['Nothing prepaid', 'Orders students have already paid for appear here.'],
  pending: ['Queue is clear', 'Nothing waiting to be printed.'],
  printed: ['Nothing printed yet', 'Printed jobs waiting for pickup show up here.'],
  collected: ['No collections yet', 'Jobs move here once a student picks them up.'],
  all: ['No orders yet', 'Share the upload link with students to get started.'],
};

async function load() {
  let response;
  try {
    response = await fetch(`/api/shop/orders?status=${filter}`);
  } catch {
    return; // offline blip; the next tick will catch up
  }

  if (response.status === 401) {
    stopPolling();
    return show('signin');
  }

  const data = await response.json();
  for (const tab of tabs.querySelectorAll('.tab[data-status] b')) {
    tab.textContent = data.counts[tab.parentElement.dataset.status] ?? 0;
  }

  jobsBox.innerHTML = data.orders.length
    ? data.orders.map(jobCard).join('')
    : `<div class="empty"><strong>${emptyStates[filter][0]}</strong>${emptyStates[filter][1]}</div>`;
}

function startPolling() {
  stopPolling();
  load();
  timer = setInterval(load, 15000);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab[data-status]');
  if (!tab) return;
  filter = tab.dataset.status;
  tabs.querySelectorAll('.tab').forEach((el) => el.classList.toggle('is-active', el === tab));
  load();
});

jobsBox.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-next], button[data-pay]');
  if (!button) return;
  button.disabled = true;

  const paying = 'pay' in button.dataset;
  await fetch(
    `/api/shop/orders/${button.dataset.id}/${paying ? 'payment' : 'status'}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: paying ? button.dataset.pay : button.dataset.next }),
    }
  );
  load();
});

document.getElementById('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('signin-error');
  const password = document.getElementById('password');
  error.textContent = '';

  const response = await fetch('/api/shop/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password.value }),
  });

  if (!response.ok) {
    password.value = '';
    password.focus();
    error.textContent = 'That password does not match. Try again.';
    return;
  }

  show('queue');
  startPolling();
});

document.getElementById('logout').addEventListener('click', async () => {
  stopPolling();
  await fetch('/api/shop/logout', { method: 'POST' });
  show('signin');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else if (!queueView.classList.contains('hidden')) startPolling();
});

fetch('/api/shop/session')
  .then((res) => res.json())
  .then(({ signedIn }) => {
    show(signedIn ? 'queue' : 'signin');
    if (signedIn) startPolling();
  })
  .catch(() => show('signin'));
