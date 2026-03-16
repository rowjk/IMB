/**
 * 股票/BTC 監控系統 v12.2 (Titanium Edition)
 * * [版本履歷]
 * v12.2: Web App 介面優化(2秒自動關閉)、控制台按鈕間距優化。
 * v12.0: Discord 防洪機制、時區校正、系統強健性提升。
 * v11.x: 架構重構、配置集中化、國定假日自動休市。
 *
 * [系統核心能力]
 * 1. 全天候監控：自訂門檻、30分鐘冷卻、雙幣顯示、自動扣費。
 * 2. 智慧日報：自動判斷休市(週末/國定假日)、支援純指數監控(不計損益)。
 * 3. 極致體驗：手機版好按介面、執行後自動關閉視窗。
 */

// ==========================================
// 0. 全域設定區 (CONFIG) - 請修改此處
// ==========================================
const CONFIG = {
  // 1. Discord Webhook (請填入您的 Webhook URL)
  discordUrl: 'YOUR_DISCORD_WEBHOOK_URL', 
  
  // 2. Google Sheet 設定
  sheetName: 'Discord_Bot',
  
  // 3. 監控參數
  defaultThresholds: [0.03, 0.05, 0.10], // 預設波動門檻 (3%, 5%, 10%)
  cooldownSeconds: 1800,                 // 防連發冷卻 (秒)
  
  // 4. Web App 安全設定
  webAppKey: 'OUR_SECRET_KEY', // ★ 請自行設定遙控密碼
  // ★ 若自動抓取失敗，請在此填入您的 Web App 網址 (https://script.google.com/macros/s/.../exec)
  manualWebAppUrl: 'https://script.google.com/macros/s/AKfycbxxVKPlU6rJFD8E6WcnZlEW2uLnaLm5voFpMz3G_8kgW2bY8oawa3dAPJtTkJctHT2Lgg/exec', 
  
  // 5. 市場設定 (含時區與假日日曆)
  markets: {
    'TW': { timeZone: 'Asia/Taipei', calendarId: 'zh-tw.taiwan#holiday@group.v.calendar.google.com' },
    'US': { timeZone: 'America/New_York', calendarId: 'en.usa#holiday@group.v.calendar.google.com' },
    'Crypto': { timeZone: 'UTC', calendarId: null } // Crypto 全年無休
  }
};

// ==========================================
// 1. 盤中股價監控 (Check Stock Price) - 含季線監控 (L欄版)
// ==========================================
function checkStockPrice() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  // 讀取範圍擴大到 12 欄 (A 到 L)
  const data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  const exchangeRate = getExchangeRate(sheet);
  const updates = []; 
  const cache = CacheService.getScriptCache();

  data.forEach((row) => {
    try {
      // 多加一個逗號跳過 K 欄，精準抓取 L 欄的 ma60
      const [symbol, market, quantityRaw, avgCost, currentPrice, , dayChangePct, lastStatus, feeRateRaw, customThreshold, , ma60] = row;
      
      const quantity = (quantityRaw === "" || quantityRaw === null) ? "" : Number(quantityRaw);
      const feeRate = Number(feeRateRaw) || 0;

      if (!symbol || quantity === "" || typeof currentPrice !== 'number' || typeof dayChangePct !== 'number' || isNaN(dayChangePct)) {
        updates.push([lastStatus]); 
        return;
      }

      const isIndex = (quantity === 0);
      let currency = (market === 'TW' || symbol.toUpperCase().includes('TWD')) ? 'TWD' : 'USD';

      // ----------------------------------------
      // 🟢 季線 (60MA) 觸及監控 (讀取 L 欄)
      // ----------------------------------------
      if (typeof ma60 === 'number' && ma60 > 0) {
        const maDistancePct = (currentPrice - ma60) / ma60;
        
        // 若現價進入季線上下 1% 的範圍內
        if (Math.abs(maDistancePct) <= 0.01) {
          // 更改 Cache Key 避免跟之前的月線快取衝突
          const maCacheKey = `MA60_ALERT_${symbol}`;
          
          if (!cache.get(maCacheKey)) {
            const crossStatus = maDistancePct >= 0 ? '由上往下回測' : '由下往上挑戰';
            const distStr = (Math.abs(maDistancePct) * 100).toFixed(2) + '%';
            
            const maMessage = {
              "content": null,
              "embeds": [{
                "title": `🎯 ${symbol} 季線 (60MA) 觸及警報`,
                "description": `股價已進入季線 **1%** 範圍內！\n狀態：**${crossStatus}**`,
                "color": 3447003, 
                "fields": [
                  { "name": "目前股價", "value": `**${formatMoney(currentPrice)}**`, "inline": true },
                  { "name": "季線位置", "value": `**${formatMoney(ma60)}**`, "inline": true },
                  { "name": "距離季線", "value": `${distStr}`, "inline": true }
                ],
                "timestamp": new Date().toISOString()
              }]
            };
            sendToDiscord(maMessage);
            // 標記已通知，冷卻 12 小時
            cache.put(maCacheKey, 'true', 43200); 
          }
        }
      }

      // ----------------------------------------
      // 原本的漲跌幅波動監控邏輯
      // ----------------------------------------
      const activeThresholds = (typeof customThreshold === 'number' && customThreshold > 0) 
                               ? [customThreshold] 
                               : CONFIG.defaultThresholds;
      
      const absChange = Math.abs(dayChangePct);
      const direction = dayChangePct > 0 ? '📈 大漲' : '📉 大跌';
      
      let triggeredThreshold = 0;
      activeThresholds.sort((a, b) => b - a); 
      for (let t of activeThresholds) {
        if (absChange >= t) {
          triggeredThreshold = t;
          break; 
        }
      }

      const currentStatusToken = `${direction} >${triggeredThreshold * 100}%`;

      if (triggeredThreshold > 0 && lastStatus !== currentStatusToken) {
        const cacheKey = `ALERT_${symbol}_${triggeredThreshold}`;
        if (cache.get(cacheKey)) {
          updates.push([lastStatus]); 
          return;
        }

        const dayPctString = (dayChangePct * 100).toFixed(2) + '%';
        const embedColor = dayChangePct > 0 ? 15548997 : 5763719; 

        let fields = [];
        if (isIndex) {
          fields = [
            { "name": "目前點位", "value": `**${formatMoney(currentPrice)}**`, "inline": true },
            { "name": "單日漲跌幅", "value": `**${dayPctString}**`, "inline": true },
            { "name": "類型", "value": "📊 純指數監控", "inline": true }
          ];
        } else {
          const grossMarketValue = currentPrice * quantity;     
          const netMarketValue = grossMarketValue * (1 - feeRate); 
          const totalCost = avgCost * quantity;
          const netProfit = netMarketValue - totalCost; 
          const netProfitPct = (totalCost > 0) ? (netProfit / totalCost * 100).toFixed(2) + '%' : '0%';
          
          fields = [
            { "name": "目前市值 (帳面)", "value": formatDualMoney(grossMarketValue, currency, exchangeRate), "inline": true },
            { "name": "單日漲跌幅", "value": `**${dayPctString}**`, "inline": true },
            { "name": "預估淨損益", "value": `${formatDualMoney(netProfit, currency, exchangeRate)}\n(${netProfitPct})`, "inline": false }
          ];
        }

        const message = {
          "content": null,
          "embeds": [{
            "title": `${symbol} 行情異動通知`,
            "description": `波動達標 (門檻 ${(triggeredThreshold*100)}%)： **${direction} ${dayPctString}**`,
            "color": embedColor,
            "fields": fields,
            "footer": { "text": isIndex ? "Index Monitor" : `匯率: ${exchangeRate.toFixed(2)}` },
            "timestamp": new Date().toISOString()
          }]
        };

        sendToDiscord(message);
        cache.put(cacheKey, 'true', CONFIG.cooldownSeconds); 
        updates.push([currentStatusToken]); 

      } else if (triggeredThreshold === 0) {
        updates.push(['']); 
      } else {
        updates.push([lastStatus]); 
      }
    } catch (e) {
      Logger.log(`Error processing row: ${e}`);
      updates.push([row[7]]); 
    }
  });

  sheet.getRange(2, 8, updates.length, 1).setValues(updates);
}

// ==========================================
// 2. 資產日報生成器 (Generate Report)
// ==========================================
function generateReport(targetMarket) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const exchangeRate = getExchangeRate(sheet);
  const isClosed = checkMarketClosed(targetMarket);

  let totalGrossMarketValue = 0;
  let totalNetMarketValue = 0;
  let totalCost = 0;
  let totalDayChange = 0; 
  let stockList = [];
  
  let currency = (targetMarket === 'TW') ? 'TWD' : 'USD';
  let marketEmoji = (targetMarket === 'TW') ? '🇹🇼' : (targetMarket === 'Crypto' ? '₿' : '🇺🇸');
  
  if (targetMarket === 'Crypto') {
     const firstCrypto = data.find(r => r[1] === 'Crypto');
     if (firstCrypto && firstCrypto[0].toUpperCase().includes('TWD')) currency = 'TWD';
  }

  data.forEach(row => {
    const [symbol, market, quantityRaw, avgCost, currentPrice, , dayChangePct, , feeRateRaw] = row;
    const quantity = (quantityRaw === "" || quantityRaw === null) ? "" : Number(quantityRaw);
    const feeRate = Number(feeRateRaw) || 0;

    if (market === targetMarket && typeof currentPrice === 'number' && quantity !== "") {
      const isIndex = (quantity === 0);
      
      const grossValue = currentPrice * quantity;
      const netValue = grossValue * (1 - feeRate);
      const cost = avgCost * quantity;
      
      let dayPnL = 0;
      let effectiveDayChangePct = dayChangePct;

      // 休市判斷
      if (isClosed) {
        effectiveDayChangePct = 0; 
        dayPnL = 0;
      } else if (typeof dayChangePct === 'number' && !isNaN(dayChangePct)) {
        const yesterdayPrice = currentPrice / (1 + dayChangePct);
        dayPnL = (currentPrice - yesterdayPrice) * quantity;
      }

      if (!isIndex) {
        totalGrossMarketValue += grossValue;
        totalNetMarketValue += netValue;
        totalCost += cost;
        totalDayChange += dayPnL;
      }

      // 生成列表
      let listString = "";
      if (isIndex) {
         if (isClosed) {
           listString = `💤 **${symbol} (指數)**: ${formatMoney(currentPrice)} (休市)`;
         } else {
           const sign = effectiveDayChangePct >= 0 ? '+' : '';
           const pctStr = (effectiveDayChangePct * 100).toFixed(2) + '%';
           const icon = effectiveDayChangePct >= 0 ? '🔺' : '🔻';
           listString = `${icon} **${symbol}**: ${formatMoney(currentPrice)} (${sign}${pctStr})`;
         }
      } else {
         const netTotalPnL = netValue - cost;
         const netPnlPct = ((netTotalPnL / cost) * 100).toFixed(1) + '%';
         const icon = netTotalPnL >= 0 ? '🔴' : '🟢'; 
         listString = `${icon} **${symbol}**: ${formatMoney(grossValue)} ${currency} (${netPnlPct})`;
      }
      stockList.push(listString);
    }
  });

  if (stockList.length === 0) return;

  const totalNetPnL = totalNetMarketValue - totalCost;
  const totalNetPnLPercent = (totalCost > 0) ? (totalNetPnL / totalCost * 100).toFixed(2) + '%' : '0%';
  const color = totalNetPnL >= 0 ? 15548997 : 5763719; 
  
  // 生成漲跌欄位
  let dayChangeFieldStr = "";
  if (isClosed) {
    dayChangeFieldStr = "😴 市場休市 (無變動)";
  } else {
    const daySign = totalDayChange >= 0 ? '+' : '';
    let dayChangeRateStr = "(0.00%)";
    const yesterdayMarketValue = totalGrossMarketValue - totalDayChange;
    
    if (yesterdayMarketValue > 0) {
      const dayChangeRate = (totalDayChange / yesterdayMarketValue) * 100;
      const rateSign = dayChangeRate >= 0 ? '+' : '';
      dayChangeRateStr = `(${rateSign}${dayChangeRate.toFixed(2)}%)`;
    }
    dayChangeFieldStr = `${daySign}${formatDualMoney(totalDayChange, currency, exchangeRate)} ${dayChangeRateStr}`;
  }

  const titleSuffix = isClosed ? " (😴 休市)" : "";

  const message = {
    "content": null,
    "embeds": [{
      "title": `${marketEmoji} ${targetMarket} 資產概況日報${titleSuffix}`,
      "color": isClosed ? 9807270 : color, 
      "fields": [
        { "name": "總市值 (帳面)", "value": formatDualMoney(totalGrossMarketValue, currency, exchangeRate), "inline": true },
        { "name": "預估淨損益", "value": `${formatDualMoney(totalNetPnL, currency, exchangeRate)}\n(${totalNetPnLPercent})`, "inline": true },
        { "name": "今日行情增減", "value": dayChangeFieldStr, "inline": true },
        { "name": "------------------", "value": stockList.join('\n') || "無資料", "inline": false }
      ],
      "footer": { "text": `Rate: ${exchangeRate} | Net Asset Report` },
      "timestamp": new Date().toISOString()
    }]
  };

  sendToDiscord(message);
}

// ==========================================
// 3. 觸發入口
// ==========================================
function sendTwDailyReport() { generateReport('TW'); }
function sendUsDailyReport() { generateReport('US'); }
function sendCryptoReport() { generateReport('Crypto'); }

// ==========================================
// 4. Web App 接口 (v12.2 自動關閉視窗)
// ==========================================
function doGet(e) {
  // 1. 安全檢查
  if (!e.parameter.key || e.parameter.key !== CONFIG.webAppKey) {
    return ContentService.createTextOutput("⛔ 存取被拒：密碼錯誤");
  }

  const cmd = e.parameter.cmd;
  let statusTitle = "";
  let statusMsg = "";

  // 2. 執行指令
  try {
    switch (cmd) {
      case 'tw': 
        sendTwDailyReport(); 
        statusTitle = "🇹🇼 台股日報";
        statusMsg = "已成功發送至 Discord！"; 
        break;
      case 'us': 
        sendUsDailyReport(); 
        statusTitle = "🇺🇸 美股日報";
        statusMsg = "已成功發送至 Discord！"; 
        break;
      case 'crypto': 
        sendCryptoReport(); 
        statusTitle = "₿ 加密貨幣日報";
        statusMsg = "已成功發送至 Discord！"; 
        break;
      case 'check': 
        checkStockPrice(); 
        statusTitle = "🔍 盤中檢查";
        statusMsg = "檢查完畢 (若無波動則不通知)"; 
        break;
      default: 
        statusTitle = "❓ 未知指令";
        statusMsg = "請確認網址參數是否正確";
    }
  } catch (err) {
    statusTitle = "❌ 發生錯誤";
    statusMsg = err.toString();
  }

  // 3. 回傳 HTML (嘗試自動關閉)
  return getAutoCloseHtml(statusTitle, statusMsg);
}

// ==========================================
// 5. 工具函式 (Helper Functions)
// ==========================================

function getExchangeRate(sheet) {
  try {
    const val = sheet.getRange("K2").getValue();
    return (typeof val === 'number' && val > 0) ? val : 32.5;
  } catch (e) { return 32.5; }
}

function checkMarketClosed(targetMarket) {
  const marketConfig = CONFIG.markets[targetMarket];
  if (!marketConfig || !marketConfig.calendarId) return false;

  const today = new Date();
  // 強制時區判斷，避免 new Date() 使用系統時區誤差
  const dayOfWeek = Utilities.formatDate(today, marketConfig.timeZone, 'EEE');
  if (dayOfWeek === 'Sat' || dayOfWeek === 'Sun') return true;

  try {
    const calendar = CalendarApp.getCalendarById(marketConfig.calendarId);
    if (calendar) {
      const events = calendar.getEventsForDay(today);
      if (events.length > 0) return true;
    }
  } catch (e) {
    Logger.log(`Calendar Error: ${e.toString()}`);
  }
  return false;
}

function formatDualMoney(amount, currency, rate) {
  const mainStr = `**${formatMoney(amount)} ${currency}**`;
  if (currency === 'TWD' || amount === 0) return mainStr;
  const twdVal = amount * rate;
  return `${mainStr}\n(≈ ${formatMoney(twdVal)} TWD)`;
}

function formatMoney(num) {
  if (typeof num !== 'number') return num;
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function sendToDiscord(payload) {
  const options = {
    'method': 'post', 'contentType': 'application/json',
    'payload': JSON.stringify(payload), 'muteHttpExceptions': true
  };
  try { 
    UrlFetchApp.fetch(CONFIG.discordUrl, options); 
    // 防洪：每次發送後暫停 500ms，避免觸發 Discord 429 錯誤
    Utilities.sleep(500); 
  } 
  catch (e) { Logger.log(e); }
}

// === 輔助函式：產生自動關閉的 HTML (2秒版) ===
function getAutoCloseHtml(title, msg) {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>指令執行完成</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 40px 20px; background-color: #f2f3f5; }
          .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
          h2 { color: #2c3e50; margin-top: 0; }
          p { color: #555; font-size: 16px; line-height: 1.5; }
          .timer { color: #888; font-size: 14px; margin-top: 20px; }
          button { background-color: #5865F2; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 16px; cursor: pointer; margin-top: 15px; }
          button:hover { background-color: #4752c4; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>${title}</h2>
          <p>${msg}</p>
          <div class="timer">視窗將在 <span id="cnt">2</span> 秒後關閉...</div>
          <button onclick="window.top.close()">立即關閉</button>
        </div>
        <script>
          var count = 2; 
          var counter = setInterval(function() {
            count--;
            document.getElementById('cnt').innerText = count;
            if (count <= 0) {
              clearInterval(counter);
              window.top.close(); 
              document.querySelector('.timer').innerText = "若視窗未關閉，請手動點擊按鈕";
            }
          }, 1000);
        </script>
      </body>
    </html>
  `;
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ==========================================
// 6. 工具：發送控制台 (好按間距版)
// ==========================================
function sendDashboard() {
  // 雙重保險：先試抓部署網址，抓不到則用 Config 設定的手動網址
  let webAppUrl = ScriptApp.getService().getUrl(); 
  if (!webAppUrl || webAppUrl === "") {
    webAppUrl = CONFIG.manualWebAppUrl;
  }
  
  if (!webAppUrl) {
    Logger.log("❌ 錯誤：找不到 Web App 網址。請先部署專案，或在 CONFIG.manualWebAppUrl 填入網址。");
    return;
  }
  
  const myKey = CONFIG.webAppKey;
  const twUrl = `${webAppUrl}?cmd=tw&key=${myKey}`;
  const usUrl = `${webAppUrl}?cmd=us&key=${myKey}`;
  const cryptoUrl = `${webAppUrl}?cmd=crypto&key=${myKey}`;
  const checkUrl = `${webAppUrl}?cmd=check&key=${myKey}`;

  const message = {
    "content": null,
    "embeds": [{
      "title": "🎛️ 投資監控控制台 v12.2",
      "description": "請點擊下方選項（已優化間距，方便點選）：",
      "color": 3447003,
      "fields": [
        { 
          "name": "📊 資產日報", 
          "value": `🇹🇼 **[發送 台股日報](${twUrl})**\n\n🇺🇸 **[發送 美股日報](${usUrl})**\n\n₿ **[發送 加密日報](${cryptoUrl})**`, 
          "inline": true 
        },
        { 
          "name": "⚡ 即時操作", 
          "value": `\n🔍 **[立即檢查波動](${checkUrl})**`, 
          "inline": true 
        }
      ],
      "footer": { "text": "Powered by v12.2 Titanium Edition" }
    }]
  };
  sendToDiscord(message);
}

// === 專用授權修復工具 (使用後可忽略) ===
function forceAuthTrigger() {
  CalendarApp.getDefaultCalendar(); 
}
