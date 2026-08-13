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

## 生成数据被清空？——持久化说明

### 原因

历史与图片写在服务器磁盘的 `data/`（或 `DATA_DIR`）里。  
**Render Free 的磁盘是临时的**：每次 **Redeploy / 重启 / 休眠唤醒重建** 都可能清空，所以看起来「一更新数据就没了」。

### 解决办法（推荐）：挂载持久磁盘

1. 打开服务 **banana** → **Settings**  
2. 实例类型至少 **Starter**（Free **不支持** Persistent Disk）  
3. **Disks** → **Add Disk**：  
   - Name: `banana-data`  
   - Mount path: `/var/data`  
   - Size: `1 GB`（可按需加大）  
4. **Environment** 增加或修改：  

| Key | Value |
|-----|--------|
| `DATA_DIR` | `/var/data` |

5. **Manual Deploy** → 重新部署  
6. 打开 `/api/health`，确认：  
   - `"dataDir": "/var/data"`  
   - `"dataDirFromEnv": true`  

仓库里的 `render.yaml` 已按 **Starter + 1GB 盘 + DATA_DIR** 写好；用 Blueprint 同步或按上表在控制台改即可。

### 本地开发

不设 `DATA_DIR` 时仍用项目下 `./data/`，本机重启不会丢（除非你删了文件夹）。

### 仍用 Free 的局限

可以继续免费试用，但**无法保证**历史与图片在重部署后还在。只能接受数据临时性，或升级并挂盘。
