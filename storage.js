/**
 * 持久化抽象：本地磁盘 或 Cloudflare R2（S3 兼容）
 *
 * R2 环境变量（全部设置后启用）：
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET
 * 可选：
 *   R2_ENDPOINT   默认 https://{ACCOUNT_ID}.r2.cloudflarestorage.com
 *   R2_PUBLIC_BASE_URL  若配置了自定义域名公开读（本实现默认仍经 /api/files 代理）
 *
 * 本地（未配 R2）仍用 DATA_DIR 或 ./data
 */
const fs = require('fs');
const path = require('path');

function resolveDataDir() {
  const fromEnv = String(process.env.DATA_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(__dirname, 'data');
}

const DATA_DIR = resolveDataDir();
const FILES_DIR = path.join(DATA_DIR, 'files');
const HISTORY_KEY = 'history.json';
const MODELS_KEY = 'models-config.json';

const R2_ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET = String(process.env.R2_BUCKET || '').trim();
const R2_ENDPOINT = String(
  process.env.R2_ENDPOINT ||
    (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '')
).trim();

const useR2 = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_ENDPOINT
);

/** @type {import('@aws-sdk/client-s3').S3Client | null} */
let s3 = null;

function getS3() {
  if (!useR2) return null;
  if (s3) return s3;
  // 延迟 require，本地无依赖时仍可启动（仅本地盘模式）
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: false,
  });
  return s3;
}

function storageMode() {
  return useR2 ? 'r2' : 'local';
}

function storageInfo() {
  return {
    mode: storageMode(),
    dataDir: DATA_DIR,
    dataDirFromEnv: Boolean(String(process.env.DATA_DIR || '').trim()),
    r2: useR2
      ? {
          bucket: R2_BUCKET,
          endpoint: R2_ENDPOINT.replace(/\/\/[^@/]+@/, '//'), // 无凭据
          accountIdSet: Boolean(R2_ACCOUNT_ID),
        }
      : null,
  };
}

// ---- 本地 ----
function ensureLocalDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
}

function localHistoryPath() {
  return path.join(DATA_DIR, HISTORY_KEY);
}
function localModelsPath() {
  return path.join(DATA_DIR, MODELS_KEY);
}
function localFilePath(recordId, fileName) {
  return path.join(FILES_DIR, String(recordId), fileName);
}

// ---- R2 helpers ----
async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function r2Get(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const out = await getS3().send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key })
    );
    return await streamToBuffer(out.Body);
  } catch (e) {
    const code = e.name || e.Code || e.$metadata?.httpStatusCode;
    if (code === 'NoSuchKey' || code === 'NotFound' || code === 404) return null;
    throw e;
  }
}

async function r2Put(key, buffer, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await getS3().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    })
  );
}

async function r2Delete(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await getS3().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (e) {
    console.warn('[r2] delete failed', key, e.message);
  }
}

async function r2ListPrefix(prefix) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const keys = [];
  let token;
  do {
    const out = await getS3().send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of out.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// ---- JSON 读写（history / models）----
let historyWriteChain = Promise.resolve();

function withHistoryLock(fn) {
  const run = historyWriteChain.then(fn, fn);
  historyWriteChain = run.catch(() => {});
  return run;
}

async function readJsonKey(key, localPath, fallback) {
  if (useR2) {
    const buf = await r2Get(key);
    if (!buf) return fallback;
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return fallback;
    }
  }
  ensureLocalDirs();
  if (!fs.existsSync(localPath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(localPath, 'utf8') || '');
  } catch {
    return fallback;
  }
}

async function writeJsonKey(key, localPath, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  if (useR2) {
    await r2Put(key, body, 'application/json; charset=utf-8');
    return;
  }
  ensureLocalDirs();
  fs.writeFileSync(localPath, body);
}

async function ensureStorageReady() {
  if (useR2) {
    // 确保 history 存在
    const hist = await r2Get(HISTORY_KEY);
    if (!hist) await r2Put(HISTORY_KEY, Buffer.from('[]', 'utf8'), 'application/json');
    return;
  }
  ensureLocalDirs();
  const hp = localHistoryPath();
  if (!fs.existsSync(hp)) fs.writeFileSync(hp, '[]', 'utf8');
}

async function readHistoryStore() {
  await ensureStorageReady();
  const raw = await readJsonKey(HISTORY_KEY, localHistoryPath(), []);
  return Array.isArray(raw) ? raw : [];
}

async function writeHistoryStore(list) {
  await ensureStorageReady();
  return withHistoryLock(async () => {
    await writeJsonKey(HISTORY_KEY, localHistoryPath(), Array.isArray(list) ? list : []);
  });
}

async function readModelsRaw() {
  await ensureStorageReady();
  const raw = await readJsonKey(MODELS_KEY, localModelsPath(), null);
  return raw && typeof raw === 'object' ? raw : null;
}

async function writeModelsRaw(obj) {
  await ensureStorageReady();
  await writeJsonKey(MODELS_KEY, localModelsPath(), obj || {});
}

// ---- 图片文件 ----
function fileObjectKey(recordId, fileName) {
  const id = String(recordId).replace(/[^a-zA-Z0-9_-]/g, '');
  const name = path.basename(String(fileName));
  return `files/${id}/${name}`;
}

async function putFileBuffer(recordId, fileName, buffer, contentType) {
  const safeName = path.basename(String(fileName));
  if (useR2) {
    await r2Put(fileObjectKey(recordId, safeName), buffer, contentType || guessMime(safeName));
    return safeName;
  }
  ensureLocalDirs();
  const dir = path.join(FILES_DIR, String(recordId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safeName), buffer);
  return safeName;
}

async function getFileBuffer(recordId, fileName) {
  const safeName = path.basename(String(fileName));
  if (useR2) {
    return r2Get(fileObjectKey(recordId, safeName));
  }
  const fp = localFilePath(recordId, safeName);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return null;
  return fs.readFileSync(fp);
}

async function deleteRecordFiles(recordId) {
  const id = String(recordId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return;
  if (useR2) {
    const keys = await r2ListPrefix(`files/${id}/`);
    await Promise.all(keys.map((k) => r2Delete(k)));
    return;
  }
  const dir = path.join(FILES_DIR, id);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn('[storage] delete files failed', e.message);
  }
}

function guessMime(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

/** 将可读流写入 HTTP 响应（本地文件或 R2 buffer） */
async function pipeFileToResponse(res, recordId, fileName, headers) {
  const safeId = String(recordId).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeName = path.basename(String(fileName));
  if (!safeId || !safeName || safeName.includes('..')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (useR2) {
    const buf = await getFileBuffer(safeId, safeName);
    if (!buf) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': headers['Content-Type'] || guessMime(safeName),
      'Content-Length': buf.length,
    });
    return res.end(buf);
  }

  const dir = path.resolve(FILES_DIR, safeId);
  const fp = path.resolve(dir, safeName);
  if (!fp.startsWith(dir + path.sep) && fp !== dir) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    return res.end('Not Found');
  }
  const ext = path.extname(fp).toLowerCase();
  const MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  res.writeHead(200, {
    ...headers,
    'Content-Type': headers['Content-Type'] || MIME[ext] || 'application/octet-stream',
  });
  fs.createReadStream(fp).pipe(res);
}

module.exports = {
  DATA_DIR,
  FILES_DIR,
  useR2,
  storageMode,
  storageInfo,
  ensureStorageReady,
  readHistoryStore,
  writeHistoryStore,
  readModelsRaw,
  writeModelsRaw,
  putFileBuffer,
  getFileBuffer,
  deleteRecordFiles,
  pipeFileToResponse,
  guessMime,
  fileObjectKey,
};
