# 個人海水缸雲端設定

流程：管理密碼 → 首次匯入 → 自動同步 → GPT 唯讀。使用者不需要另行登入 Neon 或建立會員帳號。

## 部署架構

- 手機網站維持原本的 Render Static Site：`https://seawater-tank-mvp.onrender.com`，不搬家、不清除 Safari / PWA 儲存。
- 獨立 Vercel 後端：`reef-tank-cloud`，公開 API 為 `https://reef-tank-cloud.vercel.app`。
- 透過原本 Vercel 帳號的 Neon 整合建立免費資料庫 `reef-controller-db`，只連到海水缸專案，不修改遊戲庫。
- 前端公開設定為 `cloud-config.defaults.json`；部署環境的 `REEF_CLOUD_API_URL` 可覆寫網址。設定檔不含任何秘密。
- `vercel.json` 只部署 `api/index.js` 與必要模組，靜態輸出為 `cloud-public`，不對外提供私密檔案。

建立與部署後台不代表手機已匯入，也不代表專用 GPT Action 已設定完成。

## 手機首次使用

1. 先在原本保存紀錄的 iPhone 選「設定 → 下載備份」。不要改網址或清除瀏覽器資料。
2. 選「雲端資料同步」，輸入管理密碼，按「連線雲端資料庫」。管理密碼與 GPT Token 不同。
3. 核對「這台裝置」與「雲端資料庫」的魚缸、紀錄數量。
4. 雲端未初始化時，按「首次匯入」並確認。只使用保存原始資料的手機；空裝置不能初始化。
5. 之後儲存自動同步，重新開啟也會恢復尚未到期的管理連線。其他裝置輸入同一管理密碼後載入雲端。
6. 專用 GPT 的連接方式見 [GPT_CONNECTION.md](GPT_CONNECTION.md)。只會讀取最後成功同步的資料。

首次匯入必須由使用者確認。部署驗證不會向正式資料庫匯入測試魚缸，也不會代替手機執行匯入。

## 維護者設定

Vercel 後端的私密環境變數：

| 名稱 | 用途 |
| --- | --- |
| `DATABASE_URL` | Neon 整合自動提供，只給後端 |
| `REEF_ADMIN_TOKEN` | 手機管理密碼，至少 32 字元 |
| `REEF_GPT_READ_TOKEN` | 不同的隨機唯讀金鑰，至少 32 字元 |
| `REEF_APP_ORIGIN` | `https://seawater-tank-mvp.onrender.com` |
| `REEF_API_PUBLIC_URL` | `https://reef-tank-cloud.vercel.app` |

管理密碼、讀取金鑰保存在本機 `.env.local`，不可貼在聊天或加入 Git。`.env*`、`.vercel/` 都已被忽略。不要複製遊戲庫的密碼或資料庫連線字串。

Render 前端 Build Command 使用 `npm ci && npm run build`，Publish Directory 保持 `.`。不必新增 Render Web Service；`npm start` 留作 Node 後端的替代啟動方式。

本機與上線檢查：

```sh
npm ci
npm run build
vercel build --prod
npm run test:cloud-bundle
vercel deploy --prebuilt --prod
```

**打包檢查失敗時不可部署。** 既有引擎有瀏覽器版本查詢字串，API 入口明確引用原始引擎檔案以避免 server tracer 遺漏；不改動引擎的數值與安全規則。

## 資料與安全限制

- 一份個人資料庫，不是多人帳號系統；管理密碼持有者能讀寫全部魚缸。
- 手機不保存管理密碼，只保存七天有效、可撤銷的登入憑證。憑證位於瀏覽器儲存，不是 HttpOnly Cookie；不要在不信任的裝置登入。
- 登出撤銷伺服器憑證。離線登出只先清除本機憑證，伺服器憑證到期失效。更換管理密碼會使舊管理連線失效。
- 只有獨立 GPT 唯讀金鑰能呼叫資料 API；它不能登入管理介面或寫入資料。
- 首次匯入與更新採原子條件和 revision，舊版本不能默默覆蓋新資料；不自動合併衝突。
- 完整保存 TankStore，包括 archive、維護、滴定套用、餵食與添加物；安全分析仍只使用既有規則允許的資料。
- 有尚未儲存的測量或進行中的 SOP 時，不會載入雲端覆寫草稿。
- 離線、後端故障或同步失敗，本機資料仍保留，畫面不會宣稱同步成功。
- 登入採程序層級限流（每 15 分鐘最多 20 次）；serverless 擴展後不是全域持久限流，適用本階段高強度管理密碼的個人用途。
- 免費服務有其容量與使用限制，以實際方案為準。舊 Supabase 資料不會自動搬移或刪除。

測試使用本機 PGlite，不接正式 Neon。正式驗證只檢查健康、授權、唯讀與空資料保護，不會寫入假魚缸。

[Vercel 整合指令](https://vercel.com/docs/cli/integration)、[Vercel Node Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Neon 官方驅動](https://github.com/neondatabase/serverless)。
