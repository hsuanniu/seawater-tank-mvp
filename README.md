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
- Supabase 登入與雲端同步
- localStorage 單機儲存
- GPT 唯讀連接程式與設定指引（須先設定 Supabase、部署 Edge Function，並在專用 GPT 匯入 Action 才能使用）

## 本機使用

直接用瀏覽器打開 `index.html` 即可。

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
   - Build Command：`npm run build`
   - Publish Directory：`.`

部署完成後，Render 會提供一個 `onrender.com` 網址。

## Supabase 雲端同步

若要像遊戲庫一樣讓 GPT 直接讀取資料，請依照 [雲端與 GPT 連接設定](GPT_CONNECTION.md)。入口位於「設定 → 雲端資料同步」。

雲端同步保留同一份 TankStore 快照，按帳號隔離；部署時只設定一次公開連線資訊，手機不再要求填網址或金鑰。

1. 建立 Supabase 專案。
2. 到 SQL Editor 執行 `supabase-schema.sql`。
3. Render Environment 設定 `REEF_SUPABASE_URL`、`REEF_SUPABASE_PUBLISHABLE_KEY`，Build Command 使用 `npm run build`，重新部署。
4. 在 App 的「雲端資料同步」登入或建立帳號。
5. 使用原本保存紀錄的手機，確認數量後按「首次匯入」。雲端已有資料時不允許再次匯入。
6. 其他裝置登入後載入雲端；載入前會保留本機安全備份。

啟用後，本機儲存會自動同步。更新會檢查雲端版本，防止舊裝置覆蓋新紀錄；離線修改仍保留在本機。

## 注意事項

未登入雲端同步時，資料仍存在使用者瀏覽器的 `localStorage`：

- 不同手機 / 電腦不會自動同步資料
- 朋友打開同一網址也不會看到你的紀錄
- 清除瀏覽器資料可能會刪除紀錄
- 建議定期使用「備份資料」保存紀錄
- PWA 可加入手機主畫面；跨裝置同步仍需要先登入並完成雲端同步設定
- 目前同步單位是「同一個登入帳號」，尚未提供多人共用同一魚缸的權限管理
