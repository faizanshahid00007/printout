const fs = require('fs');
const path = require('path');

// Uploaded files cannot live on the server's own disk once the shop is hosted:
// free hosts hand out a fresh, empty disk on every restart. With Supabase
// configured they go to object storage instead, and the local folder is kept
// only for running on your own machine.
//
// This talks to the storage REST API directly rather than through the Supabase
// SDK — the SDK pulls in a realtime client that wants a WebSocket Node 20 does
// not have, and none of that is needed to put a file somewhere.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'printout';

const LOCAL_DIR = path.join(__dirname, 'uploads');
const isRemote = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const api = `${SUPABASE_URL}/storage/v1`;

const headers = () => ({
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  apikey: SUPABASE_SERVICE_KEY,
});

async function fail(response, what) {
  const body = await response.text().catch(() => '');
  throw new Error(`${what} failed (${response.status}): ${body.slice(0, 200)}`);
}

async function ready() {
  if (!isRemote) {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    return;
  }

  // Private bucket: files are only ever served through the queue, which sits
  // behind the shop password.
  const response = await fetch(`${api}/bucket`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BUCKET, id: BUCKET, public: false }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (!/already exists|Duplicate/i.test(body)) await fail(response, 'Creating the bucket');
  }
}

async function save(name, body, contentType) {
  if (!isRemote) {
    await fs.promises.writeFile(path.join(LOCAL_DIR, name), body);
    return;
  }

  const response = await fetch(`${api}/object/${BUCKET}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      ...headers(),
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body,
  });
  if (!response.ok) await fail(response, `Uploading ${name}`);
}

async function read(name) {
  if (!isRemote) return fs.promises.readFile(path.join(LOCAL_DIR, name));

  const response = await fetch(`${api}/object/${BUCKET}/${encodeURIComponent(name)}`, {
    headers: headers(),
  });
  if (!response.ok) await fail(response, `Reading ${name}`);
  return Buffer.from(await response.arrayBuffer());
}

async function remove(name) {
  if (!isRemote) {
    await fs.promises.unlink(path.join(LOCAL_DIR, name)).catch(() => {});
    return;
  }
  await fetch(`${api}/object/${BUCKET}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: headers(),
  });
}

module.exports = { ready, save, read, remove, isRemote, LOCAL_DIR };
