/**
 * 股票/BTC 監控系統 v15.0 (Gemini 3.5 & Parallel Edition)
 * * [系統功能]
 * 1. 盤中監控：自訂波動門檻、60MA 季線觸及警報、防洪冷卻。
 * 2. 盤後純數據日報：自動判斷休市(週末/國定假日)、結算總市值與淨損益。
 * 3. 盤後 AI 分析：結合「持股狀態」與「總損益(%)」，給予差異化風險控管建議。
 * 4. 盤前 AI 早報：支援「大盤與總體經濟」宏觀視角，自動爬取 Google News 過去 24 小時即時新聞，依實際持股與觀察名單進行結構化摘要，嚴守客觀不幻覺。
 * 5. 異常追蹤：全面導入 API 錯誤與執行逾時 (Timeout) 捕捉機制並推播至 Discord。
 */

// ==========================================
// 0. 全域設定區 (CONFIG) - 請修改此處
// ==========================================
const scriptProperties = PropertiesService.getScriptProperties();

const CONFIG = {
  // 1. Discord Webhook (已改為從 Script Properties 讀取以防版控外洩)
  discordUrl: scriptProperties.getProperty('DISCORD_WEBHOOK_URL') || '', 
  
  // 2. Google Sheet 設定
  sheetName: 'Discord_Bot',
  
  // 3. 監控參數
  defaultThresholds: [0.03, 0.05, 0.10], 
  cooldownSeconds: 1800,                 
  
  // 4. Web App 安全設定
  webAppKey: '10083abc', 
  manualWebAppUrl: 'https://script.google.com/macros/s/AKfycbxxVKPlU6rJFD8E6WcnZlEW2uLnaLm5voFpMz3G_8kgW2bY8oawa3dAPJtTkJctHT2Lgg/exec', 
  
  // 5. 市場設定 (含時區與假日日曆)
  markets: {
    'TW': { timeZone: 'Asia/Taipei', calendarId: 'zh-tw.taiwan#holiday@group.v.calendar.google.com' },
    'US': { timeZone: 'America/New_York', calendarId: 'en.usa#holiday@group.v.calendar.google.com' },
    'Crypto': { timeZone: 'UTC', calendarId: null } 
  },

  // 6. Gemini AI Agent 設定 (已改為從 Script Properties 讀取以防版控外洩)
  geminiApiKey: scriptProperties.getProperty('GEMINI_API_KEY') || '', 
  geminiModel: 'gemini-3.5-flash', // 使用 Gemini 3.5 Flash 模型以獲得更佳分析性能與回覆速度
  
  // 盤後分析專用 Prompt
  agentPrompt: `你是一位冷靜、客觀的量化投資顧問。
請根據以下提供的今日收盤數據，進行技術面與部位風險分析。
特別注意：
- 針對「實際持有」的標的，請結合其「累積總損益」來評估風險承受度（獲利豐厚者可擴大震盪空間，虧損者需注意停損防守）。
- 針對「僅空手監控」的標的，請專注於是否出現切入機會。

請直接給出結論，重點包含：
1. 市場整體盤勢總結。
2. 持有部位的強弱與風險控管建議。
3. 監控標的之明日觀察重點。
使用繁體中文，條列式呈現，字數控制在 300 字以內，語氣要專業嚴謹，不要給出盲目的投資建議。`
};

// ==========================================
// 1. 盤中股價監控 (Check Stock Price)
// ==========================================
function checkStockPrice() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  const data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  const exchangeRate = getExchangeRate(sheet);
  const updates = []; 
  const cache = CacheService.getScriptCache();

  data.forEach((row) => {
    try {
      const [symbol, market, quantityRaw, avgCost, currentPrice, , dayChangePct, lastStatus, feeRateRaw, customThreshold, , ma60] = row;
      const quantity = (quantityRaw === "" || quantityRaw === null) ? "" : Number(quantityRaw);
      const feeRate = Number(feeRateRaw) || 0;

      if (!symbol || quantity === "" || typeof currentPrice !== 'number' || typeof dayChangePct !== 'number' || isNaN(dayChangePct)) {
        updates.push([lastStatus]); 
        return;
      }

      const isIndex = (quantity === 0);
      let currency = (market === 'TW' || symbol.toUpperCase().includes('TWD')) ? 'TWD' : 'USD';

      if (typeof ma60 === 'number' && ma60 > 0) {
        const maDistancePct = (currentPrice - ma60) / ma60;
        if (Math.abs(maDistancePct) <= 0.01) {
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
            cache.put(maCacheKey, 'true', 43200); 
          }
        }
      }

      const activeThresholds = (typeof customThreshold === 'number' && customThreshold > 0) 
                               ? [customThreshold] 
                               : CONFIG.defaultThresholds;
      
      const absChange = Math.abs(dayChangePct);
      const direction = dayChangePct > 0 ? '📈 大漲' : '📉 大跌';
      
      let triggeredThreshold = 0;
      activeThresholds.sort((a, b) => b - a); 
      for (let t of activeThresholds) {
        if (absChange >= t) { triggeredThreshold = t; break; }
      }

      const currentStatusToken = `${direction} >${triggeredThreshold * 100}%`;

      if (triggeredThreshold > 0 && lastStatus !== currentStatusToken) {
        const cacheKey = `ALERT_${symbol}_${triggeredThreshold}`;
        if (cache.get(cacheKey)) { updates.push([lastStatus]); return; }

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
  Logger.log("📊 [開始產生報表] 目標市場: " + targetMarket);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  if (!sheet) {
    Logger.log("❌ 錯誤：找不到工作表 '" + CONFIG.sheetName + "'，請確認名稱是否正確！");
    return;
  }
  const lastRow = sheet.getLastRow();
  Logger.log("📌 讀取到工作表總列數: " + lastRow);
  if (lastRow < 2) {
    Logger.log("⚠️ 工作表除標題外無其他資料列，略過發送。");
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const exchangeRate = getExchangeRate(sheet);
  const isClosed = checkMarketClosed(targetMarket);
  Logger.log(`📌 今日市場狀態: ${isClosed ? "💤 休市" : "📈 開盤"}, 匯率: ${exchangeRate}`);

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

  data.forEach((row, idx) => {
    const [symbol, market, quantityRaw, avgCost, currentPrice, , dayChangePct, , feeRateRaw] = row;
    const quantity = (quantityRaw === "" || quantityRaw === null) ? "" : Number(quantityRaw);
    const feeRate = Number(feeRateRaw) || 0;
    const rowNum = idx + 2;

    if (market === targetMarket) {
      Logger.log(`👉 檢查第 ${rowNum} 列 [${symbol}]：`);
      Logger.log(`   - 市場分類: ${market} (符合)`);
      Logger.log(`   - 持股數量: "${quantityRaw}" (解析為: ${quantity})`);
      Logger.log(`   - 目前價格: ${currentPrice} (型態: ${typeof currentPrice})`);
      
      if (typeof currentPrice !== 'number') {
        Logger.log(`   ⚠️ 警告：目前價格不是數字類型！請確認試算表公式是否回傳錯誤值或讀取中。`);
      }
      if (quantity === "") {
        Logger.log(`   ⚠️ 警告：持有數量為空值，此列將被略過。`);
      }
    }

    if (market === targetMarket && typeof currentPrice === 'number' && quantity !== "") {
      const isIndex = (quantity === 0);
      const grossValue = currentPrice * quantity;
      const netValue = grossValue * (1 - feeRate);
      const cost = avgCost * quantity;
      
      let dayPnL = 0;
      let effectiveDayChangePct = dayChangePct;

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
      Logger.log(`   ✅ 成功加入報表清單: ${listString}`);
    }
  });

  Logger.log("📌 待發送報表的標的總數: " + stockList.length);
  if (stockList.length === 0) {
    Logger.log("⚠️ 發送中止：沒有任何標的符合條件，故不發送 Discord 訊息。");
    return;
  }

  const totalNetPnL = totalNetMarketValue - totalCost;
  const totalNetPnLPercent = (totalCost > 0) ? (totalNetPnL / totalCost * 100).toFixed(2) + '%' : '0%';
  const color = totalNetPnL >= 0 ? 15548997 : 5763719; 
  
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
// 3. 盤後 AI 分析模組 (Risk Aware + Error Tracking)
// ==========================================
function runAgentAnalysis(targetMarket) {
  if (checkMarketClosed(targetMarket)) { return; }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

  const portfolioData = data.filter(row => row[1] === targetMarket && row[0] !== "")
    .map(row => {
      const quantityRaw = row[2];
      const isHolding = (quantityRaw !== "" && quantityRaw !== null && Number(quantityRaw) > 0);
      
      return {
        "標的": row[0],
        "狀態": isHolding ? "實際持有" : "僅空手監控",
        "累積總損益": isHolding ? ((typeof row[5] === 'number') ? (row[5] * 100).toFixed(2) + '%' : row[5]) : "N/A",
        "現價": typeof row[4] === 'number' ? row[4] : "N/A",
        "單日漲跌幅": (typeof row[6] === 'number') ? (row[6] * 100).toFixed(2) + '%' : 'N/A',
        "季線(60MA)": typeof row[11] === 'number' ? row[11] : "N/A"
      };
    });

  if (portfolioData.length === 0) return;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent?key=${CONFIG.geminiApiKey}`;
  const finalPrompt = `${CONFIG.agentPrompt}\n\n【今日 ${targetMarket} 市場持倉結算數據】\n${JSON.stringify(portfolioData, null, 2)}`;

  const payload = {
    contents: [{ parts: [{ text: finalPrompt }] }],
    generationConfig: { temperature: 0.2 }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (result.candidates && result.candidates.length > 0) {
      const aiAnalysis = result.candidates[0].content.parts[0].text;
      const marketEmoji = (targetMarket === 'TW') ? '🇹🇼' : (targetMarket === 'Crypto' ? '₿' : '🇺🇸');

      const message = {
        "content": null,
        "embeds": [{
          "title": `🤖 Agent ${targetMarket} 盤後分析報告`,
          "description": aiAnalysis,
          "color": 10181046, 
          "footer": { "text": "Powered by Gemini Agent & Google Apps Script" },
          "timestamp": new Date().toISOString()
        }]
      };
      sendToDiscord(message);
    } else {
      sendToDiscord({
        "content": null,
        "embeds": [{
          "title": "⚠️ 盤後分析 API 回應異常",
          "description": `**目標市場**：${targetMarket}\n**模型**：${CONFIG.geminiModel}\n**API 回傳內容**：\n\`\`\`json\n${JSON.stringify(result, null, 2).substring(0, 3000)}\n\`\`\``,
          "color": 16711680,
          "timestamp": new Date().toISOString()
        }]
      });
    }
  } catch (e) {
    sendToDiscord({
      "content": null,
      "embeds": [{
        "title": "⚠️ 盤後分析執行發生錯誤",
        "description": `**目標市場**：${targetMarket}\n**模型**：${CONFIG.geminiModel}\n**錯誤訊息**：${e.toString()}`,
        "color": 16711680,
        "timestamp": new Date().toISOString()
      }]
    });
  }
}

// ==========================================
// 4. 盤前新聞早報模組 (v14.4 Macro-Aware Edition)
// ==========================================
function fetchMarketMacroNews(market) {
  let query = '';
  // 針對不同市場設定大盤與總經關鍵字
  if (market === 'TW') query = '台股 大盤 OR 總體經濟 OR 台積電 when:24h';
  else if (market === 'US') query = 'US stock market OR Federal Reserve OR S&P 500 OR CPI when:24h';
  else if (market === 'Crypto') query = 'Cryptocurrency market OR Bitcoin macro OR SEC when:24h';
  
  let hl = market === 'TW' ? 'zh-TW' : 'en-US';
  let gl = market === 'TW' ? 'TW' : 'US';
  let ceid = market === 'TW' ? 'TW:zh-Hant' : 'US:en';

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const document = XmlService.parse(response.getContentText());
    const channel = document.getRootElement().getChild('channel');
    if (!channel) return [];
    
    const items = channel.getChildren('item');
    let newsList = [];
    // 大盤新聞重要性高，取前 5 條
    for (let i = 0; i < Math.min(items.length, 5); i++) {
      newsList.push(items[i].getChildText('title'));
    }
    return newsList;
  } catch (e) {
    return [];
  }
}

function fetchRecentNews(symbol, market) {
  const cleanSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  let query = market === 'TW' ? `${cleanSymbol} 股票 when:24h` : `${cleanSymbol} stock when:24h`;
  if (market === 'Crypto') query = `${cleanSymbol} crypto when:24h`;
  
  let hl = market === 'TW' ? 'zh-TW' : 'en-US';
  let gl = market === 'TW' ? 'TW' : 'US';
  let ceid = market === 'TW' ? 'TW:zh-Hant' : 'US:en';

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const document = XmlService.parse(response.getContentText());
    const channel = document.getRootElement().getChild('channel');
    if (!channel) return [];
    
    const items = channel.getChildren('item');
    let newsList = [];
    for (let i = 0; i < Math.min(items.length, 3); i++) {
      newsList.push(items[i].getChildText('title'));
    }
    return newsList;
  } catch (e) {
    return [];
  }
}

function generateMorningBriefing(targetMarket) {
  if (checkMarketClosed(targetMarket)) { return; }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); 
  let newsContext = [];
  let holdingSymbols = [];
  let watchSymbols = [];

  const fetchTasks = [];

  // 1. 設定「大盤總經」新聞查詢任務
  let macroQuery = '';
  if (targetMarket === 'TW') macroQuery = '台股 大盤 OR 總體經濟 OR 台積電 when:24h';
  else if (targetMarket === 'US') macroQuery = 'US stock market OR Federal Reserve OR S&P 500 OR CPI when:24h';
  else if (targetMarket === 'Crypto') macroQuery = 'Cryptocurrency market OR Bitcoin macro OR SEC when:24h';
  
  let hl = targetMarket === 'TW' ? 'zh-TW' : 'en-US';
  let gl = targetMarket === 'TW' ? 'TW' : 'US';
  let ceid = targetMarket === 'TW' ? 'TW:zh-Hant' : 'US:en';

  const macroUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(macroQuery)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  fetchTasks.push({
    url: macroUrl,
    symbol: "總體經濟與大盤環境",
    statusText: "【市場大趨勢】",
    isMacro: true
  });

  // 2. 蒐集個股新聞查詢任務
  data.forEach(row => {
    if (row[1] === targetMarket && row[0] !== "") {
      const symbol = row[0];
      const quantityRaw = row[2];
      const isHolding = (quantityRaw !== "" && quantityRaw !== null && Number(quantityRaw) > 0);
      
      if (isHolding) {
        holdingSymbols.push(symbol);
      } else {
        watchSymbols.push(symbol);
      }

      const cleanSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
      let query = targetMarket === 'TW' ? `${cleanSymbol} 股票 when:24h` : `${cleanSymbol} stock when:24h`;
      if (targetMarket === 'Crypto') query = `${cleanSymbol} crypto when:24h`;
      
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
      fetchTasks.push({
        url: url,
        symbol: symbol,
        statusText: isHolding ? "實際持有" : "觀察名單",
        isMacro: false
      });
    }
  });

  // 3. 執行平行 HTTP 請求抓取新聞
  if (fetchTasks.length > 0) {
    Logger.log(`📡 [平行抓取] 開始平行發送 ${fetchTasks.length} 個新聞請求...`);
    const requests = fetchTasks.map(task => ({
      url: task.url,
      method: "get",
      muteHttpExceptions: true
    }));
    
    try {
      const responses = UrlFetchApp.fetchAll(requests);
      
      fetchTasks.forEach((task, idx) => {
        try {
          const responseText = responses[idx].getContentText();
          const document = XmlService.parse(responseText);
          const channel = document.getRootElement().getChild('channel');
          if (!channel) return;
          
          const items = channel.getChildren('item');
          let newsList = [];
          const maxNewsCount = task.isMacro ? 5 : 3; // 大盤新聞取前 5 條，個股取前 3 條
          
          for (let i = 0; i < Math.min(items.length, maxNewsCount); i++) {
            newsList.push(items[i].getChildText('title'));
          }
          
          if (newsList.length > 0) {
            newsContext.push({
              "標的": task.symbol,
              "狀態": task.statusText,
              "近24小時重要新聞": newsList
            });
          }
        } catch (e) {
          Logger.log(`⚠️ 解析 ${task.symbol} 的新聞 XML 失敗: ${e}`);
        }
      });
    } catch (e) {
      Logger.log(`❌ 平行抓取新聞發生系統錯誤: ${e}`);
    }
  }

  if (newsContext.length === 0) {
    Logger.log(`${targetMarket} 無最新重點新聞。`);
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent?key=${CONFIG.geminiApiKey}`;
  const prompt = `
# Role
你是一位專業、客觀且精準的金融市場分析助理。請根據我提供的「近 24 小時財經新聞」，為我的 ${targetMarket} 市場部位撰寫每日盤前晨報。

# Background
以下是我目前在 ${targetMarket} 市場的標的分類：
- 核心持股：${holdingSymbols.length > 0 ? holdingSymbols.join(', ') : '無'}
- 觀察名單：${watchSymbols.length > 0 ? watchSymbols.join(', ') : '無'}

# Guidelines
1. 建立由上而下的分析視角：請務必先審視「總體經濟與大盤環境」的數據與新聞，確立今日市場的宏觀基調（如聯準會動態、通膨數據、大盤多空情緒）。
2. 檢視個股並排除雜訊：在宏觀基調下，分別對「實際持有」與「觀察名單」進行重點摘要。如果個別標的的新聞只是無意義的雜訊（如一般的股價播報），且大盤亦無重大事件，請客觀表示「無重大消息」。
3. 嚴守客觀與防幻覺：絕對不可自行腦補未在輸入數據中出現的事件。若資訊不足以判斷影響，請直接說明「影響不明」，不衍伸結論或不懂裝懂。
4. 格式與字數限制：必須使用繁體中文。總字數嚴格控制在 400 字以內。請使用條列式（Bullet points）並以粗體標示關鍵數據或公司名稱，確保排版極度易讀。

# Input Data
近 24 小時新聞：
${JSON.stringify(newsContext, null, 2)}
`;

  const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } }; 
  const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    
    if (result.candidates && result.candidates.length > 0) {
      const marketEmoji = (targetMarket === 'TW') ? '🇹🇼' : (targetMarket === 'Crypto' ? '₿' : '🇺🇸');
      const message = {
        "content": null,
        "embeds": [{
          "title": `${marketEmoji} Agent ${targetMarket} 盤前新聞早報`,
          "description": result.candidates[0].content.parts[0].text,
          "color": 16766720, 
          "footer": { "text": `Powered by Google News RSS & Gemini Agent (${CONFIG.geminiModel})` },
          "timestamp": new Date().toISOString()
        }]
      };
      sendToDiscord(message);
    } else {
      sendToDiscord({
        "content": null,
        "embeds": [{
          "title": "⚠️ 早報 API 回應異常",
          "description": `**目標市場**：${targetMarket}\n**模型**：${CONFIG.geminiModel}\n**API 回傳內容**：\n\`\`\`json\n${JSON.stringify(result, null, 2).substring(0, 3000)}\n\`\`\``,
          "color": 16711680,
          "timestamp": new Date().toISOString()
        }]
      });
    }
  } catch (e) {
    sendToDiscord({
      "content": null,
      "embeds": [{
        "title": "⚠️ 早報執行發生錯誤",
        "description": `**目標市場**：${targetMarket}\n**模型**：${CONFIG.geminiModel}\n**錯誤訊息**：${e.toString()}`,
        "color": 16711680,
        "timestamp": new Date().toISOString()
      }]
    });
  }
}

// 觸發器專用入口
function sendTwDailyReport() { generateReport('TW'); }
function sendUsDailyReport() { generateReport('US'); }
function sendCryptoReport() { generateReport('Crypto'); }
function agentDailyAnalysisTW() { runAgentAnalysis('TW'); }
function agentDailyAnalysisUS() { runAgentAnalysis('US'); }
function agentDailyAnalysisCrypto() { runAgentAnalysis('Crypto'); }
function morningBriefingTW() { generateMorningBriefing('TW'); }
function morningBriefingUS() { generateMorningBriefing('US'); }

// ==========================================
// 5. Web App 接口
// ==========================================
function doGet(e) {
  if (!e.parameter.key || e.parameter.key !== CONFIG.webAppKey) {
    return ContentService.createTextOutput("⛔ 存取被拒：密碼錯誤");
  }

  const cmd = e.parameter.cmd;
  let statusTitle = "";
  let statusMsg = "";

  try {
    switch (cmd) {
      case 'tw': sendTwDailyReport(); statusTitle = "🇹🇼 台股日報"; statusMsg = "已發送至 Discord！"; break;
      case 'us': sendUsDailyReport(); statusTitle = "🇺🇸 美股日報"; statusMsg = "已發送至 Discord！"; break;
      case 'crypto': sendCryptoReport(); statusTitle = "₿ 加密貨幣日報"; statusMsg = "已發送至 Discord！"; break;
      case 'check': checkStockPrice(); statusTitle = "🔍 盤中檢查"; statusMsg = "檢查完畢"; break;
      case 'agenttw': agentDailyAnalysisTW(); statusTitle = "🤖 台股 AI 盤後分析"; statusMsg = "報告已產生並發送！"; break;
      case 'agentus': agentDailyAnalysisUS(); statusTitle = "🤖 美股 AI 盤後分析"; statusMsg = "報告已產生並發送！"; break;
      case 'agentcrypto': agentDailyAnalysisCrypto(); statusTitle = "🤖 加密貨幣 AI 分析"; statusMsg = "報告已產生並發送！"; break;
      case 'morningtw': morningBriefingTW(); statusTitle = "🌅 台股盤前早報"; statusMsg = "早報已產生並發送！"; break;
      case 'morningus': morningBriefingUS(); statusTitle = "🌅 美股盤前早報"; statusMsg = "早報已產生並發送！"; break;
      default: statusTitle = "❓ 未知指令"; statusMsg = "請確認網址參數";
    }
  } catch (err) {
    statusTitle = "❌ 發生錯誤";
    statusMsg = err.toString();
  }

  return getAutoCloseHtml(statusTitle, statusMsg);
}

// ==========================================
// 6. 工具函式
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
  if (!CONFIG.discordUrl || CONFIG.discordUrl.trim() === '') {
    Logger.log("❌ 傳送失敗：找不到 Discord Webhook 網址。請至 Apps Script 的「專案設定」->「指令碼屬性」中新增 'DISCORD_WEBHOOK_URL'。");
    return;
  }
  const options = {
    'method': 'post', 'contentType': 'application/json',
    'payload': JSON.stringify(payload), 'muteHttpExceptions': true
  };
  try { 
    const response = UrlFetchApp.fetch(CONFIG.discordUrl, options); 
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    
    Logger.log("🔔 Discord Webhook 回傳狀態碼: " + responseCode);
    if (responseCode >= 200 && responseCode < 300) {
      Logger.log("✅ 訊息傳送成功！");
    } else {
      Logger.log("❌ Discord 伺服器拒絕發送。狀態碼: " + responseCode + "，回傳內容: " + responseText);
    }
    Utilities.sleep(500); 
  } 
  catch (e) { Logger.log("❌ Discord 傳送發生錯誤：" + e); }
}

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
  return HtmlService.createHtmlOutput(html).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ==========================================
// 7. 工具：發送控制台
// ==========================================
function sendDashboard() {
  let webAppUrl = ScriptApp.getService().getUrl(); 
  if (!webAppUrl || webAppUrl === "") {
    webAppUrl = CONFIG.manualWebAppUrl;
  }
  
  if (!webAppUrl) {
    Logger.log("❌ 錯誤：找不到 Web App 網址。");
    return;
  }
  
  const myKey = CONFIG.webAppKey;
  
  const twUrl = `${webAppUrl}?cmd=tw&key=${myKey}`;
  const usUrl = `${webAppUrl}?cmd=us&key=${myKey}`;
  const cryptoUrl = `${webAppUrl}?cmd=crypto&key=${myKey}`;
  const checkUrl = `${webAppUrl}?cmd=check&key=${myKey}`;
  
  const agentTwUrl = `${webAppUrl}?cmd=agenttw&key=${myKey}`;
  const agentUsUrl = `${webAppUrl}?cmd=agentus&key=${myKey}`;
  const agentCryptoUrl = `${webAppUrl}?cmd=agentcrypto&key=${myKey}`;
  
  const morningTwUrl = `${webAppUrl}?cmd=morningtw&key=${myKey}`;
  const morningUsUrl = `${webAppUrl}?cmd=morningus&key=${myKey}`;

  const message = {
    "content": null,
    "embeds": [{
      "title": "🎛️ 投資監控控制台 v15.0",
      "description": "請點擊下方選項：",
      "color": 3447003,
      "fields": [
        { 
          "name": "🌅 盤前新聞早報", 
          "value": `🇹🇼 **[台股盤前早報](${morningTwUrl})**\n🇺🇸 **[美股盤前早報](${morningUsUrl})**`, 
          "inline": true 
        },
        { 
          "name": "🤖 盤後 AI 分析", 
          "value": `🇹🇼 **[台股盤後分析](${agentTwUrl})**\n🇺🇸 **[美股盤後分析](${agentUsUrl})**\n₿ **[加密盤後分析](${agentCryptoUrl})**`, 
          "inline": true 
        },
        { 
          "name": "📊 純數據日報", 
          "value": `🇹🇼 **[台股數據日報](${twUrl})**\n🇺🇸 **[美股數據日報](${usUrl})**\n₿ **[加密數據日報](${cryptoUrl})**`, 
          "inline": false 
        },
        { 
          "name": "⚡ 即時操作", 
          "value": `🔍 **[立即檢查波動](${checkUrl})**`, 
          "inline": false 
        }
      ],
      "footer": { "text": "Powered by v15.0 | 內建大盤總經平行爬蟲" }
    }]
  };
  sendToDiscord(message);
}

function forceAuthTrigger() {
  CalendarApp.getDefaultCalendar(); 
}

// 用於測試 Script Properties 是否正確載入的排查函數
function testProperties() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const discordVal = scriptProperties.getProperty('DISCORD_WEBHOOK_URL');
  const geminiVal = scriptProperties.getProperty('GEMINI_API_KEY');
  
  Logger.log("========= [Script Properties 測試開始] =========");
  Logger.log("📌 DISCORD_WEBHOOK_URL: " + (discordVal ? `已讀取成功，前15個字元為: ${discordVal.substring(0, 15)}...` : "❌ 讀取失敗 (可能為 null)"));
  Logger.log("📌 GEMINI_API_KEY: " + (geminiVal ? `已讀取成功，前8個字元為: ${geminiVal.substring(0, 8)}...` : "❌ 讀取失敗 (可能為 null)"));
  Logger.log("================================================");
}

// 用於獨立測試 Gemini API 串接與回應時間的診斷函數
function testGemini() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
  if (!apiKey || apiKey.trim() === '') {
    Logger.log("❌ 錯誤：找不到 GEMINI_API_KEY。請確認「專案設定」->「指令碼屬性」中已新增此屬性。");
    return;
  }
  
  const model = CONFIG.geminiModel; // 'gemini-3.5-flash'
  Logger.log(`🤖 [Gemini API 測試] 開始呼叫模型: ${model}`);
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: "這是一次 API 測試。請簡短回答『測試成功』即可。" }] }],
    generationConfig: { temperature: 0.1 }
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const startTime = new Date().getTime();
  try {
    Logger.log("📡 正在發送 REST 請求至: " + url.split('?')[0]);
    const response = UrlFetchApp.fetch(url, options);
    const endTime = new Date().getTime();
    const elapsed = (endTime - startTime) / 1000;
    
    const responseCode = response.getResponseCode();
    Logger.log(`🔔 收到回應！花費時間: ${elapsed.toFixed(2)} 秒，HTTP 狀態碼: ${responseCode}`);
    
    const responseText = response.getContentText();
    if (responseCode >= 200 && responseCode < 300) {
      const result = JSON.parse(responseText);
      if (result.candidates && result.candidates.length > 0) {
        const text = result.candidates[0].content.parts[0].text;
        Logger.log(`✅ Gemini 回應成功！內容如下:\n${text}`);
      } else {
        Logger.log(`⚠️ 回傳的 JSON 結構異常: \n${responseText}`);
      }
    } else {
      Logger.log(`❌ API 回傳失敗。狀態碼: ${responseCode}，錯誤內容: \n${responseText}`);
    }
  } catch (e) {
    Logger.log(`❌ 請求發生例外錯誤: ${e.toString()}`);
  }
}