# Claude CLI Controller

給 Windows 用的輕量 Claude Code CLI 對話器。**零相依套件**：只用 Node.js 內建模組，後端呼叫你已安裝的 `claude` CLI，前端開在 Edge 的獨立 App 視窗裡。

## 啟動

| 方式 | 說明 |
|---|---|
| 雙擊 `start.vbs` | 平常使用。背景啟動伺服器（不會有黑色視窗），並開啟 App 視窗。已在執行時再雙擊，只會多開一個視窗。 |
| `start-debug.cmd` | 除錯用。會顯示主控台和 log，不會自動結束。 |
| `powershell -ExecutionPolicy Bypass -File create-shortcut.ps1` | 在桌面和開始選單建立「Claude CLI Controller」捷徑。 |

所有視窗都關掉、也沒有任何對話在執行時，伺服器會在約 2 分鐘後自動結束。**對話還在跑時關掉視窗也沒關係**，伺服器會等它跑完，重新開啟後就能看到結果。

需求：Node.js 18 以上（目前是 v26）、已安裝並登入的 `claude` CLI、Edge 或 Chrome。

## 功能

- **左側 Session 列表**：自動讀取 `~/.claude/projects` 底下**所有** CLI 對話（包含以前在 PowerShell 開的），可依資料夾或時間分組、搜尋、釘選、重新命名、封存、刪除。右鍵選單還可以「在 PowerShell 開啟」(`claude --resume <id>`)、開啟資料夾、複製 Session ID。
  - **封存**（右鍵選單，或對話標題列的 🗄）：從列表收起，對話紀錄不動。勾左下「已封存」可以再看到，也可以取消封存。封存狀態只存在這個 App，不會改到桌面版。
  - **刪除**（右鍵選單最下面，或標題列的 🗑）：確認後，把對話紀錄（`<id>.jsonl` 和同名資料夾）**移到 Windows 資源回收筒**，需要時可以從回收筒還原。正在執行的對話要先停止才能刪。刪除桌面版開的對話時會特別提醒：桌面版裡的那個對話也會打不開。
  - 搜尋框下方可切換「全部 / CLI / 桌面版」：依 session 是在哪裡開的來篩選（在這個 App 開的算 CLI）。選「全部」時，桌面版的對話前面會標「桌面」。
  - 在 Claude Desktop 封存或刪除的 session 在這裡也算封存（勾「已封存」可以看到）。
  - 「桌面版暫存」：Claude Desktop 放在 AppData 的暫存 session，預設不顯示。
- **對話**：串流顯示、Markdown、工具呼叫可以展開（指令、diff、輸出）。Claude 執行中送出的訊息會排入佇列，這一輪結束後接著送。按 ■ 停止可以中斷。
  - 工具呼叫的顯示方式：點對話標題列右邊的「工具：…」按鈕切換，設定會記住。
    - **摺疊**（預設）：連續的工具呼叫合成一行，例如「⚙ 4 個工具 Bash ×4 ✓」，有失敗會標出數量。點開可以看每一個。
    - **隱藏**：完全不顯示工具呼叫，但工具產生的圖片（例如截圖）照樣顯示。
    - **全部**：每個工具呼叫各一行。
- **`/` 指令**：在輸入框開頭打 `/`（或按輸入列的 `/` 按鈕）會跳出指令選單。清單是向 claude 查詢的，包含內建指令和你的 skill。
  - ↑↓ 選擇，Enter / Tab 選用：不需要參數的指令會直接執行，需要參數的會填入 `/指令 ` 等你輸入。
  - 輸入框已經有文字時按 `/` 按鈕再選指令，那段文字會變成指令的參數（例如先打好問題，再選 btw）。
  - 標「App」的指令由這個 App 處理：
    - `/btw <問題>`：順便問一個問題。用對話的複本回答（`--fork-session --no-session-persistence`，不能使用工具），**不會寫進對話紀錄**，Claude 執行中也能問。
    - `/usage`、`/context`：結果以卡片顯示，不寫進對話紀錄，也不呼叫模型。
    - `/clear`：在同一個資料夾開新對話。`/model`、`/effort`：切換設定（下一則訊息生效）。`/rename`：重新命名。
  - 其他指令（例如 `/compact`、`/code-review`、各種 skill）會照原樣送給 claude 執行。
  - 卡片只存在這個視窗，重新整理後就會消失。
- **常用 Prompt**：把常打的 prompt 存起來重複使用。
  - 開啟方式：輸入列的 ⚡ 按鈕、`Ctrl+/`，或在輸入框開頭打 `//`（後面接字可以篩選，例如 `//審查`）。
  - ↑↓ 選擇，Enter 插入到游標位置（不會送出），Ctrl+Enter 插入並直接送出。
  - 選單底部可以「＋ 新增」或「把目前輸入存成常用」；每一筆都可以編輯 ✎ 或刪除 🗑。
  - 常用的會排在前面。資料存在 `data/store.json`。
- **新對話**：選資料夾（Explorer 對話框、貼上路徑，或點最近用過的資料夾）。
- **模型 / 程度 / 權限**：每個 session 各自記住，從下一則訊息開始生效。
  - 「每次詢問」模式下，許可請求會以卡片出現在對話中（允許／不再詢問／拒絕並說明）。
  - `AskUserQuestion`（Claude 問你問題）和規劃模式的「核准計畫」也都有對應的卡片。
- **圖片**：可以貼上 (Ctrl+V)、拖放，或用 📎 附加圖片送給 Claude。對話中的圖片、Claude 讀取的圖片檔，以及文字裡出現的圖片路徑，都會顯示縮圖；點一下就在右側分割面板放大（可以拖動分隔線，或切換原始尺寸）。
- **登入**：左下角「登入」會開一個 PowerShell 視窗執行 `claude auth login`，完成後按 ↻ 重新檢查。
- 左下角會顯示帳號和**用量**，和在 claude 裡打 `/usage` 看到的兩條一樣：「目前工作階段（5 小時）」和「本週（全部模型）」，各有進度條、百分比和重置時間（75% 以上變橘色、90% 以上變紅色）。
  - 這是 **claude CLI 登入帳號**的用量（滑鼠移到帳號上可以看到 email 和組織）。
  - 更新方式：在這個 App 送出訊息時會順便更新；按 **↻** 立即更新；或在下拉選單設定自動更新（關／每 1 分／每 5 分／每 15 分，預設 5 分）。
  - 自動更新只在視窗顯示時進行；如果剛送過訊息、數字已經夠新，就會跳過，不會多送請求。
  - 為什麼要送請求：claude 只能從 API 回應中得知用量，`/usage` 在這個 App 使用的模式下不會回傳百分比。所以每次更新會送一個**極小的 Haiku 請求**（約 640 input + 3 output tokens，不帶工具和設定，約 2～3 秒）。多個視窗同時要求時只送一次，20 秒內重複按也不會再送。
  - 重置時間過了以後會顯示「已重置」。重啟 App 後會沿用上一次的數字，並標出更新時間。
- **Context 長度**：輸入列右側（⚡ 按鈕左邊）顯示目前這個 session 已用了多少 context，例如 `Context ▓░░ 85K / 1M (9%)`，每次 Claude 回覆後即時更新；打開既有的 session 時也會從對話紀錄算出來。滑鼠移上去可以看精確數字和模型上限。
  - 計算方式：最後一次回覆送給模型的輸入量（input + cache read + cache creation tokens），和 Claude Code 自己判斷何時要壓縮的依據相同。
  - 上限以 `claude` 回報的模型 context 視窗為準（例如 1M 的模型就顯示 1M），會記在 `data/store.json`。某個模型還沒在這個 App 跑過、不知道上限時，只顯示已用的 token 數。
  - 超過 70% 變黃、超過 90% 變紅；快滿時 Claude 會自動壓縮 (compact) 對話，壓縮後會標「已壓縮」並在下一次回覆後更新。
- 完成訊息只顯示耗時和輸出 token 數，**不顯示金額**（用 Max 方案時金額沒有意義）。

## 運作方式

```
Edge App 視窗  ⇄  server.js (127.0.0.1:47821, SSE + JSON API)  ⇄  claude -p --input-format stream-json --output-format stream-json …
```

- 每一輪對話會啟動一次 `claude -p … --resume <session-id>`（新對話用 `--session-id`），並帶上 `--permission-prompt-tool stdio`，讓許可請求可以從 UI 回覆。
- 對話紀錄**直接讀 CLI 自己的 jsonl 檔**，不另外存一份。所以在這裡和在 PowerShell 用 `claude --resume` 是同一個 session，兩邊可以互相接續。
- App 自己只在 `data/store.json` 存少量資料：標題、釘選、封存、每個 session 的模型／程度／權限設定，以及各模型的 context 上限。
- API 只聽 127.0.0.1，而且需要 `data/token.txt` 裡的隨機權杖，所以其他網頁沒辦法呼叫它。

## 設定（環境變數，選用）

- `CLICTRL_PORT`：連接埠（預設 47821）
- `CLAUDE_BIN`：`claude` 執行檔路徑（預設從 PATH 找）
- `CLAUDE_CONFIG_DIR`：Claude 設定資料夾（預設 `~/.claude`）

## 檔案

```
server.js          後端（Node，無相依）
public/            前端（index.html / app.js / md.js / style.css）
start.vbs          背景啟動
start-debug.cmd    除錯啟動
create-shortcut.ps1
data/              執行時產生：store.json、token.txt、server.log、瀏覽器設定檔
```
