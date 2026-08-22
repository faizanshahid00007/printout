const form = document.getElementById('order-form');
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const fileList = document.getElementById('filelist');
const setAllBar = document.getElementById('setall');
const dropTitle = document.getElementById('drop-title');
const dropSub = document.getElementById('drop-sub');
const errorBox = document.getElementById('error');
const submit = document.getElementById('submit');

let config = {
  rateBw: 2,
  rateColor: 10,
  maxMb: 25,
  maxFiles: 20,
  maxTotalMb: 80,
  accepts: ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.doc', '.docx', '.ppt', '.pptx'],
};

// Files build up across several picks, so we keep our own list rather than
// leaning on the input's FileList, which replaces itself on every choice.
// Each entry carries its own print settings — one PDF can go colour while the
// rest of the batch goes black and white.
let chosen = [];

// New files inherit whatever was picked last, so a batch that is all one way
// stays a single tap.
let lastUsed = { color: 'bw', duplex: 'single', copies: 1 };

fetch('/api/config')
  .then((res) => res.json())
  .then((data) => {
    config = data;

    // The two prices are the line students actually look for, so each is
    // written in the ink it buys.
    document.getElementById('rates').innerHTML =
      `<span class="rate-bw">₹${data.rateBw} a page</span> black &amp; white` +
      ` · <span class="rate-colour">₹${data.rateColor} a page</span> colour`;

    // Redraw with the real limits: the drop zone was already written once from
    // the defaults, which replaced the placeholder markup inside it.
    render();
  })
  .catch(() => {
    // The page still works on the built-in defaults if config cannot be read.
  });

function showError(message) {
  errorBox.textContent = message || '';
  if (message) errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function formatSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function kindOf(name) {
  const ext = extensionOf(name);
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'word';
  if (ext === '.ppt' || ext === '.pptx') return 'slides';
  return 'image';
}

const kindLabel = { pdf: 'PDF', image: 'Photo', word: 'Word', slides: 'Slides' };

// Touch devices get 'tap', pointer devices keep 'drag'.
const touch = window.matchMedia('(pointer: coarse)').matches;
const pickVerb = touch ? 'Tap to add files' : 'Choose files';
const pickHint = touch
  ? 'PDF, photos, Word, PowerPoint'
  : 'or drag them here · PDF, photos, Word, PowerPoint';

function rowMarkup(entry, index) {
  const kind = kindOf(entry.file.name);
  const name = escapeHtml(entry.file.name);
  const ink = (value, label, tint) => `
    <input type="radio" name="ink-${index}" id="ink-${index}-${value}" value="${value}"
      data-index="${index}" data-set="color" ${entry.color === value ? 'checked' : ''} />
    <label for="ink-${index}-${value}" class="${tint || ''}">${label}</label>`;
  const side = (value, label) => `
    <input type="radio" name="side-${index}" id="side-${index}-${value}" value="${value}"
      data-index="${index}" data-set="duplex" ${entry.duplex === value ? 'checked' : ''} />
    <label for="side-${index}-${value}">${label}</label>`;

  return `
    <li class="filerow" data-kind="${kind}" data-ink="${entry.color}">
      <div class="filerow-head">
        <span class="filerow-kind">${kindLabel[kind]}</span>
        <span class="filerow-name">${name}</span>
        <span class="filerow-size">${formatSize(entry.file.size)}</span>
        <button type="button" class="filerow-remove" data-index="${index}"
          aria-label="Remove ${name}">Remove</button>
      </div>
      <div class="filerow-opts">
        <div class="segmented segmented--mini">${ink('bw', 'B&amp;W')}${ink('color', 'Colour', 'tint-color')}</div>
        <div class="segmented segmented--mini">${side('single', 'Single')}${side('double', 'Both')}</div>
        <label class="copies-field">
          <span>Copies</span>
          <input type="number" min="1" max="50" value="${entry.copies}"
            data-index="${index}" data-set="copies" aria-label="Copies of ${name}" />
        </label>
      </div>
    </li>`;
}

function describeMix() {
  const colour = chosen.filter((entry) => entry.color === 'color').length;
  if (colour === 0) return 'all black & white';
  if (colour === chosen.length) return 'all colour';
  return `${colour} in colour, ${chosen.length - colour} in black & white`;
}

function updateSummary() {
  const total = chosen.reduce((sum, entry) => sum + entry.file.size, 0);

  if (chosen.length === 0) {
    dropTitle.textContent = pickVerb;
    dropSub.textContent = `${pickHint} · ${config.maxMb} MB each`;
    submit.textContent = 'Send to counter';
  } else {
    dropTitle.textContent = touch ? 'Tap to add more' : 'Add more files';
    dropSub.textContent = `${chosen.length} of ${config.maxFiles} · ${formatSize(total)} · ${describeMix()}`;
    submit.textContent =
      chosen.length > 1 ? `Send ${chosen.length} files to counter` : 'Send to counter';
  }

  setAllBar.classList.toggle('hidden', chosen.length < 2);
}

function render() {
  fileList.innerHTML = chosen.map(rowMarkup).join('');
  updateSummary();
}

// Some pickers hand back a file with no extension in its name. If the browser
// knows the media type, that is enough to send it — the server checks again.
const ACCEPTED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function isAccepted(file) {
  if (config.accepts.includes(extensionOf(file.name))) return true;
  const type = (file.type || '').toLowerCase();
  return ACCEPTED_TYPES.has(type) || type.startsWith('image/');
}

function addFiles(incoming) {
  const rejected = [];
  const empty = [];

  for (const file of incoming) {
    // A file still sitting in iCloud or Drive comes through with no bytes. It
    // would upload as an empty page, so stop it here and say what to do.
    if (file.size === 0) {
      empty.push(file.name);
      continue;
    }
    if (!isAccepted(file)) {
      rejected.push(file.name);
      continue;
    }
    if (chosen.length >= config.maxFiles) {
      render();
      return showError(`You can send up to ${config.maxFiles} files at a time.`);
    }
    const duplicate = chosen.some(
      (entry) => entry.file.name === file.name && entry.file.size === file.size
    );
    if (!duplicate) chosen.push({ file, ...lastUsed });
  }

  if (empty.length) {
    showError(
      `${empty[0]} came through empty. Open it once on your phone so it downloads fully, then add it again.`
    );
  } else if (rejected.length) {
    showError(
      rejected.length === 1
        ? `${rejected[0]} cannot be printed here. Send a PDF, photo, Word or PowerPoint file.`
        : `${rejected.length} files cannot be printed here. Send PDFs, photos, Word or PowerPoint files.`
    );
  } else {
    showError('');
  }
  render();
}

fileInput.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files));
  fileInput.value = ''; // let the same file be picked again after removing it
});

fileList.addEventListener('click', (event) => {
  const button = event.target.closest('.filerow-remove');
  if (!button) return;
  chosen.splice(Number(button.dataset.index), 1);
  render();
});

// Settings change in place: re-rendering here would steal focus from the
// copies box mid-typing.
fileList.addEventListener('change', (event) => {
  const control = event.target.closest('[data-set]');
  if (!control) return;
  const entry = chosen[Number(control.dataset.index)];
  if (!entry) return;

  if (control.dataset.set === 'copies') {
    const copies = Math.min(50, Math.max(1, Number.parseInt(control.value, 10) || 1));
    control.value = copies;
    entry.copies = copies;
  } else {
    entry[control.dataset.set] = control.value;
  }

  // The row's edge carries the ink choice, so a colour file is obvious in a
  // stack of black-and-white ones without re-rendering the list.
  control.closest('.filerow').dataset.ink = entry.color;

  lastUsed = { color: entry.color, duplex: entry.duplex, copies: entry.copies };
  updateSummary();
});

setAllBar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-all]');
  if (!button) return;
  const value = button.dataset.all;
  const key = value === 'bw' || value === 'color' ? 'color' : 'duplex';
  chosen.forEach((entry) => {
    entry[key] = value;
  });
  lastUsed = { ...lastUsed, [key]: value };
  render();
});

['dragenter', 'dragover'].forEach((type) => {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
});

['dragleave', 'drop'].forEach((type) => {
  drop.addEventListener(type, () => drop.classList.remove('is-over'));
});

drop.addEventListener('drop', (event) => {
  event.preventDefault();
  addFiles(Array.from(event.dataTransfer.files));
});

// fetch() reports every network problem as one word — "Failed to fetch" — which
// tells a student nothing and hides whether the upload was crawling or dead.
// XMLHttpRequest gives the upload's progress and separates a timeout from a
// dropped connection, which matters most on phone data.
// Tells the shop what happened, so a failure on a network we cannot reach is
// still something we can look at afterwards.
function report(outcome, extra) {
  try {
    navigator.sendBeacon(
      '/api/report',
      new Blob([JSON.stringify({ outcome, ...extra })], { type: 'application/json' })
    );
  } catch {
    // Diagnostics must never get in the way of the order itself.
  }
}

function postOrder(payload, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/orders');
    // Generous: a big scan on slow data, plus a sleeping server waking up.
    request.timeout = 180000;

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total, event.loaded, event.total);
    });

    request.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(request.responseText);
      } catch {
        // A gateway page rather than our JSON — treated as a server problem.
      }
      if (request.status >= 200 && request.status < 300) return resolve(data);
      reject(
        Object.assign(new Error(data.error || `The shop refused it (error ${request.status}).`), {
          fatal: true,
        })
      );
    });

    request.addEventListener('error', () => reject(new Error('connection lost')));
    request.addEventListener('timeout', () => reject(new Error('timed out')));
    request.addEventListener('abort', () => reject(new Error('cancelled')));

    request.send(payload);
  });
}

async function sendOrder(payload, onProgress, attempt = 1) {
  const started = Date.now();
  let sentBytes = 0;
  let totalBytes = 0;

  const watched = (fraction, loaded, total) => {
    sentBytes = loaded;
    totalBytes = total;
    onProgress(fraction);
  };

  try {
    const data = await postOrder(payload, watched);
    if (attempt > 1) {
      report('recovered', { bytesSent: sentBytes, bytesTotal: totalBytes, tookMs: Date.now() - started, attempt });
    }
    return data;
  } catch (err) {
    report(err.fatal ? 'refused' : 'broken', {
      detail: err.message,
      bytesSent: sentBytes,
      bytesTotal: totalBytes,
      tookMs: Date.now() - started,
      attempt,
    });
    // The server answering with a refusal is final; only a broken connection is
    // worth trying again.
    if (err.fatal) throw err;

    if (attempt < 2) {
      await new Promise((wait) => setTimeout(wait, 4000));
      return sendOrder(payload, onProgress, attempt + 1);
    }

    throw new Error(
      err.message === 'timed out'
        ? 'The upload took too long. Move somewhere with better signal, or send fewer files at once.'
        : 'The connection dropped while sending. Try again on wifi, or send one file at a time.'
    );
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  if (chosen.length === 0) return showError('Add at least one file to print.');

  const oversized = chosen.find((entry) => entry.file.size > config.maxMb * 1024 * 1024);
  if (oversized) {
    return showError(
      `${oversized.file.name} is ${formatSize(oversized.file.size)}. The limit is ${config.maxMb} MB per file.`
    );
  }

  const total = chosen.reduce((sum, entry) => sum + entry.file.size, 0);
  if (total > config.maxTotalMb * 1024 * 1024) {
    return showError(
      `That batch is ${formatSize(total)}. Send up to ${config.maxTotalMb} MB at a time.`
    );
  }

  // Android hands over a file as a reference to somewhere else on the phone, and
  // that reference can go stale between picking and sending — the upload then
  // dies instantly with nothing sent. Reading the bytes here forces the problem
  // into the open, where it can be explained, instead of looking like a network
  // fault.
  const payload = new FormData();
  payload.set('studentName', document.getElementById('studentName').value);
  payload.set('phone', document.getElementById('phone').value);
  payload.set('notes', document.getElementById('notes').value);
  payload.set(
    'specs',
    JSON.stringify(chosen.map(({ color, duplex, copies }) => ({ color, duplex, copies })))
  );

  try {
    for (const entry of chosen) {
      const bytes = await entry.file.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error(`${entry.file.name} is empty`);
      payload.append('files', new Blob([bytes], { type: entry.file.type }), entry.file.name);
    }
  } catch (err) {
    report('unreadable', { detail: err.message });
    return showError(
      'Your phone could not read that file. Remove it, add it again, and send — if it lives in Drive, download it to the phone first.'
    );
  }

  const label = submit.textContent;
  submit.disabled = true;
  submit.classList.add('is-sending');
  submit.textContent = 'Sending…';

  // Watching a percentage climb is the difference between "it is working" and
  // "it is stuck" on a slow phone connection.
  let sent = 0;
  const onProgress = (fraction) => {
    sent = fraction;
    submit.textContent =
      fraction >= 1 ? 'Almost there…' : `Sending ${Math.round(fraction * 100)}%`;
  };

  // If nothing has moved at all after six seconds, the server is most likely
  // still waking up.
  const waking = setTimeout(() => {
    if (sent === 0) submit.textContent = 'Waking the shop…';
  }, 6000);

  try {
    const data = await sendOrder(payload, onProgress);
    showSlip(data);
  } catch (err) {
    showError(err.message);
  } finally {
    clearTimeout(waking);
    submit.disabled = false;
    submit.classList.remove('is-sending');
    submit.textContent = label;
  }
});

function specLine(file) {
  return [
    file.pages ? `${file.pages}p` : 'pages counted at the shop',
    `×${file.copies}`,
    file.color ? 'colour' : 'B&W',
    file.duplex ? 'both sides' : 'single',
    file.price === null ? '' : `₹${file.price}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

// --- payment ----------------------------------------------------------------
const payBox = document.getElementById('pay');
const payLead = document.getElementById('pay-lead');
const payStart = document.getElementById('pay-start');
const payDone = document.getElementById('pay-done');
const payError = document.getElementById('pay-error');
let payingCode = null;

const payDoneText = document.getElementById('pay-done-text');

const paidLine = (state) =>
  state.status === 'paid'
    ? `Paid ₹${state.paid_amount ?? state.amount} — the shop has confirmed it. They will print your files and call you.`
    : `The shop will check your ₹${state.amount} payment in their app, print your files, and call you when they are ready.`;

async function loadPayment(code, amount) {
  payingCode = code;
  payError.textContent = '';
  payBox.classList.add('hidden');

  let state;
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(code)}/payment`);
    state = await response.json();
    if (!response.ok) return;
  } catch {
    return; // paying is optional; the counter still works
  }

  if (!state.enabled) return;
  payBox.classList.remove('hidden');

  if (state.status !== 'unpaid') {
    payStart.classList.add('hidden');
    payDone.classList.remove('hidden');
    payDoneText.textContent = paidLine(state);
    payLead.textContent = 'Payment';
    return;
  }

  payStart.classList.remove('hidden');
  payDone.classList.add('hidden');
  payDone.classList.remove('pay-done--counter');

  if (!state.payable) {
    payLead.textContent = state.reason || 'Pay at the counter.';
    payStart.classList.add('hidden');
    return;
  }

  payLead.innerHTML = `Pay <strong>₹${state.amount}</strong> now and the shop can print before you get there — or skip this and pay cash at the counter.`;

  document.getElementById('pay-qr-img').src = state.qr;
  document.getElementById('pay-upi-id').textContent = state.upiId;
}

// Typing a UPI ID by hand invites typos, so it is one tap to copy.
document.getElementById('pay-copy').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const upiId = document.getElementById('pay-upi-id').textContent;
  try {
    await navigator.clipboard.writeText(upiId);
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 2000);
  } catch {
    payError.textContent = `Copy it by hand: ${upiId}`;
  }
});

// The student tells us they have paid; the shop is the one who confirms it
// against their app, so nothing here is treated as settled money.
document.getElementById('pay-sent').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  payError.textContent = '';
  button.disabled = true;

  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(payingCode)}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    payStart.classList.add('hidden');
    payDone.classList.remove('hidden');
    payDoneText.textContent = paidLine(data);
  } catch (err) {
    payError.textContent =
      err.message === 'Failed to fetch'
        ? 'Could not reach the shop. Try again, or show your payment at the counter.'
        : err.message || 'Could not record that. Show the payment at the counter.';
  } finally {
    button.disabled = false;
  }
});

// Paying at the counter is a real answer, not a refusal to answer: the order
// stays exactly as it is and the student gets the same clear ending.
document.getElementById('pay-later').addEventListener('click', () => {
  payError.textContent = '';
  payStart.classList.add('hidden');
  payDone.classList.remove('hidden');
  payDone.classList.add('pay-done--counter');
  payDoneText.textContent =
    'No problem — pay cash when you collect. Give your name at the counter and they will print your files.';
});

document.getElementById('pay-ok').addEventListener('click', goHome);

function showSlip(order) {
  document.querySelector('#slip-view .eyebrow').textContent =
    order.statusLine || 'Show this at the counter';
  document.getElementById('slip-code').textContent = order.code;
  document.getElementById('slip-files-label').textContent =
    order.files.length === 1 ? 'File' : `${order.files.length} files`;
  document.getElementById('slip-files').innerHTML = order.files
    .map(
      (file) => `
        <div class="slip-file">
          ${escapeHtml(file.name)}
          <span>${specLine(file)}</span>
        </div>`
    )
    .join('');

  // Showing ₹0 for a file nobody can count reads as free. Say what will
  // actually happen instead.
  const total = document.getElementById('slip-total');
  if (!order.quoteNeeded) {
    total.textContent = `₹${order.price}`;
  } else if (order.price > 0) {
    total.innerHTML =
      `₹${order.price} <span class="qualifier">plus the Word or PowerPoint file, priced at the counter</span>`;
  } else {
    // Nothing here could be counted. Say what to do about it, since sending a
    // PDF instead gets them a price straight away.
    total.innerHTML =
      '<span class="qualifier-lead">The shop will count the pages and tell you</span>' +
      '<span class="qualifier">Word files do not carry a page count. Send it as a PDF to see the price here.</span>';
  }

  document.getElementById('form-view').classList.add('hidden');
  document.getElementById('slip-view').classList.remove('hidden');
  window.scrollTo({ top: 0 });

  loadPayment(order.code);
}

// Back to an empty form, ready for the next order.
function goHome() {
  form.reset();
  chosen = [];
  render();
  document.getElementById('lookup-result').textContent = '';
  document.getElementById('slip-view').classList.add('hidden');
  document.getElementById('form-view').classList.remove('hidden');
  window.scrollTo({ top: 0 });
}

// --- status lookup ----------------------------------------------------------
const statusText = {
  pending: 'Waiting in the queue.',
  printed: 'Printed — ready to collect at the counter.',
  collected: 'Collected.',
};

document.getElementById('lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = document.getElementById('lookup-result');
  const code = document.getElementById('lookup-code').value.trim().toUpperCase();
  if (!code) return;

  result.textContent = 'Checking…';
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(code)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    result.textContent = statusText[data.status];
    // Bringing the whole slip back means a student who closed the page can still
    // pay, and has their code and total in front of them again.
    showSlip({
      code: data.code,
      statusLine: statusText[data.status],
      price: data.price,
      quoteNeeded: Boolean(data.quote_needed),
      files: data.files.map((file) => ({
        name: file.original_name,
        pages: file.pages,
        copies: file.copies,
        color: Boolean(file.color),
        duplex: Boolean(file.duplex),
        price: file.price,
      })),
    });
  } catch (err) {
    result.textContent =
      err.message === 'Failed to fetch'
        ? 'Could not reach the shop. Check your internet and try again.'
        : err.message || 'Could not find an order in that name.';
  }
});

render();
