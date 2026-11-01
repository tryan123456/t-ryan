# tode（terminal-code）離線安裝包

`tode` / `terminal-code`（終端機裡的 VS Code）的**完全離線**安裝方式，
包含它第一次啟動需要的 **code-server**，以及它的 **herdr plugin**。
安裝過程不連任何網路。

目前打包的平台：**linux-x64**（也就是 WSL 走的那個版本）。

> terminal-browser（終端機裡的瀏覽器）是另一包，在 `../terminal-browser-offline/`。
> 兩包各自獨立，可以只搬其中一包。

## 安裝指令

### 步驟 0：在有網路的機器上打包

`artifacts/` 不在 git 裡（單檔超過 GitHub 100 MB 上限，見最後一節），所以要用 tar 搬。

```bash
# 在 vendor/ 目錄底下，也就是 tode-offline/ 的上一層
cd /path/to/repo/vendor
tar -czf tode-offline-linux-x64.tar.gz tode-offline/
```

搬到目標機器並解開：

```bash
scp tode-offline-linux-x64.tar.gz <user>@<host>:~/
# 到目標機器上
tar -xzf ~/tode-offline-linux-x64.tar.gz
cd tode-offline
```

### 步驟 1：先驗包（不需要網路，也不會動到系統）

```bash
./install-offline.sh --list
```

預期輸出：

```
target: linux-x64
  tode          v0.4.3    verified
  code-server   4.132.0   verified
```

兩行都是 `verified` 才繼續。出現 `PROBLEM` 或 `not in bundle` 就是檔案缺了或壞了，別往下走。

### 步驟 2：安裝（**不連網路**）

```bash
# 裝 tode + code-server + 登記 herdr plugin
./install-offline.sh --link-plugin

# 只裝本體，plugin 之後再說
./install-offline.sh
```

裝到別的位置：

```bash
TODE_INSTALL_ROOT=/opt/tode ./install-offline.sh
```

### 步驟 3：把 `~/.local/bin` 加進 PATH

安裝腳本結尾會偵測並印出該怎麼加。沒加的話指令會找不到：

```bash
# zsh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
# bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && exec bash
```

### 步驟 4：確認系統函式庫齊全（離線環境最容易卡在這）

chromium 需要的系統 lib **不在這包裡面**，是預期由 OS 提供的。安裝腳本會自動檢查並印
`warning: missing system libraries`，也可以自己確認：

```bash
ldd ~/.local/lib/tode/node_modules/@zenbu-labs/pixel/electron/dist/pixel | grep 'not found'
```

沒有輸出就是齊的。有輸出代表缺，上游建議補這些：

```bash
sudo apt-get install libnss3 libgtk-3-0 libasound2t64 libgbm1
```

**但離線機器跑不了 `apt-get`** —— 這種情況要另外預先準備對應的 `.deb`／`.rpm`，
這個包沒有涵蓋。詳見「離線環境的已知限制」。

### 步驟 5：跑起來看看

```bash
tode                          # 開目前目錄
tode <folder>                 # 開指定目錄
tode --split right            # 開在右邊的分割視窗
```

herdr plugin 有沒有進去：

```bash
herdr plugin list             # 應該看到 zenbu-labs.tode ... [local:...]
herdr plugin action list      # 應該看到 open-split
```

完整指令列表看 `src/README.md`。

> `tode --upgrade` **需要網路**，它會去抓線上最新版。
> 離線環境不要用；要升級就重新做一包。

## herdr plugin 是怎麼離線裝的

上游的裝法是：

```bash
herdr plugin install zenbu-labs/terminal-code/herdr-plugin
```

這條在離線環境會死兩次 —— `herdr plugin install` 自己要 `git fetch` GitHub，
拿到之後還會跑 plugin 的 `[[build]]`，而那個 build 是
`curl -fsSL https://tode.sh/install | bash`。

離線走的是 herdr 原生就有的另一條路：

```bash
herdr plugin link /絕對路徑/tode-offline/herdr-plugin
```

`link` 完全不碰 git，直接把那個目錄登記進 `~/.config/herdr/plugins.json`
（`source.kind` 會是 `local` 而不是 `github`），plugin 的 action（`open-split`）
跟 `install` 裝的一模一樣。

兩個差別要知道：

1. **`link` 不會跑 `[[build]]`**（實測過）。所以本體要自己先裝 —— 也就是
   `install-offline.sh` 做的事，`--link-plugin` 只是幫你把兩步接起來，
   順序是「先裝本體，再 link」。
2. **路徑必須是絕對路徑**，而且 link 之後**這個目錄不能刪或搬**。
   herdr 記的是路徑本身，目錄不見了 action 就會壞。
   建議放在固定位置，例如 `/opt/zenbu-offline/tode-offline`。
3. `link` 本身**不需要 herdr server 正在跑**（它只寫 `plugins.json`），
   但 `herdr plugin action list` / 真的去用 `open-split` 需要。
   沒跑 herdr 的話會看到 `server_not_running`，那不是 plugin 壞掉。

`herdr-plugin/herdr-plugin.toml` 相對上游只動了 `[[build]]` 那一行，
改成呼叫 `build.sh`（再轉給 `install-offline.sh`），確保就算哪天 build 真的被跑到，
也不會有人去連網路。`id`、action 定義都跟上游一致。

要拔掉：

```bash
herdr plugin unlink zenbu-labs.tode
```

## 為什麼需要這包：tode 不是自帶全部東西的

這是整件事的關鍵，也是單純把 tarball 載下來不夠的原因。

`src/src/codeserver/vendored.ts` 裡的 `ensureCodeServer()`
會在**第一次啟動時**去 GitHub 抓 code-server 4.132.0（約 238 MB）：

```
https://github.com/coder/code-server/releases/download/v4.132.0/code-server-4.132.0-linux-amd64.tar.gz
```

所以就算 tode 本體已經裝好，沒網路的機器上第一次開還是會失敗。
`install-offline.sh` 會預先把 code-server 解到 `installedCodeServer()` 會去找的那個路徑
（`DATA_DIR/code-server/<version>/bin/code-server`），讓那段下載永遠不會被觸發。

> 升級 tode 時要注意：如果新版的 `CODE_SERVER_VERSION` 變了，它會去抓**新版本**的
> code-server。那時要重新把對應版本加進這個包，光更新 tode tarball 不夠。

## 安裝位置與選項

裝完的位置（跟線上安裝完全一致）：

| | 路徑 |
|---|---|
| tode | `~/.local/lib/tode`，指令 `~/.local/bin/tode` |
| code-server | `~/.local/share/tode/code-server/4.132.0` |
| herdr plugin | 不複製，直接指向這包的 `herdr-plugin/` |

| 選項 | 作用 |
|---|---|
| `--list` | 列出包內有哪些平台的檔案並驗證 sha256，不安裝 |
| `--link-plugin` | 裝完本體後順便 `herdr plugin link` |
| `--no-code-server` | 不預先放 code-server。**tode 首次啟動就會需要網路** |
| `--target <t>` | 覆寫平台偵測（只對 `--list` 有意義，見「不能跨平台安裝」） |
| `-h`, `--help` | 說明 |

環境變數：

- `TODE_INSTALL_ROOT=<dir>` — 把 tode 裝到別的地方

重複執行是安全的：安裝採用「解到旁邊再原子 rename」的方式，code-server 已存在就會跳過。

## 離線環境的已知限制

**1. 系統函式庫不在包裡（最可能卡住的一點）**

chromium 需要 `libnss3`、`libgtk-3-0`、`libasound2t64`、`libgbm1` 這類系統 lib，
上游預期由 OS 提供 —— 安裝腳本自己就會做 `ldd` 檢查然後建議你 `apt-get install`
（`src/scripts/install.sh:93`）。

- 一般桌面發行版通常本來就有 → 直接可用
- 精簡的 server / container image 很可能缺 → **安裝會成功，但啟動時才掛掉**

而離線機器正好跑不了 `apt-get`。要完全排除這個風險，得照目標機器的發行版版本
另外預先抓對應的 `.deb`／`.rpm` 放進來，**這個包沒有涵蓋**。
請務必做完「步驟 4」再認定可用。

**2. 升級需要網路**

`tode --upgrade` 是去線上抓最新版，離線環境不能用。
升級的做法是在有網路的機器重新做一包再搬過去。

**3. 擴充套件安裝需要網路**

`tode --install-extension <id>` 會去 marketplace 抓。離線只能用 `.vsix` 檔：
`tode --install-extension /path/to/ext.vsix`。

**4. 驗到哪裡 / 還沒驗到哪裡**

2026-11-01 在 **linux/amd64 容器、`--network none`**（Apple Silicon + colima/Rosetta，
`ubuntu:24.04` 預先補上那四個 chromium lib）跑過完整流程，確認：

- `--list` 兩個 sha256 都過
- `./install-offline.sh --link-plugin` 跑完，`tode --version` 回 `v0.4.3`
- code-server 被放到 `~/.local/share/tode/code-server/4.132.0/bin/code-server`，
  直接跑它回 `4.132.0 ... with Code 1.132.0`
- `ldd .../pixel` 沒有 `not found`
- 重跑安裝腳本會印 `code-server 4.132.0 already in place` 然後正常結束（冪等）
- 餵壞掉的 tarball：先被 `manifest.txt` 的 sha256 擋下；把 manifest 改成壞檔的 sha
  再試一次，則被上游 `PLATFORMS` 的 sha256 擋在
  `the download did not match its hash`，兩次都沒有裝進任何東西
- `herdr plugin link` 在乾淨的 herdr 0.9.5 上登記成 `local:`
- 對照組：`herdr plugin install zenbu-labs/terminal-code/herdr-plugin` 在同一個
  容器裡失敗 —— 這就是為什麼離線要走 `link`
- 從**乾淨的 git clone**（沒有 `src/`）只補 `artifacts/`，同一組流程再跑一次也通 ——
  也就是 git 裡的檔案本身就夠裝

**還沒驗的**：真正的裸機／VM linux（容器沒有 GUI、沒有 TTY，所以沒有真的把
`tode` 的編輯器畫面開起來過 —— 也就是說「第一次啟動不會去抓 code-server」這件事
是從路徑和檔案存在推出來的，不是看著它開起來的）、以及 linux-x64 以外的平台。
第一次部署還是請照「步驟 4、5」確認一次。

## install-offline.sh 是怎麼改寫的

沒有重寫上游的安裝邏輯。`installers/` 底下是上游**實際發佈**的安裝腳本原文
（就是 `curl -fsSL https://tode.sh/install` 會拿到的那份，版本號已代入），
只動一行 — 那唯一一行下載：

```diff
-curl -fL --retry 3 --retry-delay 2 --progress-bar "$DOWNLOAD_URL" -o "$TARBALL"
+cp -- "$OFFLINE_TARBALL" "$TARBALL"
```

這樣做的理由：

- **不會跟上游行為分岔。** 原子 rename、關掉舊 daemon、Linux 缺少系統函式庫的 `ldd` 檢查、
  `install.json`、PATH 提示 —— 全都還是上游自己的程式碼。
- **校驗碼仍然是上游發佈的那組。** 腳本裡的 `PLATFORMS` 表**完全沒動**，
  所以它比對的 sha256 還是官方那個值，被換過或壞掉的 tarball 一樣會在那裡被擋下來
  （已實測：故意餵錯檔案會停在 `the download did not match its hash`）。
- 代換會**斷言只能命中一次**。上游哪天把那行改寫了，腳本會直接報錯停下，
  而不是悄悄留著一行會連網的 curl。另外也會檢查代換後的檔案裡不再有任何 `curl` / `wget`。

`install-offline.sh` 自己在複製之前，也會先用 `manifest.txt` 的 sha256 驗一次，
所以每個 tarball 總共被驗兩次。code-server 則是由 `install-offline.sh` 自己驗、自己解。

### 不能跨平台安裝

上游腳本會自己用 `uname` 判斷平台、自己選 `PLATFORMS` 的那一列。
所以 `--target` 只能換「要用包裡哪個檔案」，換不掉上游的判斷結果 ——
在 Mac 上硬指定 `--target linux-x64` 只會讓它拿 linux 的檔案去對 darwin 的 sha256 然後失敗。
腳本因此會直接拒絕這種組合，不讓它跑到深處才爆。**要在目標機器上執行。**

## Windows

**沒有官方 Windows build。** release 只有這四個平台：
`darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`，
安裝腳本的 `uname` case 會直接拒絕其他組合。

官方說法是走 **WSL**，裡面裝 linux-x64 版 —— 也就是這個包。

## 這個目錄裡有什麼

```
install-offline.sh     離線安裝腳本（含 code-server 預放）
manifest.txt           artifact 清單 + 官方 sha256
herdr-plugin/          要給 herdr plugin link 的目錄（build 改成走離線安裝）
installers/            上游發佈的安裝腳本原文（只在執行時被改掉那一行）
LICENSE.upstream       上游的 MIT 授權（installers/ 和 herdr-plugin/ 都是它的程式碼）
artifacts/             release tarball（不在 git 裡，見下）
src/                   上游原始碼快照（不在 git 裡，見下）
```

### 版本

| | 版本 | 來源 commit |
|---|---|---|
| terminal-code | v0.4.3 | `b049d7c1ce04d36008c1657f822d3e6f324efc36` |
| code-server | 4.132.0 | 由 `src/src/codeserver/vendored.ts` 的 `CODE_SERVER_BUILDS` 釘住 |

上游是 MIT，授權條文留在 `LICENSE.upstream`。

### `artifacts/` 和 `src/` 為什麼不進 git

- **`artifacts/`**：單檔 128–238 MB，**超過 GitHub 單檔 100 MB 的硬限制**，push 會被拒絕。
- **`src/`**：離線安裝根本不需要它 —— 安裝只用 `installers/` 和 `artifacts/`。
  它留在本機是為了查路徑（例如 `ldd` 要看哪個檔案）跟查 `CODE_SERVER_VERSION`
  釘在哪一版，升版時會用到。

兩個都被根目錄 `.gitignore` 擋著（`/vendor/*/artifacts/`、`/vendor/*/src/`），
所以**從 git clone 下來的這包是不完整的**，要先補齊才能用。
搬機器請用最前面那條 `tar` 指令（會把兩個都帶上），不要走 git。

從乾淨的 clone 補齊（需要網路）：

```bash
# artifacts/（git 不追蹤空目錄，所以 clone 下來沒有這個資料夾，要自己建）
mkdir -p artifacts && cd artifacts
curl -fLO https://github.com/zenbu-labs/terminal-code/releases/download/v0.4.3/tode-linux-x64.tar.gz
curl -fLO https://github.com/coder/code-server/releases/download/v4.132.0/code-server-4.132.0-linux-amd64.tar.gz
cd ..

# src/（升版時要看 CODE_SERVER_VERSION，不補也能裝）
git clone https://github.com/zenbu-labs/terminal-code.git src
git -C src checkout b049d7c1ce04d36008c1657f822d3e6f324efc36
rm -rf src/.git

./install-offline.sh --list    # 驗 sha256
```

### 要加其他平台

1. 從 release 下載該平台的兩個 tarball 到 `artifacts/`
   （code-server 的檔名對應：`linux-x64`→`linux-amd64`、`darwin-arm64`→`macos-arm64`、
   `darwin-x64`→`macos-amd64`、`linux-arm64`→`linux-arm64`）
2. 在 `manifest.txt` 加上對應的列，sha256 取自
   <https://tode.sh/install/latest.json> 以及 `vendored.ts` 的 `CODE_SERVER_BUILDS`
3. `./install-offline.sh --list --target <t>` 確認驗得過

`installers/` 不用動 —— 同一份腳本涵蓋所有平台。
但**如果上游出了新版**，要重新抓發佈腳本：

```bash
curl -fsSL https://tode.sh/install -o installers/tode-v<新版>-install.sh
```

然後更新 `install-offline.sh` 裡 `INSTALLER_SCRIPT` 的檔名。
