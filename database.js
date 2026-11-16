const { applicationDefault, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const projectId = process.env.FIREBASE_PROJECT_ID;
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

if (!projectId || !storageBucket) {
  throw new Error('FIREBASE_PROJECT_ID dan FIREBASE_STORAGE_BUCKET wajib diatur.');
}

const firebaseApp = getApps().length
  ? getApp()
  : initializeApp({ credential: applicationDefault(), projectId, storageBucket });
const db = getFirestore(firebaseApp);
const bucket = getStorage(firebaseApp).bucket();
const maxImageBytes = 2 * 1024 * 1024;
const allowedImageTypes = new Map([
  ['jpeg', 'jpg'],
  ['png', 'png'],
  ['webp', 'webp']
]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanText(value, label, maxLength, required = false) {
  if (typeof value !== 'string') throw httpError(400, `${label} harus berupa teks.`);
  const text = value.trim();
  if (required && !text) throw httpError(400, `${label} wajib diisi.`);
  if (text.length > maxLength) throw httpError(400, `${label} maksimal ${maxLength} karakter.`);
  return text;
}

function cleanRows(rows, label, limit) {
  if (!Array.isArray(rows) || rows.length > limit) {
    throw httpError(400, `${label} tidak valid atau melebihi batas.`);
  }
  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 3) {
      throw httpError(400, `${label} baris ${index + 1} tidak valid.`);
    }
    return [
      cleanText(row[0], `${label} item`, 200),
      cleanText(row[1], `${label} spesifikasi`, 1000),
      cleanText(row[2], `${label} kuantitas`, 100)
    ];
  }).filter(row => row.some(Boolean));
}

function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError(400, 'Data SPK tidak valid.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate || '') ||
      Number.isNaN(Date.parse(`${input.entryDate}T00:00:00Z`))) {
    throw httpError(400, 'Tanggal masuk tidak valid.');
  }
  if (!Array.isArray(input.groups) || input.groups.length > 20) {
    throw httpError(400, 'Kelompok spesifikasi tidak valid.');
  }
  const groups = input.groups.map((group, index) => {
    if (!group || typeof group !== 'object') {
      throw httpError(400, `Kelompok spesifikasi ${index + 1} tidak valid.`);
    }
    return {
      title: cleanText(group.title, 'Nama kelompok', 100, true),
      items: cleanRows(group.items, 'Spesifikasi', 200)
    };
  });

  return {
    customer: cleanText(input.customer, 'Nama customer', 200, true),
    unitType: cleanText(input.unitType, 'Jenis unit', 200, true),
    capacity: cleanText(input.capacity || '', 'Kapasitas', 100),
    chassis: cleanText(input.chassis || '', 'Nomor chassis', 100),
    so: cleanText(input.so || '', 'Nomor SO', 100),
    entryDate: input.entryDate,
    groups,
    additional: cleanRows(input.additional || [], 'Spesifikasi tambahan', 100),
    notes: cleanText(input.notes || '', 'Catatan', 5000),
    drawingData: input.drawing || ''
  };
}

function parseDrawing(dataUrl) {
  if (!dataUrl) return null;
  if (typeof dataUrl !== 'string') throw httpError(400, 'Gambar teknik tidak valid.');
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw httpError(400, 'Gambar harus berformat JPG, PNG, atau WebP.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxImageBytes) {
    throw httpError(400, 'Ukuran gambar maksimal 2 MB.');
  }
  return { buffer, contentType: `image/${match[1]}`, extension: allowedImageTypes.get(match[1]) };
}

function serializeSpk(snapshot) {
  const data = snapshot.data();
  const { drawingPath, ...record } = data;
  return {
    id: snapshot.id,
    ...record,
    createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
    drawing: drawingPath ? `/api/spk/${encodeURIComponent(snapshot.id)}/drawing` : ''
  };
}

async function listSpk() {
  const snapshot = await db.collection('spks').orderBy('createdAt', 'desc').get();
  return snapshot.docs.map(serializeSpk);
}

async function getSpk(id) {
  const snapshot = await db.collection('spks').doc(id).get();
  return snapshot.exists ? serializeSpk(snapshot) : null;
}

async function createSpk(input) {
  const record = validateRecord(input);
  const drawing = parseDrawing(record.drawingData);
  delete record.drawingData;

  const spkRef = db.collection('spks').doc();
  const year = new Date().getFullYear();
  const counterRef = db.collection('_system').doc(`spk-${year}`);
  const drawingPath = drawing ? `spk-drawings/${spkRef.id}.${drawing.extension}` : '';

  if (drawing) {
    await bucket.file(drawingPath).save(drawing.buffer, {
      metadata: { contentType: drawing.contentType, cacheControl: 'private, no-store' },
      resumable: false
    });
  }

  try {
    await db.runTransaction(async transaction => {
      const counter = await transaction.get(counterRef);
      const sequence = (counter.exists ? Number(counter.data().sequence) || 0 : 0) + 1;
      transaction.set(counterRef, { sequence, updatedAt: FieldValue.serverTimestamp() });
      transaction.set(spkRef, {
        ...record,
        spkNo: `SPK/MAK/${year}/${String(sequence).padStart(3, '0')}`,
        drawingPath,
        createdAt: FieldValue.serverTimestamp()
      });
    });
  } catch (error) {
    if (drawing) await bucket.file(drawingPath).delete({ ignoreNotFound: true }).catch(cleanupError => {
      console.error('Gagal membersihkan gambar SPK yang tidak tersimpan.', cleanupError);
    });
    throw error;
  }

  return getSpk(spkRef.id);
}

async function deleteSpk(id) {
  const ref = db.collection('spks').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return false;
  const drawingPath = snapshot.data().drawingPath;
  if (drawingPath) await bucket.file(drawingPath).delete({ ignoreNotFound: true });
  await ref.delete();
  return true;
}

async function getSpkDrawing(id) {
  const snapshot = await db.collection('spks').doc(id).get();
  if (!snapshot.exists || !snapshot.data().drawingPath) {
    throw httpError(404, 'Gambar teknik tidak ditemukan.');
  }
  const file = bucket.file(snapshot.data().drawingPath);
  const [[buffer], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
  return { buffer, contentType: metadata.contentType || 'application/octet-stream' };
}

module.exports = { createSpk, deleteSpk, getSpk, getSpkDrawing, listSpk };
