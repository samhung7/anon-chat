# StoaTalk（anon-chat）

匿名、免註冊的線上聊天室，網站在 https://stoatalk.app。架構、部署與設定細節見 `README.md`；這份只寫在這個 repo 裡工作時要遵守的規則。

## 共用開發規範

@docs/dev-standards.md

## 這個專案的做法

### 產品原則
- 一般使用者永遠不需要註冊或登入就能開房、加入、聊天；Google 登入只是可選功能。新功能不能破壞這一點。
- 品牌形象是專業討論平台，不是交友或社群 App，文案與設計都照這個方向。

### 前端結構（`site/js/app/`）
- 純 HTML / CSS / ES modules，沒有 build 步驟；不要引入框架或打包流程。第三方套件放 `site/js/vendor/`（`npm run vendor` 產生）。
- 模組分工寫在 `main.js` 開頭的註解，新增模組要一起更新。
- 所有房間的資料庫寫入都經過 `api.js`（`RoomApi`），畫面模組不直接組路徑寫資料庫。
- 只有 `backend.js` 載入 Firebase。
- 新的訊息種類在 `kinds.js` 的註冊表加一個條目，不要在各處加 `if` 分支。
- 限制值與常數放 `constants.js`；localStorage 的 key 放 `storage.js` 的 `KEYS`。
- 每個 import 都寫成 `./name.js?v=dev`，每個模組都要列進 `site/sw.js` 的 `SHELL`（單元測試會檢查）。
- Safari 會走到的類別不要用私有 `#method`。

### 資料庫規則
- `database.rules.json` 由 `tools/rules.py` 產生：改 `rules.py`，跑 `npm run rules`，兩個檔案一起 commit（CI 會比對）。
- 規則才是真正的權限把關，前端的限制只是體驗；任何權限或上限都要在規則裡擋，並加規則測試。
- `rules.py` 和前端共用的數字（例如人數上限、時間）兩邊都要註明「另一邊也要一致」。

### 多語系
- 九種語言（zh-TW、zh-CN、en、ja、ko、es、fr、de、pt-BR），字典在 `site/js/i18n/<lang>.js`，每種語言的 key 要完全一致。新增文字時九種一起補。
- 程式裡用 `t(key, vars)` 取文字，不寫死字串。

### 測試
- `npm test`：啟動資料庫模擬器並跑 `test/` 底下全部測試（規則、單元、Playwright 端到端）。
- 雲端環境的 proxy 擋住 firebase CLI 時：先在背景跑 `java -jar ~/.cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar --host 127.0.0.1 --port 9000`，再跑 `npm run test:running`。
- 改到行為就補或改測試；改到畫面的 PR 附亮色與暗色截圖。

### Staging 與發佈
- 每個 PR 會自動部署 staging 預覽（`https://<branch>.stoatalk.pages.dev`，接 `stoatalk-staging` Firebase 專案），PR 留言會給網址。請 Sam 在 staging 測過再合併。
- 多個 PR 同時開時，staging 的規則與 worker 是最後一個推送的 PR 的版本；請 Sam 測試前，確認最新的 Staging 執行是這個 PR 的，必要時重跑。
- 合併到 `main` 會自動部署到 production（Cloudflare Pages 與資料庫規則），所以只有在 Sam 同意後才合併。
