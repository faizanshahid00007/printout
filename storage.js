const fs = require('fs');
const path = require('path');

// Uploaded files cannot live on the server's own disk once the shop is hosted:
// free hosts hand out a fresh, empty disk on every restart. With Supabase
// configured they go to object storage instead, and the local folder is kept
// only for running on your own machine.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'printout';

const LOCAL_DIR = path.join(__dirname, 'uploads');

const remote =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? require('@supabase/supabase-js').createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
      })
    : null;

const isRemote = Boolean(remote);

async function ready() {
  if (!remote) {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    return;
  }
  // Private bucket: files are only ever served through the queue, which is
  // behind the shop password.
  const { data } = await remote.storage.listBuckets();
  if (!data?.some((bucket) => bucket.name === BUCKET)) {
    const { error } = await remote.storage.createBucket(BUCKET, { public: false });
    if (error && !/exists/i.test(error.message)) throw error;
  }
}

async function save(name, body, contentType) {
  if (!remote) {
    await fs.promises.writeFile(path.join(LOCAL_DIR, name), body);
    return;
  }
  const { error } = await remote.storage
    .from(BUCKET)
    .upload(name, body, { contentType, upsert: false });
  if (error) throw error;
}

async function read(name) {
  if (!remote) return fs.promises.readFile(path.join(LOCAL_DIR, name));
  const { data, error } = await remote.storage.from(BUCKET).download(name);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function remove(name) {
  if (!remote) {
    await fs.promises.unlink(path.join(LOCAL_DIR, name)).catch(() => {});
    return;
  }
  await remote.storage.from(BUCKET).remove([name]);
}

module.exports = { ready, save, read, remove, isRemote, LOCAL_DIR };
