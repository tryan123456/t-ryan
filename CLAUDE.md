# CLAUDE.md

Playwright browser automation. Tests in `tests/`, run with `npm test`.
A Playwright MCP server is configured in `.mcp.json` for interactive browser control.

`apps/` 底下是各自獨立的專案，有自己的 `package.json` 與 `node_modules`，
不共用 root 的依賴 — 要在該目錄底下跑 `npm install` / `npm run dev`

## 推送前必須檢查機敏資料

**這是 public repo。** 每次 `git push` 之前 — 包含 `gh repo create --push`、`git push --force`、
建立 PR — 一律先掃過即將公開的內容，確認沒有機敏或可識別資料。

檢查範圍是「這次推送新增的所有內容」，不只是最後一個 commit：

```bash
git diff origin/main..HEAD                          # 尚未推送的變更
git ls-files                                        # 目前 tracked 的所有檔案
git log --format='%an <%ae>%n%cn <%ce>' origin/main..HEAD | sort -u   # commit 身分
```

**第三行不能省。** 洩漏不只發生在「內容」，也發生在 commit metadata — author / committer
的姓名與 email 不會出現在 `git diff` 或 `git ls-files` 裡，所以只掃前兩項會整個漏掉。
本 repo 的正確身分是 `tryan <318998150+tryan123456@users.noreply.github.com>`；
出現任何其他值（尤其是真實 gmail、含 `+公司名` 的 subaddress）就是問題，停下來問 user。

### 要找的東西

**憑證與金鑰**
- `.env`、`.env.local` 等環境變數檔，或任何直接寫死的環境變數值
- token / API key：`gho_`、`ghp_`、`sk-`、`AKIA`、`-----BEGIN * PRIVATE KEY-----`
- 認證設定目錄，例如 `.gh/`（存 gh CLI 的 token）

**可識別資訊**
- 個人或公司 email。注意 `user+tag@gmail.com` 這種 plus-address **不算遮蔽** —
  去掉 `+tag` 就還原成主信箱，而 tag 本身常常又洩漏公司名
- 含使用者名稱的絕對路徑（`/Users/<name>/...`、`/home/<name>/...`）
- GitHub 帳號、真實姓名、公司或部門名稱、專案代號
- 內部網域、主機名稱、內網 IP、非公開的 API endpoint

**機器專屬設定**
- `.claude/settings.local.json`（個人設定，含本機路徑）
- 任何只在單一機器上成立的絕對路徑

### 發現時的處理

**先停下來，不要 push，直接詢問 user。** 說明找到什麼、在哪個檔案的哪一行、
為什麼判斷它是機敏資料，並提供處理選項（加進 `.gitignore`、改用環境變數、
改寫成佔位符、或 user 確認可以公開）。由 user 決定，不要自行判斷「這個應該沒關係」。

若該內容已經被 commit 過，要一併提醒 user：單純刪掉檔案再 commit 是**不夠的**，
舊 commit 仍留有紀錄，需要改寫歷史，而且已經公開過的憑證必須視為外洩、直接輪替。