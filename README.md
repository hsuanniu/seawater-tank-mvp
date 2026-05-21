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
   - Build Command：留空
   - Publish Directory：`.`

部署完成後，Render 會提供一個 `onrender.com` 網址。

## Supabase 雲端同步

雲端同步會把整份 App 資料存成同一筆使用者資料，方便手機與電腦同步。

1. 建立 Supabase 專案。
2. 到 SQL Editor 執行 `supabase-schema.sql`。
3. 到 App 的「雲端同步」頁面填入：
   - Supabase Project URL
   - Supabase anon key
4. 建立帳號或登入。
5. 第一次同步時，先在主要裝置按「上傳到雲端」。
6. 其他裝置登入後按「從雲端下載」。

之後登入狀態下，本機資料儲存後會自動排程上傳；你也可以手動上傳或下載。

## 注意事項

未登入雲端同步時，資料仍存在使用者瀏覽器的 `localStorage`：

- 不同手機 / 電腦不會自動同步資料
- 朋友打開同一網址也不會看到你的紀錄
- 清除瀏覽器資料可能會刪除紀錄
- 建議定期使用「備份資料」保存紀錄
- PWA 可加入手機主畫面；跨裝置同步仍需要先登入並完成雲端同步設定
- 目前同步單位是「同一個登入帳號」，尚未提供多人共用同一魚缸的權限管理
