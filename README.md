# 📈 個人投資監控助理 (Investment Monitor Bot) v12.3

這是一個基於 Google Apps Script (GAS) 與 Google Sheets 打造的個人自動化投資監控系統。透過 Discord Webhook 進行推播，並附帶簡易的手機版 Web UI 控制台。

## ✨ 核心功能
* **🌍 多市場支援**：支援台股 (TW)、美股 (US)、加密貨幣 (Crypto) 的即時報價與資產管理。
* **📊 雙模監控**：支援「個股資產損益計算」與「純指數點位監控」。
* **🔔 智慧警報**：
  * **自訂波動門檻**：可針對個別標的設定大漲/大跌通知門檻（預設 3%, 5%, 10%）。
  * **季線 (60MA) 觸及警報**：當股價進入季線上下 1% 範圍時，主動通知「回測」或「突破」狀態（內建 12 小時防洪冷卻）。
* **🛌 智慧休市判斷**：整合 Google Calendar 台灣/美國國定假日與週末，休市期間不打擾。
* **📱 Web UI 控制台**：內建手機友善的網頁控制台，可一鍵觸發每日報表或盤中檢查。

## 🛠️ 系統架構
* **資料庫**：Google Sheets (負責儲存持倉、計算現價與 60MA)。
* **運算核心**：Google Apps Script (負責邏輯判斷、排程觸發)。
* **通知介面**：Discord Webhook (接收卡片式報表)。

## 📝 Google Sheet 欄位設定參考
請確保試算表名稱為 `Discord_Bot`，欄位配置如下：
* A欄: 代號 (Symbol)
* B欄: 市場 (TW / US / Crypto)
* C欄: 股數 (純監控指數請留空或填 0)
* D欄: 平均成本
* E欄: 現價 (公式: `=GOOGLEFINANCE(...)`)
* F欄: 市值
* G欄: 單日漲跌幅
* H欄: 最後狀態紀錄 (程式自動填寫)
* I欄: 交易手續費率
* J欄: 自訂波動門檻 (如 0.05)
* K欄: 匯率保留區 (K2 為 USD/TWD 匯率)
* L欄: 季線 60MA (公式: `=IFERROR(AVERAGE(QUERY(GOOGLEFINANCE($A2, "price", TODAY()-100, TODAY()), "select Col2 order by Col1 desc limit 60")), "")`)

## ⚠️ 安全性提醒
* 本專案包含個人投資數據與 Discord Webhook 連結，請務必保持 Repository 為 **Private (私有)**。
