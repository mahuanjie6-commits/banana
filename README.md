# Banana · AI 图像生成

基于 JWMP 网关接入 `gemini-3-pro-image-preview`。

## 快速开始

1. 复制环境变量并填写密钥：

```bat
copy .env.example .env
```

编辑 `.env`：

```env
JWMP_API_KEY=你的密钥
JWMP_BASE_URL=https://kwjm.com
PORT=3780
```

2. 启动服务：

```bat
npm start
```

或双击 `start.bat`。

3. 浏览器打开：http://localhost:3780/

## 接口

| 路径 | 说明 |
|------|------|
| `GET /api/health` | 健康检查（是否配置 Key） |
| `POST /api/generate` | 生图代理 |

请求示例：

```json
{
  "prompt": "一只绿色像素小龙",
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "images": [
    { "data": "data:image/png;base64,...", "mimeType": "image/png" }
  ]
}
```

## 本地持久化

生成成功的图片与历史会写入数据目录（默认项目下 `data/`，可用环境变量 `DATA_DIR` 覆盖）：

```
data/   或  $DATA_DIR/
  history.json          # 元数据（提示词、模型、时间等）
  files/{记录id}/       # 结果图与参考图文件
  models-config.json    # 配置页模型映射
```

本机重启后历史可恢复。删除资产会同时删掉对应文件。

> **部署到 Render 等平台时**：Free 实例磁盘通常是临时的。  
> **推荐配置 Cloudflare R2**（环境变量 `R2_*`），重启不丢数据；详见 `DEPLOY-RENDER.md`。
## 注意

- **不要**直接双击打开 `index.html`，必须通过本地服务访问，否则无法调用接口。
- API Key 只放在服务端 `.env`，不要写进前端代码。
- 请用 `start.bat` 或 `npm start` 启动，并保持窗口不要关。

## 为什么 Netlify 会显示「未连接本地服务」

本项目是 **前端页面 + Node 后端** 一体架构：

| 能力 | 负责文件 | Netlify 静态托管 |
|------|----------|------------------|
| UI 页面 | `index.html` | ✅ 可以 |
| 生图代理 `/api/generate` | `server.js` | ❌ 不会跑 |
| 历史 / 文件 `/api/history`、`/api/files` | `server.js` + `data/` | ❌ 不会跑 |
| API Key | 服务端环境变量 | 不能写进前端 |

只把仓库丢到 [Netlify](https://app.netlify.com/) 时，浏览器会请求同域的 `/api/health`，但没有后端 → 出现顶部黑条提示。

### 推荐方案 A：整站部署到能跑 Node 的平台（最简单）

用 **Render / Railway / Fly.io / 云主机** 部署整个项目（不要只传 `index.html`）。

以 [Render](https://render.com/) 为例：

1. New → Web Service → 连接本仓库  
2. **Runtime**: Node  
3. **Build Command**: 留空或 `echo skip`  
4. **Start Command**: `node server.js`  
5. Environment 添加：
   - `JWMP_API_KEY` = 你的密钥  
   - `JWMP_BASE_URL` = `https://kwjm.com`（可选）  
   - `PORT` 一般由平台自动注入，代码已支持  
6. 部署完成后打开 Render 给你的 `https://xxx.onrender.com`  

这样页面和 API 同源，**不需要 Netlify**。

### 方案 B：Netlify 前端 + 独立后端

1. 按方案 A 把 `server.js` 部署到 Render 等，得到后端地址，例如 `https://banana-api.onrender.com`  
2. 编辑仓库根目录 `config.js`：

```js
window.BANANA_API_BASE = 'https://banana-api.onrender.com';
```

3. 再把前端（含 `index.html`、`config.js`）部署到 Netlify  
4. 打开站点后应能连上后端；也可临时用查询参数测试：

```
https://你的站点.netlify.app/?api=https://banana-api.onrender.com
```

后端已开启 CORS（`Access-Control-Allow-Origin: *`），允许跨域调用。

### 不推荐

- **仅 Netlify Functions 改写整站**：生图耗时长、图片要落盘，和当前 `data/` 文件存储不匹配，改动量大。  
- **把 `JWMP_API_KEY` 写进前端**：密钥会泄露。

### 云端注意

免费实例磁盘多为**临时盘**，重新部署后 `data/` 历史可能清空；需要持久化请挂卷或改对象存储。
