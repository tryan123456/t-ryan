# vendor/ — 離線安裝包

兩個各自獨立、互不依賴的離線安裝包。要搬哪個就 tar 哪個，不用整包搬。

| 目錄 | 裝什麼 | 指令 |
|---|---|---|
| [`terminal-browser-offline/`](terminal-browser-offline/README.md) | terminal-browser（終端機裡的瀏覽器）+ 它的 herdr plugin | `terminal-browser` |
| [`tode-offline/`](tode-offline/README.md) | tode / terminal-code（終端機裡的 VS Code）+ code-server + 它的 herdr plugin | `tode` |

每包的結構一樣：

```
install-offline.sh     離線安裝腳本
manifest.txt           artifact 清單 + 官方 sha256
herdr-plugin/          要給 herdr plugin link 的目錄
installers/            上游發佈的安裝腳本原文
LICENSE.upstream       上游的 MIT 授權
artifacts/             release tarball（不在 git 裡）
src/                   上游原始碼快照（不在 git 裡）
```

在目標機器上，兩包都是同一組步驟（細節看各自的 README）：

```bash
./install-offline.sh --list          # 先驗 sha256，不動系統
./install-offline.sh --link-plugin   # 裝本體，再 herdr plugin link
```

兩件共通的事：

- **`artifacts/` 和 `src/` 不在 git 裡**，所以從 clone 下來的包是不完整的，
  補齊指令在各自的 README。`artifacts/` 是因為單檔 128–238 MB 超過 GitHub
  100 MB 硬限制；`src/` 是因為離線安裝根本不需要它（只有查路徑、查版本才用）。
  搬機器用 `tar`（會把兩個都帶上），不要走 git。
- **`herdr plugin install` 在離線環境不能用**，它要 `git fetch` GitHub，
  而且會跑 plugin 的 `[[build]]`（上游是 `curl … | bash`）。
  離線走 `herdr plugin link <絕對路徑>` —— 不碰 git，但也不會跑 `[[build]]`，
  所以本體要先用 `install-offline.sh` 裝好。`--link-plugin` 就是把這兩步接起來。
