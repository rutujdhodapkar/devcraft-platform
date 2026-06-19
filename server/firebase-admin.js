import pkg from 'firebase-admin';

let db = null;
let auth = null;
let isConfigured = false;

try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null;

  if (serviceAccount && serviceAccount.projectId) {
    if (!pkg.apps || pkg.apps.length === 0) {
      pkg.initializeApp({
        credential: pkg.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://login-data-680b9-default-rtdb.firebaseio.com',
      });
    }
    db = pkg.database();
    auth = pkg.auth();
    isConfigured = true;
    console.log('Firebase Admin initialized successfully');
  } else {
    console.warn('Firebase Admin not configured (no service account). Running in file-based mode.');
  }
} catch (err) {
  console.warn('Firebase Admin initialization failed:', err.message);
  console.warn('Running in file-based mode.');
}

export { db, auth, isConfigured };

export async function getData(path) {
  if (!db) return null;
  const snap = await db.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}

export async function setData(path, data) {
  if (!db) return;
  await db.ref(path).set(data);
}

export async function pushData(path, data) {
  if (!db) return null;
  const ref = db.ref(path).push();
  await ref.set(data);
  return ref.key;
}

export async function updateData(path, data) {
  if (!db) return;
  await db.ref(path).update(data);
}

export async function removeData(path) {
  if (!db) return;
  await db.ref(path).remove();
}

export default pkg;
