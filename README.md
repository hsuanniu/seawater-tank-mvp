# 海水缸水質追蹤與滴定調整工具

這是一個單機版 MVP 網頁 App，用來記錄海水缸水質、滴定設定、維護狀態，並依保守規則產生下一週滴定調整建議。

## 功能

- 魚缸基本設定與自訂目標範圍
- 多魚缸切換
- 彈性目標輸入，例如 `8-9`、`0.25~2`、`400+/-20`、`1350 +/-30`
- 新增水質紀錄
- 滴定設定與暫停狀態
- 維護紀錄
- 規則型分析建議，含 LOW / NORMAL / HIGH / CRITICAL、測量間隔、每日變化與暫停滴定判斷
- KH / CA / MG 固定公式滴定建議與安全上限
- 手動套用滴定建議與套用紀錄追蹤
- 歷史紀錄
- 趨勢圖表
- 備份資料 / 還原資料
- PWA，可從手機瀏覽器加入主畫面
- 管理密碼登入與 Neon 雲端同步（選用）
- localStorage 單機儲存
- GPT 唯讀 API 與設定指引（需完成一次後台設定，再在專用 GPT 匯入 Action）

## 本機使用

先執行 `npm ci` 安裝測試與後端依賴。前端使用 ES modules，請透過本機 HTTP 伺服器開啟。

如果要用本機網址測試：

```bash
python3 -m http.server 4179
```

然後打開：

```text
http://localhost:4179
```

## 部署到 Render

這個專案是純 HTML / CSS / JavaScript 靜態網站，可以部署成 Render Static Site。

1. 建立 GitHub repository。
2. 將本資料夾內容推送到 GitHub。
3. 登入 Render。
4. 選擇 New → Static Site。
5. 連接你的 GitHub repository。
6. 如果 Render 讀到 `render.yaml`，可直接依設定部署。
7. 若手動設定：
   - Build Command：`npm ci && npm run build`
   - Publish Directory：`.`

部署完成後，Render 會提供一個 `onrender.com` 網址。

## 管理密碼雲端同步

若要像遊戲庫一樣讓 GPT 直接讀取資料，請依照 [雲端與 GPT 連接設定](GPT_CONNECTION.md)。入口位於「設定 → 雲端資料同步」。

與遊戲庫採同樣的個人管理流程：管理密碼 → 首次匯入 → 自動同步 → GPT 唯讀。原本 Render Static Site 與手機網址保持不變；獨立 Vercel API 與 Neon 資料庫已透過既有 Vercel 整合建立，不需要使用者另行登入 Neon。

1. 後端專案：Vercel `reef-tank-cloud`，資料庫：獨立的 `reef-controller-db`，不改動遊戲庫專案。
2. API 服務設定 `DATABASE_URL`、`REEF_ADMIN_TOKEN`、`REEF_GPT_READ_TOKEN`、`REEF_APP_ORIGIN`、`REEF_API_PUBLIC_URL`；秘密只存在伺服器與本機被忽略的私密設定檔。
3. 前端從 `cloud-config.defaults.json` 取得公開 API 網址；`REEF_CLOUD_API_URL` 可覆寫，手機不填網址或金鑰。
4. 在 App 的「雲端資料同步」輸入管理密碼，不必 Email 或建立會員帳號。
5. 使用原本保存紀錄的手機，確認數量後按「首次匯入」。雲端已有資料時不允許再次匯入。
6. 其他裝置使用同一管理密碼載入雲端；載入前會保留本機安全備份。

啟用後，本機儲存會自動同步。更新會檢查雲端版本，防止舊裝置覆蓋新紀錄；離線修改仍保留在本機。

完整部署與安全說明：[CLOUD_SETUP.md](CLOUD_SETUP.md)。舊 Supabase 模組、SQL 和 Edge Function 留作舊版相容參考；目前前端不再使用 Supabase 登入，也不會自動搬移或刪除其資料。

## 注意事項

未登入雲端同步時，資料仍存在使用者瀏覽器的 `localStorage`：

- 不同手機 / 電腦不會自動同步資料
- 朋友打開同一網址也不會看到你的紀錄
- 清除瀏覽器資料可能會刪除紀錄
- 建議定期使用「備份資料」保存紀錄
- PWA 可加入手機主畫面；跨裝置同步仍需要先登入並完成雲端同步設定
- 目前是一份個人魚缸資料庫，持有管理密碼的裝置都能讀寫全部魚缸；沒有多人權限分級
