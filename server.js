/**
 * Banana 本地服务：静态页面 + JWMP Gemini 生图代理
 * 启动: 配置 .env 后执行 npm start
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---- 读取 .env（不依赖 dotenv）----
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

// 必须在 loadEnv 之后再加载，才能读到 .env 里的 R2_* / DATA_DIR
const storage = require('./storage');

const PORT = Number(process.env.PORT || 3780);
const BASE_URL = (process.env.JWMP_BASE_URL || 'https://kwjm.com').replace(/\/$/, '');
const RAW_KEY = process.env.JWMP_API_KEY || process.env.API_KEY || '';
const PLACEHOLDER_KEYS = new Set(['', 'sk-xxxxxxxx', 'YOUR_API_KEY', 'your_api_key', 'changeme']);
const API_KEY = PLACEHOLDER_KEYS.has(RAW_KEY.trim()) ? '' : RAW_KEY.trim();

/**
 * UI 模型档位 → 上游真实模型（可在「配置」页自定义，持久化到 data/models-config.json）
 * 默认值也可通过环境变量 JWMP_MODEL_NANO / NANO2 / PRO 覆盖
 */
const DEFAULT_UI_MODEL = 'pro';
const UI_MODEL_KEYS = ['nano', 'nano2', 'pro'];

const DEFAULT_MODEL_CONFIG = {
  nano: {
    id: (process.env.JWMP_MODEL_NANO || 'gemini-2.5-flash-image').trim(),
    label: 'Nano Banana',
    price: '0.2元/张',
    supportsImageSize: false, // 2.5 不支持 imageSize，仅 aspectRatio
    maxImages: 3,
  },
  nano2: {
    id: (process.env.JWMP_MODEL_NANO2 || 'gemini-3.1-flash-image-preview-hq').trim(),
    label: 'Nano Banana 2',
    price: '0.4元/张',
    supportsImageSize: true,
    maxImages: 14,
  },
  pro: {
    id: (process.env.JWMP_MODEL_PRO || 'gemini-3-pro-image-preview-hq').trim(),
    label: 'Nano Banana Pro',
    price: '0.8元/张',
    supportsImageSize: true,
    maxImages: 14,
  },
};

// ---- 持久化：本地 DATA_DIR 或 Cloudflare R2（见 storage.js）----
const DATA_DIR = storage.DATA_DIR;

function cloneDefaultModelConfig() {
  const out = {};
  for (const key of UI_MODEL_KEYS) {
    out[key] = { ...DEFAULT_MODEL_CONFIG[key] };
  }
  return out;
}

/** 读取模型配置；文件缺失/损坏时回退默认值 */
async function readModelConfig() {
  const base = cloneDefaultModelConfig();
  try {
    await storage.ensureStorageReady();
    const raw = await storage.readModelsRaw();
    if (!raw || typeof raw !== 'object') return base;
    for (const key of UI_MODEL_KEYS) {
      const item = raw[key];
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || item.model || item.value || '').trim();
      if (id) base[key].id = id;
    }
  } catch (e) {
    console.warn('[model-config] read failed:', e.message);
  }
  return base;
}

async function writeModelConfig(partial) {
  const current = await readModelConfig();
  for (const key of UI_MODEL_KEYS) {
    const item = partial && partial[key];
    if (!item) continue;
    const id = String(item.id || item.model || item.value || '').trim();
    if (!id) {
      const err = new Error(`${current[key].label} 的模型值不能为空`);
      err.status = 400;
      throw err;
    }
    if (id.length > 200) {
      const err = new Error(`${current[key].label} 的模型值过长`);
      err.status = 400;
      throw err;
    }
    current[key].id = id;
  }
  const toSave = {};
  for (const key of UI_MODEL_KEYS) {
    toSave[key] = { id: current[key].id };
  }
  await storage.writeModelsRaw(toSave);
  return current;
}

/** 根据当前配置构建 MODEL_MAP（含上游 id 别名） */
function buildModelMap(cfg) {
  const config = cfg;
  const map = {};
  for (const key of UI_MODEL_KEYS) {
    const meta = {
      id: config[key].id,
      label: config[key].label,
      price: config[key].price,
      supportsImageSize: config[key].supportsImageSize,
      maxImages: config[key].maxImages,
      uiKey: key,
    };
    map[key] = meta;
    if (meta.id) map[meta.id] = meta;
  }
  const proId = config.pro.id;
  map['gemini-3-pro-image-preview'] = map.pro;
  map['gemini-3-pro-image-preview-hq'] = map.pro;
  if (proId) map[proId] = map.pro;
  map['gemini-3.1-flash-image-preview'] = map.nano2;
  map['gemini-3.1-flash-image-preview-hq'] = map.nano2;
  map['gemini-2.5-flash-image'] = map.nano;
  return map;
}

async function getModelMap() {
  return buildModelMap(await readModelConfig());
}

async function listModelConfigForApi() {
  const cfg = await readModelConfig();
  return UI_MODEL_KEYS.map((key, index) => ({
    id: index + 1,
    key,
    label: cfg[key].label,
    price: cfg[key].price,
    displayName: `${cfg[key].label}（${cfg[key].price}）`,
    value: cfg[key].id,
    model: cfg[key].id,
    supportsImageSize: cfg[key].supportsImageSize,
    maxImages: cfg[key].maxImages,
  }));
}

async function handleGetModelConfig(req, res) {
  const cfg = await readModelConfig();
  return sendJson(res, 200, {
    ok: true,
    models: await listModelConfigForApi(),
    map: Object.fromEntries(
      UI_MODEL_KEYS.map((k) => [
        k,
        { id: cfg[k].id, label: cfg[k].label, price: cfg[k].price, supportsImageSize: cfg[k].supportsImageSize },
      ])
    ),
  });
}

async function handleSaveModelConfig(req, res) {
  try {
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: '无效的 JSON 请求体' });
    }
    let partial = {};
    if (Array.isArray(body.models)) {
      for (const row of body.models) {
        const key = row.key || row.uiKey;
        if (!UI_MODEL_KEYS.includes(key)) continue;
        partial[key] = { id: row.value || row.model || row.id };
      }
    } else {
      for (const key of UI_MODEL_KEYS) {
        if (body[key] != null) {
          const v = body[key];
          partial[key] = typeof v === 'string' ? { id: v } : { id: v.id || v.model || v.value };
        }
      }
    }
    if (!Object.keys(partial).length) {
      return sendJson(res, 400, { ok: false, error: '请提供要更新的模型配置' });
    }
    const saved = await writeModelConfig(partial);
    console.log('[model-config] saved', Object.fromEntries(UI_MODEL_KEYS.map((k) => [k, saved[k].id])));
    return sendJson(res, 200, {
      ok: true,
      models: await listModelConfigForApi(),
      map: Object.fromEntries(
        UI_MODEL_KEYS.map((k) => [k, { id: saved[k].id, label: saved[k].label, price: saved[k].price }])
      ),
    });
  } catch (e) {
    return sendJson(res, e.status || 500, { ok: false, error: e.message || '保存失败' });
  }
}

async function readHistoryStore() {
  return storage.readHistoryStore();
}

async function writeHistoryStore(list) {
  return storage.writeHistoryStore(list);
}

function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  return 'png';
}

/** 本地时间字符串 yyyy-MM-dd HH:mm:ss（勿用 toISOString，那是 UTC 会差 8 小时） */
function formatLocalDateTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 从 /api/files/{id}/{file} 或完整 URL 读取已存图片，返回 base64
 * 用于「重新编辑」场景
 */
async function loadLocalFileAsBase64(raw) {
  try {
    let s = String(raw || '').trim();
    s = s.split('?')[0].split('#')[0];
    const abs = s.match(/^https?:\/\/[^/]+(\/api\/files\/.+)$/i);
    if (abs) s = abs[1];
    if (s.startsWith('api/files/')) s = '/' + s;
    const m = s.match(/^\/api\/files\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const id = decodeURIComponent(m[1]).replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = path.basename(decodeURIComponent(m[2]));
    if (!id || !fileName || fileName.includes('..')) return null;
    const buf = await storage.getFileBuffer(id, fileName);
    if (!buf) return null;
    const ext = path.extname(fileName).toLowerCase();
    let mimeType = 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.gif') mimeType = 'image/gif';
    return { base64: buf.toString('base64'), mimeType };
  } catch (e) {
    console.warn('[loadLocalFileAsBase64]', e.message);
    return null;
  }
}

function parseDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (m) return { mimeType: m[1], base64: m[2] };
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 64) {
    return { mimeType: 'image/png', base64: s.replace(/\s/g, '') };
  }
  return null;
}

async function saveDataUrlAsFile(recordId, fileNameBase, dataUrl, mimeHint) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  const ext = mimeToExt(parsed.mimeType || mimeHint);
  const fileName = `${fileNameBase}.${ext}`;
  const buf = Buffer.from(parsed.base64, 'base64');
  return storage.putFileBuffer(recordId, fileName, buf, parsed.mimeType || mimeHint);
}

function enrichHistoryItem(item) {
  if (!item) return item;
  const id = item.id;
  const imageFiles = item.imageFiles || [];
  const refFiles = item.refFiles || [];
  const images = imageFiles.map((f, i) => ({
    mimeType: f.endsWith('.png') ? 'image/png' : 'image/jpeg',
    dataUrl: `/api/files/${id}/${encodeURIComponent(f)}`,
    file: f,
    index: i,
  }));
  const refImages = refFiles.map((f) => `/api/files/${id}/${encodeURIComponent(f)}`);
  return {
    ...item,
    imageUrl: images[0]?.dataUrl || item.imageUrl || '',
    images,
    refImages,
    bg: item.bg || (images.length ? 'bg-real' : item.bg),
    art: images.length ? null : item.art,
    inHistory: item.inHistory !== false,
  };
}

async function persistGenerateResult({ body, modelMeta, images, texts, upstream }) {
  const id = Date.now();
  const imageFiles = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const name = await saveDataUrlAsFile(id, String(i), img.dataUrl, img.mimeType);
    if (name) imageFiles.push(name);
  }

  const refFiles = [];
  const refs = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  for (let i = 0; i < refs.length; i++) {
    const img = refs[i];
    if (!img.data) continue;
    const name = await saveDataUrlAsFile(id, `ref-${i}`, img.data, img.mimeType);
    if (name) refFiles.push(name);
  }

  const record = {
    id,
    type: 'image',
    prompt: String(body.prompt || '').trim() || '（参考图生成）',
    model: body.model || DEFAULT_UI_MODEL,
    ratio: body.aspectRatio && body.aspectRatio !== 'auto' ? body.aspectRatio : (body.ratio || '1:1'),
    res: body.imageSize || body.res || '1K',
    time: formatLocalDateTime(),
    user: body.user || '马焕杰',
    dept: body.dept || '技术部',
    source: 'banana',
    fav: false,
    featured: false,
    apiModel: modelMeta.id,
    modelVersion: upstream?.modelVersion || modelMeta.id,
    replyText: '',
    responseId: upstream?.responseId || '',
    usageMetadata: upstream?.usageMetadata || null,
    imageFiles,
    refFiles,
    inHistory: true,
    persisted: true,
  };

  const list = await readHistoryStore();
  list.unshift(record);
  if (list.length > 500) list.length = 500;
  await writeHistoryStore(list);
  return enrichHistoryItem(record);
}

async function persistFailRecord({ body, error }) {
  const id = Date.now();
  const refFiles = [];
  const refs = Array.isArray(body?.images) ? body.images.slice(0, 6) : [];
  for (let i = 0; i < refs.length; i++) {
    const img = refs[i];
    if (!img?.data) continue;
    const name = await saveDataUrlAsFile(id, `ref-${i}`, img.data, img.mimeType);
    if (name) refFiles.push(name);
  }

  const record = {
    id,
    type: 'fail',
    prompt: String(body?.prompt || '').trim(),
    model: body?.model || DEFAULT_UI_MODEL,
    ratio: body?.aspectRatio || body?.ratio || '',
    res: body?.imageSize || body?.res || '',
    time: formatLocalDateTime(),
    user: body?.user || '马焕杰',
    dept: body?.dept || '技术部',
    source: 'banana',
    error: String(error || '生成失败'),
    imageFiles: [],
    refFiles,
    inHistory: true,
    persisted: true,
  };
  const list = await readHistoryStore();
  list.unshift(record);
  if (list.length > 500) list.length = 500;
  await writeHistoryStore(list);
  return enrichHistoryItem(record);
}

async function updateHistoryRecord(id, patch) {
  const list = await readHistoryStore();
  const idx = list.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return null;
  const allowed = ['fav', 'featured', 'prompt'];
  const next = { ...list[idx] };
  for (const k of allowed) {
    if (k in patch) next[k] = patch[k];
  }
  list[idx] = next;
  await writeHistoryStore(list);
  return enrichHistoryItem(next);
}

async function deleteHistoryRecord(id) {
  const list = await readHistoryStore();
  const idx = list.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return false;
  list.splice(idx, 1);
  await writeHistoryStore(list);
  await storage.deleteRecordFiles(id);
  return true;
}

async function resolveModel(input) {
  const key = String(input || DEFAULT_UI_MODEL).trim();
  const MODEL_MAP = await getModelMap();
  const meta = MODEL_MAP[key] || MODEL_MAP[DEFAULT_UI_MODEL];
  const uiKey = meta.uiKey || (UI_MODEL_KEYS.includes(key) ? key : DEFAULT_UI_MODEL);
  const id = meta.id;
  return {
    id,
    label: meta.label,
    price: meta.price,
    supportsImageSize: resolveSupportsImageSize(uiKey, id),
    maxImages: meta.maxImages,
    uiKey,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const ALLOWED_RATIOS = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);
/** Gemini 官方 imageConfig.imageSize：大写 K；3.1 另支持 512，本产品 UI 仅暴露 1K/2K/4K */
const ALLOWED_SIZES = new Set(['1K', '2K', '4K', '512']);

/**
 * 规范化分辨率传参
 * - 去空格、统一大写 K（2k → 2K）
 * - 非法值回退 1K
 */
function normalizeImageSize(raw) {
  let s = String(raw || '').trim();
  if (!s) return '1K';
  // 兼容 2k / 2K / 2 k / 2048 等
  s = s.replace(/\s+/g, '');
  const lower = s.toLowerCase();
  if (lower === '1k' || lower === '1024') return '1K';
  if (lower === '2k' || lower === '2048') return '2K';
  if (lower === '4k' || lower === '4096') return '4K';
  if (lower === '512' || lower === '0.5k' || lower === '512px') return '512';
  // 已是标准写法
  if (ALLOWED_SIZES.has(s)) return s;
  // 1k 这种混写
  const m = s.match(/^([124])k$/i);
  if (m) return `${m[1]}K`;
  return '1K';
}

/**
 * 是否应向上游传 imageConfig.imageSize
 * 以实际上游 model id 为准，避免配置页换模型后仍用档位默认
 *
 * - gemini-2.5-flash-image*：不支持 imageSize（仅 aspectRatio）
 * - gemini-3.1-flash-image* / gemini-3-pro-image*：支持 1K/2K/4K
 */
function resolveSupportsImageSize(uiKey, modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return Boolean(DEFAULT_MODEL_CONFIG[uiKey]?.supportsImageSize);

  // 2.5 图像模型：不支持 imageSize
  if (id.includes('2.5') && id.includes('image')) return false;
  if (id.includes('gemini-2.5')) return false;

  // 3.1 Flash Image / 3 Pro Image 系列：支持
  if (
    id.includes('3.1-flash-image') ||
    id.includes('flash-image-preview') ||
    id.includes('pro-image-preview') ||
    id.includes('pro-image') ||
    (id.includes('flash-image') && !id.includes('2.5'))
  ) {
    return true;
  }

  // 回退：按 UI 档位
  return Boolean(DEFAULT_MODEL_CONFIG[uiKey]?.supportsImageSize);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const max = 40 * 1024 * 1024; // 40MB（多图 base64）
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function proxyGenerate(modelId, payload) {
  return new Promise((resolve, reject) => {
    const apiPath = `/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
    const url = new URL(BASE_URL + apiPath);
    console.log(`[generate] → ${url.href}`);
    const data = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Accept: 'application/json',
        },
        timeout: 360000,
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({ status: resp.statusCode || 500, data: json, raw, modelId, apiPath });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('上游请求超时（360s）'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function buildPayload(body, modelMeta) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt && !(body.images && body.images.length)) {
    const err = new Error('请输入提示词或上传参考图');
    err.status = 400;
    throw err;
  }

  const parts = [];
  const maxImages = modelMeta.maxImages || 14;

  // 参考图：优先 inlineData（前端 base64）；兼容 /api/files/... 本地路径
  const images = Array.isArray(body.images) ? body.images : [];
  for (const img of images.slice(0, maxImages)) {
    if (img.data) {
      let data = String(img.data).trim();
      let mimeType = img.mimeType || 'image/png';

      // dataURL
      const m = data.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        mimeType = m[1] || mimeType;
        data = m[2];
      } else if (
        data.startsWith('/api/files/') ||
        data.startsWith('api/files/') ||
        /^https?:\/\/[^/]+\/api\/files\//i.test(data)
      ) {
        // 重新编辑场景：前端可能直接传 /api/files URL
        const resolved = await loadLocalFileAsBase64(data);
        if (!resolved) {
          const err = new Error('参考图文件不存在或无法读取，请重新上传');
          err.status = 400;
          throw err;
        }
        mimeType = resolved.mimeType || mimeType;
        data = resolved.base64;
      } else if (data.includes('/') || data.includes('\\') || data.startsWith('http')) {
        // 非 base64 的路径/URL，拒绝以免上游报 Base64 decoding failed
        const err = new Error('参考图格式无效（需要 base64 或本地 /api/files 路径）');
        err.status = 400;
        throw err;
      }
      // 粗校验：纯 base64 才继续
      if (!/^[A-Za-z0-9+/=\s]+$/.test(data) || data.length < 32) {
        const err = new Error('参考图 Base64 无效，请重新上传图片后再试');
        err.status = 400;
        throw err;
      }
      parts.push({
        inlineData: {
          mimeType,
          data: data.replace(/\s/g, ''),
        },
      });
    } else if (img.fileUri) {
      parts.push({
        fileData: {
          mimeType: img.mimeType || 'image/png',
          fileUri: img.fileUri,
        },
      });
    }
  }

  if (prompt) {
    parts.push({ text: prompt });
  } else {
    parts.push({ text: '根据参考图生成高质量图片' });
  }

  const imageConfig = {};
  let ratio = body.aspectRatio || body.ratio;
  if (ratio && ratio !== 'auto' && ALLOWED_RATIOS.has(ratio)) {
    imageConfig.aspectRatio = ratio;
  }

  // imageSize：官方 REST 字段 generationConfig.imageConfig.imageSize
  // 取值必须为 "1K" | "2K" | "4K"（3.1 另支持 "512"）；大小写敏感，K 为大写
  const supportsSize = modelMeta.supportsImageSize !== false
    ? resolveSupportsImageSize(modelMeta.uiKey, modelMeta.id)
    : false;
  let normalizedSize = null;
  if (supportsSize) {
    normalizedSize = normalizeImageSize(body.imageSize || body.res || '1K');
    // 产品 UI 不暴露 512 时，仍允许显式传入；默认回退 1K
    if (!ALLOWED_SIZES.has(normalizedSize)) normalizedSize = '1K';
    imageConfig.imageSize = normalizedSize;
  }

  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
  };
  if (Object.keys(imageConfig).length) {
    generationConfig.imageConfig = imageConfig;
  }
  if (typeof body.temperature === 'number') {
    generationConfig.temperature = Math.min(1, Math.max(0, body.temperature));
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig,
  };

  // 便于核对各模型传参
  console.log(
    `[payload] model=${modelMeta.id} ui=${modelMeta.uiKey || '-'} ` +
      `supportsImageSize=${supportsSize} ` +
      `imageConfig=${JSON.stringify(imageConfig)} ` +
      `refs=${parts.filter((p) => p.inlineData).length}`
  );

  return payload;
}

function extractImages(apiResp) {
  const images = [];
  const texts = [];
  const candidates = apiResp?.candidates || [];
  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      if (p.inlineData?.data) {
        const mime = p.inlineData.mimeType || 'image/jpeg';
        images.push({
          mimeType: mime,
          dataUrl: `data:${mime};base64,${p.inlineData.data}`,
          // 前端展示用 dataUrl 即可；不回传超大纯 base64 字段重复
        });
      }
      if (p.text) texts.push(p.text);
    }
  }
  return { images, texts };
}

/**
 * 进行中的生成请求指纹（防前端双发）。
 * 用 Map 记录开始时间：请求结束后立即释放；异常卡住时按 TTL 自动过期，避免一直「重复提交」。
 */
const inflightGenerates = new Map(); // fp -> startedAt(ms)
/** 最长占用（需 ≥ 上游 timeout 360s，否则长图会误判可重入） */
const INFLIGHT_TTL_MS = 6 * 60 * 1000;

function generateFingerprint(body) {
  const prompt = String(body?.prompt || '').trim();
  const model = String(body?.model || body?.uiModel || '');
  const ratio = String(body?.aspectRatio || body?.ratio || '');
  const size = String(body?.imageSize || body?.res || '');
  const imgs = Array.isArray(body?.images) ? body.images : [];
  // 用参考图数量 + 每张 data 长度做轻量指纹（避免整段 base64 进 Set）
  const refSig = imgs
    .slice(0, 6)
    .map((img) => {
      const d = String(img?.data || img?.fileUri || '');
      return `${d.length}:${d.slice(0, 24)}`;
    })
    .join('|');
  return `${model}|${ratio}|${size}|${prompt}|${imgs.length}|${refSig}`;
}

function pruneInflightLocks() {
  const now = Date.now();
  for (const [key, startedAt] of inflightGenerates) {
    if (now - startedAt > INFLIGHT_TTL_MS) {
      inflightGenerates.delete(key);
      console.warn(`[generate] expired stale inflight lock age=${Math.round((now - startedAt) / 1000)}s`);
    }
  }
}

async function handleGenerate(req, res) {
  if (!API_KEY) {
    return sendJson(res, 500, {
      ok: false,
      error: '未配置 JWMP_API_KEY，请在项目目录创建 .env 并填入密钥',
    });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求 JSON 无效: ' + e.message });
  }

  pruneInflightLocks();
  const fp = generateFingerprint(body);
  const prevStarted = inflightGenerates.get(fp);
  if (prevStarted) {
    const elapsedSec = Math.max(1, Math.round((Date.now() - prevStarted) / 1000));
    const retryAfterSec = Math.max(1, Math.ceil((INFLIGHT_TTL_MS - (Date.now() - prevStarted)) / 1000));
    console.warn(
      `[generate] reject duplicate in-flight request elapsed=${elapsedSec}s fp=${fp.slice(0, 80)}…`
    );
    return sendJson(res, 429, {
      ok: false,
      error: `相同内容正在生成中（已进行 ${elapsedSec} 秒），请稍候，勿重复点击`,
      duplicate: true,
      elapsedSec,
      retryAfterSec,
    });
  }
  inflightGenerates.set(fp, Date.now());

  const modelMeta = await resolveModel(body.model || body.uiModel || DEFAULT_UI_MODEL);
  const reqSize = normalizeImageSize(body.imageSize || body.res || '1K');
  console.log(
    `[generate] uiModel=${body.model || DEFAULT_UI_MODEL} → upstream=${modelMeta.id} ` +
      `req.imageSize=${body.imageSize || body.res || ''} → ${reqSize} ` +
      `supportsImageSize=${modelMeta.supportsImageSize}`
  );

  let payload;
  try {
    payload = await buildPayload(body, modelMeta);
  } catch (e) {
    inflightGenerates.delete(fp);
    return sendJson(res, e.status || 400, { ok: false, error: e.message });
  }

  try {
    const upstream = await proxyGenerate(modelMeta.id, payload);
    if (upstream.status < 200 || upstream.status >= 300) {
      const msg =
        upstream.data?.error?.message ||
        upstream.data?.message ||
        upstream.data?.error ||
        (typeof upstream.data === 'string' ? upstream.data : null) ||
        upstream.raw?.slice(0, 300) ||
        `上游错误 HTTP ${upstream.status}`;
      console.error(`[generate] fail model=${modelMeta.id} status=${upstream.status} msg=${msg}`);
      let fail = null;
      try {
        fail = await persistFailRecord({ body, error: String(msg) });
      } catch (_) { /* ignore */ }
      return sendJson(res, upstream.status === 401 || upstream.status === 403 ? upstream.status : 502, {
        ok: false,
        error: String(msg),
        status: upstream.status,
        model: modelMeta.id,
        requestedPath: `/v1beta/models/${modelMeta.id}:generateContent`,
        uiModel: modelMeta.label,
        detail: upstream.data,
        record: fail,
      });
    }

    const { images, texts } = extractImages(upstream.data);
    if (!images.length) {
      const finish = upstream.data?.candidates?.[0]?.finishReason;
      const errMsg = texts.join('\n') || `未返回图片${finish ? '（finishReason: ' + finish + '）' : ''}`;
      const fail = await persistFailRecord({ body, error: errMsg });
      return sendJson(res, 502, {
        ok: false,
        error: errMsg,
        model: modelMeta.id,
        record: fail,
        detail: {
          finishReason: finish,
          texts,
          usageMetadata: upstream.data?.usageMetadata,
        },
      });
    }

    const record = await persistGenerateResult({
      body,
      modelMeta,
      images,
      texts,
      upstream: {
        modelVersion: upstream.data?.modelVersion || modelMeta.id,
        responseId: upstream.data?.responseId,
        usageMetadata: upstream.data?.usageMetadata,
      },
    });
    console.log(`[persist] saved id=${record.id} mode=${storage.storageMode()} files=${(record.imageFiles || []).join(',')}`);

    return sendJson(res, 200, {
      ok: true,
      images: record.images,
      texts,
      record,
      model: modelMeta.id,
      uiModel: body.model || DEFAULT_UI_MODEL,
      uiLabel: modelMeta.label,
      modelVersion: upstream.data?.modelVersion || modelMeta.id,
      responseId: upstream.data?.responseId,
      usageMetadata: upstream.data?.usageMetadata,
    });
  } catch (e) {
    const errMsg = '请求上游失败: ' + e.message;
    let fail = null;
    try {
      fail = await persistFailRecord({ body, error: errMsg });
    } catch (_) { /* ignore */ }
    return sendJson(res, 502, { ok: false, error: errMsg, record: fail });
  } finally {
    inflightGenerates.delete(fp);
  }
}

async function handleHistoryList(req, res) {
  const list = (await readHistoryStore()).map(enrichHistoryItem);
  return sendJson(res, 200, { ok: true, items: list, total: list.length });
}

async function handleHistoryPatch(req, res, id) {
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求 JSON 无效' });
  }
  const updated = await updateHistoryRecord(id, body);
  if (!updated) return sendJson(res, 404, { ok: false, error: '记录不存在' });
  return sendJson(res, 200, { ok: true, record: updated });
}

async function handleHistoryDelete(req, res, id) {
  const ok = await deleteHistoryRecord(id);
  if (!ok) return sendJson(res, 404, { ok: false, error: '记录不存在' });
  return sendJson(res, 200, { ok: true });
}

async function handleHistoryCreateFail(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: '请求 JSON 无效' });
  }
  const record = await persistFailRecord({ body, error: body.error || '生成失败' });
  return sendJson(res, 200, { ok: true, record });
}

async function serveHistoryFile(req, res, id, fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return storage.pipeFileToResponse(res, id, fileName, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // 安全：禁止路径穿越
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safe);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('Not Found');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
  const method = req.method || 'GET';
  const urlPath = req.url || '/';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    });
    return res.end();
  }

  if (method === 'GET' && (urlPath === '/api/health' || urlPath.startsWith('/api/health?'))) {
    const cfg = await readModelConfig();
    await storage.ensureStorageReady();
    let historyCount = 0;
    try {
      historyCount = (await readHistoryStore()).length;
    } catch (_) { /* ignore */ }
    const info = storage.storageInfo();
    const def = await resolveModel(DEFAULT_UI_MODEL);
    return sendJson(res, 200, {
      ok: true,
      baseUrl: BASE_URL,
      defaultModel: def.id,
      models: Object.fromEntries(
        UI_MODEL_KEYS.map((k) => [k, { id: cfg[k].id, label: cfg[k].label }])
      ),
      hasKey: Boolean(API_KEY),
      keyHint: API_KEY ? `${API_KEY.slice(0, 6)}…${API_KEY.slice(-4)}` : null,
      storage: info.mode,
      dataDir: info.dataDir,
      dataDirFromEnv: info.dataDirFromEnv,
      r2: info.r2,
      historyCount,
      persistentHint:
        info.mode === 'r2'
          ? 'using Cloudflare R2 (survives redeploy)'
          : info.dataDirFromEnv
            ? 'using DATA_DIR (expect persistent disk)'
            : 'default ./data (ephemeral on free PaaS without R2)',
    });
  }

  // 模型配置：读取 / 保存（配置页）
  if (urlPath === '/api/model-config' || urlPath.startsWith('/api/model-config?')) {
    if (method === 'GET') return await handleGetModelConfig(req, res);
    if (method === 'PUT' || method === 'POST') return await handleSaveModelConfig(req, res);
  }

  if (method === 'POST' && (urlPath === '/api/generate' || urlPath.startsWith('/api/generate?'))) {
    return await handleGenerate(req, res);
  }

  // 历史列表
  if (method === 'GET' && (urlPath === '/api/history' || urlPath.startsWith('/api/history?'))) {
    return await handleHistoryList(req, res);
  }

  // 保存失败记录（可选，生成失败时前端也可调）
  if (method === 'POST' && (urlPath === '/api/history/fail' || urlPath.startsWith('/api/history/fail?'))) {
    return await handleHistoryCreateFail(req, res);
  }

  // PATCH /api/history/:id  DELETE /api/history/:id
  const histMatch = urlPath.match(/^\/api\/history\/([^/?#]+)/);
  if (histMatch) {
    const id = decodeURIComponent(histMatch[1]);
    if (method === 'PATCH' || method === 'POST') return await handleHistoryPatch(req, res, id);
    if (method === 'DELETE') return await handleHistoryDelete(req, res, id);
  }

  // GET /api/files/:id/:file
  const fileMatch = urlPath.match(/^\/api\/files\/([^/]+)\/([^/?#]+)/);
  if (method === 'GET' && fileMatch) {
    return await serveHistoryFile(req, res, decodeURIComponent(fileMatch[1]), decodeURIComponent(fileMatch[2]));
  }

  if (method === 'GET') {
    return serveStatic(req, res, urlPath);
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' });
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: e.message || '服务器错误' });
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。请先关闭占用进程，或修改 .env 中的 PORT。\n`);
  } else {
    console.error('\n  服务启动失败:', err.message, '\n');
  }
  process.exit(1);
});

// 明确绑定所有网卡，避免只监听某些地址导致浏览器连不上
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ========================================');
  console.log('  Banana 服务已启动（请保持本窗口开启）');
  console.log('  ========================================');
  console.log(`  页面:     http://127.0.0.1:${PORT}/`);
  console.log(`  备选:     http://localhost:${PORT}/`);
  console.log(`  健康检查: http://127.0.0.1:${PORT}/api/health`);
  console.log(`  网关:     ${BASE_URL}`);
  (async () => {
    try {
      const bootCfg = await readModelConfig();
      console.log(`  默认:     Nano Banana Pro → ${bootCfg.pro.id}`);
      console.log(`  映射:     nano → ${bootCfg.nano.id}`);
      console.log(`           nano2 → ${bootCfg.nano2.id}`);
      console.log(`           pro → ${bootCfg.pro.id}`);
      console.log(`  API Key:  ${API_KEY ? '已配置' : '未配置（请创建 .env 填入 JWMP_API_KEY）'}`);
      await storage.ensureStorageReady();
      const n = (await readHistoryStore()).length;
      const info = storage.storageInfo();
      console.log(`  存储:     ${info.mode === 'r2' ? 'Cloudflare R2 ✓' : '本地磁盘'}`);
      if (info.mode === 'r2') {
        console.log(`  R2 桶:    ${info.r2.bucket}`);
      } else {
        console.log(`  数据目录: ${info.dataDir}${info.dataDirFromEnv ? ' (DATA_DIR)' : ' (默认，云上可能丢失)'}`);
      }
      console.log(`  历史记录: ${n} 条`);
    } catch (e) {
      console.error('  启动时读取存储失败:', e.message);
    }
    console.log('  ----------------------------------------');
    console.log('  关闭本窗口 = 停止服务，页面将无法访问');
    console.log('  ========================================');
    console.log('');
  })();
});
