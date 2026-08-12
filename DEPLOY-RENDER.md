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
- 磁盘为临时盘，**重新部署可能清空** `data/` 历史  
- **不要**把 `.env` 推到 GitHub（已在 `.gitignore`）
