# 部署到 Render（5 分钟）

代码仓库：https://github.com/mahuanjie6-commits/banana

## 步骤

1. 打开 https://dashboard.render.com/ 并登录  
2. 点击 **New +** → **Blueprint**（或 **Web Service**）

### 方式一：Blueprint（推荐，已含 render.yaml）

3. 连接 GitHub，选择仓库 **mahuanjie6-commits/banana**  
4. 分支选 **main**，Blueprint 文件为根目录 `render.yaml`  
5. 出现环境变量 **JWMP_API_KEY** 时，填入你的密钥（本地 `.env` 里那一行，不要提交到 Git）  
6. 点击 **Apply** / **Deploy Blueprint**  
7. 等待 Deploy 成功（首次免费实例可能要 2–5 分钟）  
8. 打开服务生成的地址，例如 `https://banana-xxxx.onrender.com`  
9. 访问 `https://你的域名/api/health`，应返回 `"ok": true`

### 方式二：手动 Web Service

3. **New +** → **Web Service** → 连接 **banana** 仓库  
4. 填写：

| 项 | 值 |
|----|-----|
| Name | banana |
| Region | Singapore（或离你近的） |
| Runtime | Node |
| Branch | main |
| Build Command | `npm run build` |
| Start Command | `node server.js` |
| Instance Type | Free |

5. **Environment** 添加：

| Key | Value |
|-----|--------|
| `JWMP_API_KEY` | （你的密钥） |
| `JWMP_BASE_URL` | `https://kwjm.com` |
| `NODE_VERSION` | `20.18.0` |

6. **Create Web Service** → 等绿色 Live

## 注意

- 免费实例约 **15 分钟无访问会休眠**，下次打开需等 30–60 秒唤醒  
- **不要**把 `.env` 推到 GitHub（已在 `.gitignore`）

## 生成数据被清空？——用 Cloudflare R2（推荐，可免费）

### 原因

历史与图片默认写在服务器本机磁盘。  
**Render Free 磁盘是临时的**，Redeploy / 重启会清空。

### 推荐：Cloudflare R2（Free 实例也够用）

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **R2** → 创建桶，例如 `banana-data`  
2. **Manage R2 API Tokens** → 创建 Token（需对象读/写权限）  
3. 记下 **Account ID**、**Access Key ID**、**Secret Access Key**  
4. Render 服务 **Environment** 添加：

| Key | Value |
|-----|--------|
| `R2_ACCOUNT_ID` | Cloudflare 账户 ID |
| `R2_ACCESS_KEY_ID` | API Token Access Key |
| `R2_SECRET_ACCESS_KEY` | API Token Secret |
| `R2_BUCKET` | `banana-data`（你的桶名） |

5. **Manual Deploy** 一次  
6. 打开 `/api/health`，应看到：  
   - `"storage": "r2"`  
   - `"persistentHint": "using Cloudflare R2..."`  

之后重部署 **不会丢** 历史和图片（数据在 R2）。

### 备选：Render 付费挂盘

Starter + Disk + `DATA_DIR=/var/data`（不配 R2 时）。见平台文档。

### 本地开发

不配 `R2_*` 时仍用 `./data/`，本机正常。
