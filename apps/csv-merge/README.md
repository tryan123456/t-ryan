# csv-merge

把多個「二維」CSV 依複合主鍵合併成一個 CSV，偵測主鍵衝突，並讓呼叫端決定要**放棄**、**覆蓋**或**保留全部**。

以 Rust 實作，透過 [napi-rs](https://napi.rs/) 提供給 Node.js / Electron 使用。同一份程式碼可以編成：

- **原生模組**（`.node`）：最快
- **WebAssembly**（`wasm32-wasip1-threads`）：一個 `.wasm` 檔就能在所有平台執行，不需要 Windows 的 MSVC 工具鏈

另外 `ts/` 底下有一份**功能完全相同的 TypeScript 版**：API 一樣、輸出逐 byte 相同，不需要 Rust 或任何原生工具鏈。見 [TypeScript 版](#typescript-版)。

設計目標是處理數百 MB 的大檔：**cell 的值不會讀進記憶體**，只建立主鍵索引，峰值記憶體約為「每個輸入列 50 bytes」。

---

## 目錄

- [輸入格式](#輸入格式)
- [建置](#建置)
- [快速開始](#快速開始)
- [API](#api)
- [合併規則](#合併規則)
- [在 Electron 裡使用](#在-electron-裡使用)
- [TypeScript 版](#typescript-版)
- [效能](#效能)
- [限制](#限制)
- [測試與 benchmark](#測試與-benchmark)
- [專案結構](#專案結構)

---

## 輸入格式

每個 CSV 都是一張二維表：

- 前 `colKeyRows` 列是**欄的 header**，多列組成一個欄的複合主鍵
- 前 `rowKeyCols` 欄是**列的 key**，多欄組成一個列的複合主鍵
- 其餘的格子是值

以 `rowKeyCols: 2`、`colKeyRows: 2` 為例：

```
              ┌──────── 欄的複合主鍵（2 列）────────┐
region, id,   2024,     2024,  2025         ← header 第 1 層
region, id,   revenue,  cost,  revenue      ← header 第 2 層
TW,     001,  100,      60,    120
JP,     002,  200,      150,
└─列的複合主鍵（2 欄）─┘
```

- 欄 `(2024, revenue)` 和 `(2025, revenue)` 是不同的欄，要所有層組合起來才唯一
- 列 `(TW, 001)` 同理
- 每個 cell 由 `(列主鍵, 欄主鍵)` 唯一決定

格式細節：

- 編碼必須是 **UTF-8**，開頭有沒有 BOM 都可以
- 遵循 RFC 4180：值可以用雙引號包起來，引號內可以有逗號、換行，`""` 代表一個 `"`
- 換行 `\n` 或 `\r\n` 都可以，空白行會略過
- 比對主鍵時用的是**去掉引號後**的值，所以 `"TW"` 和 `TW` 視為同一個 key

---

## 建置

需要 Rust（rustup）和 Node.js。

```bash
cd apps/csv-merge
npm install

# 原生版（目前機器的平台）
npm run build

# WebAssembly 版（第一次需要先加 target）
rustup target add wasm32-wasip1-threads
npm run build:wasm
```

產出：

| 檔案 | 說明 |
|---|---|
| `index.js` / `index.d.ts` | 進入點與 TypeScript 型別。會自動選擇原生版或 WASM 版 |
| `csv-merge.<平台>.node` | 原生模組，例如 `csv-merge.darwin-arm64.node` |
| `csv-merge.wasm32-wasi.wasm` | WebAssembly 模組 |
| `csv-merge.wasi.cjs`、`wasi-worker.mjs` | WASM 的載入器與 worker，**必須和 `.wasm` 放在同一個目錄** |

`index.js` 會先嘗試載入原生版，失敗時才改用 WASM 版。可以用 `__napiBindingTarget` 確認實際載入的是哪一個：

```js
const { __napiBindingTarget } = require('./index.js')
console.log(__napiBindingTarget) // 'native' 或 'wasm32-wasi'
```

設定環境變數 `NAPI_RS_FORCE_WASI=true` 可以強制使用 WASM 版，適合用來測試。

---

## 快速開始

```js
const { openMergeJob } = require('./index.js')
const os = require('node:os')

// 第一步：建立索引（第一遍掃描），只讀主鍵，不讀值
const job = await openMergeJob(['a.csv', 'b.csv'], {
  rowKeyCols: 2,
  colKeyRows: 2,
  threads: Math.min(os.availableParallelism(), 8),
  aliases: ['2024年報', '2025修正'], // 選填：來源名稱，也是 keepAll 的 suffix
})

// 第二步：看衝突摘要（純粹從索引計算，不會再讀檔）
const summary = job.conflicts()

// 需要的話，分頁取出衝突的主鍵和來源給使用者看
const rows = await job.conflictRows(0, 100) // [{ key: ['TW','001'], sources: ['2024年報','2025修正'] }, ...]
const cols = await job.conflictCols(0, 100) // [{ key: ['2025','revenue'], sources: [...] }, ...]

if (summary.totalCells === 0) {
  await job.merge('merged.csv', 'overwrite') // 沒有衝突，選哪個策略結果都一樣
} else {
  const choice = await askUser(summary) // 'abort' | 'overwrite' | 'keepAll'
  if (choice !== 'abort') {
    await job.merge('merged.csv', choice)
  }
  // 放棄：不呼叫 merge 就好，不會產生任何檔案
}
```

### 實際範例

`a.csv`：

```csv
region,id,2024,2024,2025
region,id,revenue,cost,revenue
TW,001,100,60,120
JP,002,200,150,
```

`b.csv`：

```csv
region,id,2025,2025
region,id,revenue,cost
TW,001,130,70
US,003,90,40
```

`(TW,001)` × `(2025,revenue)` 這一格兩個檔案都有，所以是 1 個衝突。`job.conflicts()` 會回傳：

```json
{
  "totalCells": 1,
  "pairs": [{ "a": 0, "b": 1, "rows": 1, "cols": 1, "cells": 1 }],
  "files": [
    { "path": "a.csv", "alias": "a", "bytes": 90, "rows": 2, "valueCols": 3 },
    { "path": "b.csv", "alias": "b", "bytes": 70, "rows": 2, "valueCols": 2 }
  ],
  "outRows": 3,
  "outValueCols": 4,
  "duplicateRowKeys": 0,
  "duplicateColKeys": 0,
  "conflictRows": 1,
  "conflictCols": 1
}
```

衝突的主鍵：

```js
await job.conflictRows(0, 100) // [{ key: ['TW', '001'], sources: ['a', 'b'] }]
await job.conflictCols(0, 100) // [{ key: ['2025', 'revenue'], sources: ['a', 'b'] }]
```

**`overwrite`**：後面的檔案蓋掉前面的，`120` 變成 `130`

```csv
region,id,2024,2024,2025,2025
region,id,revenue,cost,revenue,cost
TW,001,100,60,130,70
JP,002,200,150,,
US,003,,,90,40
```

**`keepAll`**：b 的 `(2025,revenue)` 另外放一欄，欄名加上 `@b`（沒有指定 `aliases` 時，alias 就是檔名）

```csv
region,id,2024,2024,2025,2025,2025
region,id,revenue,cost,revenue,revenue@b,cost
TW,001,100,60,120,130,70
JP,002,200,150,,,
US,003,,,,90,40
```

注意 `US,003` 那列：b 的 revenue 雖然沒有衝突，也一樣放在 `revenue@b`。詳見下方[保留全部](#keepall保留全部)。

如果開啟時傳了 `aliases: ['2024年報', '2025修正']`，那一欄就會是 `revenue@2025修正`，`conflictRows` / `conflictCols` 回傳的 `sources` 也會是這兩個名稱。

---

## API

完整型別見 `index.d.ts`。

### `openMergeJob(files, options): Promise<MergeJob>`

第一遍掃描：平行讀取所有檔案，建立列和欄的主鍵索引，並計算檔案兩兩之間的重疊。在背景執行緒執行，不會阻塞 JS 主執行緒。

| 參數 | 型別 | 說明 |
|---|---|---|
| `files` | `string[]` | CSV 路徑，1～64 個。**順序很重要**：決定輸出的列/欄順序，以及覆蓋時誰蓋誰 |
| `options.rowKeyCols` | `number` | 前幾欄是列的主鍵 |
| `options.colKeyRows` | `number` | 前幾列是欄的 header（至少 1） |
| `options.threads` | `number?` | 執行緒數，兩遍都會用。預設：原生版 `min(核心數, 8)`，WASM 版 `4` |
| `options.aliases` | `string[]?` | 每個檔案一個來源名稱，用在 `keepAll` 的 `@<alias>` suffix，以及衝突報告的 `sources`。數量要和 `files` 一樣、不能是空字串、不能重複，否則會 reject。預設是檔名去掉副檔名 |

> **WASM 請一定要傳 `threads`。** WASI 環境偵測不到 CPU 核心數，不傳就只能用預設的 4。建議傳 `Math.min(os.availableParallelism(), 8)`。

格式錯誤時會 reject，例如檔案不存在、header 列數不足、各層 header 的欄數不一致。

### `job.openMs: number`

第一遍花的時間（毫秒）。

### `job.conflicts(): ConflictSummary`

同步回傳衝突摘要，完全從索引計算，不讀檔，可以重複呼叫。

| 欄位 | 說明 |
|---|---|
| `totalCells` | 衝突的格數（所有檔案對加總） |
| `pairs[]` | 有衝突的檔案對：`a`、`b` 是 `files` 的 index（`a < b`），`rows`、`cols` 是重疊的列數和欄數，`cells = rows × cols` |
| `files[]` | 每個檔案的 alias、大小、列數、值欄數 |
| `outRows` | 輸出的列數 |
| `outValueCols` | 輸出的值欄數（不含 `keepAll` 額外加的欄），可以用來在 UI 上預估輸出大小 |
| `duplicateRowKeys` / `duplicateColKeys` | **同一個檔案內**重複的主鍵數量。重複的列只取第一筆 |
| `conflictRows` / `conflictCols` | 參與衝突的列主鍵、欄主鍵數量，用 `conflictRows()` / `conflictCols()` 分頁取出 |

### `job.conflictRows(offset, limit): Promise<ConflictKey[]>`<br>`job.conflictCols(offset, limit): Promise<ConflictKey[]>`

分頁取出參與衝突的列主鍵／欄主鍵，依輸出順序排列。每一筆是：

```ts
{ key: string[], sources: string[] }
// key：複合主鍵的各個部分（已去掉引號）
// sources：這個主鍵在哪些來源之間衝突，用 alias 表示，依檔案順序
```

**某一格 `(r, c)` 的衝突來源 = `r.sources ∩ c.sources`**，交集至少兩個就是衝突。這個關係是精確的，所以只要列和欄兩份清單，就能還原每一格的衝突，不需要一格一格列出（衝突格數可能是「列 × 欄」，動輒上千萬）。

- 欄主鍵直接從記憶體中的 header 取得，幾乎沒有成本
- 列主鍵的文字沒有存在記憶體裡，會依 offset 回頭讀檔，成本跟 `limit` 成正比
- 超出範圍的部分會回傳空陣列；`offset`、`limit` 是 32-bit 無號整數（取全部可以用 `2 ** 31`）
- 可以在 `merge` 之前或之後呼叫，也可以呼叫多次

### `job.merge(outPath, policy): Promise<MergeStats>`

第二遍：依策略串流寫出結果。

- `policy`：`'overwrite'` 或 `'keepAll'`
- 先寫到 `<outPath>.partial`，**成功後才 rename** 成 `outPath`；失敗時會刪掉 `.partial`，不會留下寫到一半的檔案
- 同一個 job 可以呼叫多次，例如兩種策略各輸出一份

回傳 `{ rows, cols, bytesWritten, elapsedMs }`，其中 `cols` 包含 key 欄。

### `wasmMemoryBytes(): number`

WASM 版目前的 linear memory 大小；原生版回傳 0。linear memory 只會增加、不會縮小，所以這個值就是峰值，適合用來監控是否接近 4GB 上限。

---

## 合併規則

### 什麼算衝突

**同一個 `(列主鍵, 欄主鍵)` 同時出現在兩個檔案裡，就算衝突，不比較值。** 值相同、或其中一邊是空白，也都算。

這樣定義的好處是：衝突數量等於「列的交集 × 欄的交集」，從索引直接相乘就能得到，不需要讀任何 cell。

### 輸出順序

- **列**：依第一次出現的順序。先是第 1 個檔案的所有列，然後是第 2 個檔案中新出現的列，以此類推
- **欄**：同樣依第一次出現的順序
- **左上角**的 key 欄標題（例如 `region,id`）取自第 1 個檔案

### `overwrite`（覆蓋）

- 同一格有多個來源時，**排在後面的檔案優先**
- **空白不會蓋掉值**：後面檔案的這一格如果是空的（`` 或 `""`），保留前面檔案的值

### `keepAll`（保留全部）

規則以**欄**為單位：檔案 B 的某一欄，只要和前面某個檔案 A 的同名欄有任何一格衝突（也就是同一欄，而且 A、B 有共同的列），**B 的這一整欄**就會另外輸出成新的一欄：

- 新欄的 header 只在**最後一層**加上 `@<alias>`，例如 `revenue@b`。alias 由 `options.aliases` 指定，沒指定時是檔名去掉副檔名
- 沒指定 alias、而且多個檔案的檔名相同時（例如 `x/data.csv` 和 `y/data.csv`），從第二個開始會加上序號：`data#2`
- alias 含有逗號、引號等字元時，header 會自動依 CSV 規則加上引號
- 這一欄**沒有衝突的列也會放在 `@` 欄裡**，不會回填到原本的欄。這樣每個欄位的來源一致，比較好追查
- 沒有衝突的欄照常合併到同一欄

### 放棄

不呼叫 `merge` 就是放棄，因為衝突偵測在任何寫入之前就已經完成。這時的成本只有第一遍掃描。

---

## 在 Electron 裡使用

**只在 main process（或 `utilityProcess`）裡載入**，renderer 透過 IPC 呼叫：

```js
// main.js
const { ipcMain } = require('electron')
const os = require('node:os')
const { openMergeJob } = require('csv-merge')

const jobs = new Map()

ipcMain.handle('csv-merge:open', async (_e, files, options) => {
  const job = await openMergeJob(files, {
    ...options,
    threads: Math.min(os.availableParallelism(), 8),
  })
  const id = crypto.randomUUID()
  jobs.set(id, job)
  return { id, summary: job.conflicts() }
})

ipcMain.handle('csv-merge:conflict-rows', (_e, id, offset, limit) => jobs.get(id).conflictRows(offset, limit))
ipcMain.handle('csv-merge:conflict-cols', (_e, id, offset, limit) => jobs.get(id).conflictCols(offset, limit))

ipcMain.handle('csv-merge:merge', async (_e, id, outPath, policy) => {
  const job = jobs.get(id)
  jobs.delete(id)
  return job.merge(outPath, policy)
})

ipcMain.handle('csv-merge:abort', (_e, id) => {
  jobs.delete(id) // 釋放索引記憶體
})
```

注意事項：

- **不會阻塞 main process**：`openMergeJob` 和 `merge` 都在背景執行緒執行，UI 不會凍結
- **用完要釋放 job**：job 持有整份索引，大約每個輸入列 50 bytes，1000 萬列約 500MB。不需要時把參照拿掉，交給 GC 回收
- **asar 打包**：`.node`、`.wasm`、`csv-merge.wasi.cjs`、`wasi-worker.mjs` 都要放在 asar 外面。以 electron-builder 為例：
  ```json
  { "asarUnpack": ["**/csv-merge/*.node", "**/csv-merge/*.wasm", "**/csv-merge/*.wasi.cjs", "**/csv-merge/wasi-worker.mjs"] }
  ```
- **Bundler**：如果 main process 有用 webpack/vite 打包，要把 `csv-merge` 設成 external，因為 `index.js` 會依平台動態 `require`
- **只出 WASM 版**的話，可以完全不用處理各平台的原生建置；`index.js` 找不到原生模組時會自動改用 WASM

---

## TypeScript 版

`ts/` 是 Rust 版的逐一移植：同樣的 API、同樣的兩遍演算法與資料結構、同樣的平行方式，輸出和 Rust 版**逐 byte 相同**（正確性測試和大型輸出比對都包含它）。

```js
import { openMergeJob } from './ts/index.ts'

const job = await openMergeJob(files, { rowKeyCols: 2, colKeyRows: 2 })
const summary = job.conflicts()
await job.merge('merged.csv', 'keepAll')
```

Node.js 23.6 以上可以直接執行 `.ts`（內建 type stripping），不用 build。型別檢查：`npm run typecheck`。

**和 Rust 版的對應**

| Rust | TypeScript |
|---|---|
| 執行緒（`std::thread`） | `worker_threads`。整個 job 跑在一個專屬 worker 裡，第一遍和第二遍再各自開 worker，**呼叫端的執行緒不會被阻塞** |
| `Vec<u128>`、`Vec<u64>`、`Vec<u32>` | `Uint32Array`（每個 hash 4 個 word）、`Float64Array`、`Uint32Array` |
| hashbrown `HashTable<u32>` | 自己實作的 open-addressing 表（`Uint32Array`，容量公式相同） |
| 多執行緒共用的索引 | `SharedArrayBuffer`，render worker 直接讀，不複製 |
| xxh3-128 | MurmurHash3 x86_128（JS 能用 32-bit 運算高效實作）。hash 只用在內部比對，不影響輸出 |
| `memchr2` | `Buffer.indexOf`，並快取下一個引號和換行的位置，避免重複掃描 |
| 物件被 GC 時釋放索引 | `FinalizationRegistry` 在 `MergeJob` 被回收時結束 worker |

**在 Electron 裡使用**

- Electron 內建的 Node 版本不一定支援直接執行 `.ts`，請先用 `tsc` 或 esbuild 編成 `.js`
- 編譯時要保留 `job-worker`、`index-worker`、`render-worker` 為**獨立檔案**（`new Worker(new URL(...))` 會在執行期載入它們），不能全部打包成一個檔案
- 預設的 `threads` 用 `os.availableParallelism()`，不會像 WASM 一樣偵測不到核心數

---

## 效能

以下數字在 Apple M5 Pro（18 核）、Node 25 上測得，測資剛產生完、還在 OS 的 page cache 裡。每個輸入檔約 290MB，主鍵都是 2 層，`threads: 8`。一般的 Windows 筆電核心數較少、SSD 也比較慢，時間會更長。

| 情境 | 檔案數 | 每檔 列 × 欄 | 輸入合計 | 輸出 列 × 欄 | 原生 | WASM | TypeScript |
|---|---|---|---|---|---|---|---|
| 直向接起來（列不重疊、欄相同） | 5 | 200 萬 × 20 | 1000 萬列，1.3GB | 1000 萬 × 20，1.3GB | 0.74s / 599MB | 1.36s / 647MB | 2.15s / 834MB |
| 相鄰檔案列重疊 50%，`overwrite` | 5 | 200 萬 × 20 | 1000 萬列，1.3GB | 600 萬 × 20，0.8GB | 0.77s / 522MB | 1.61s / 611MB | 1.97s / 805MB |
| 同上，`keepAll` | 5 | 200 萬 × 20 | 1000 萬列，1.3GB | 600 萬 × 100，1.7GB | 0.95s / 530MB | 1.82s / 616MB | 2.29s / 797MB |
| 相鄰檔案列重疊 50%，`overwrite` | 8 | 200 萬 × 20 | 1600 萬列，2.1GB | 900 萬 × 20，1.2GB | 1.30s / 874MB | 3.09s / 874MB | 3.08s / 1112MB |
| 同上，`keepAll` | 8 | 200 萬 × 20 | 1600 萬列，2.1GB | 900 萬 × 160，3.1GB | 1.84s / 883MB | 4.39s / 877MB | 3.89s / 1112MB |
| 橫向接起來（欄不重疊、列相同） | 5 | 450 × 10 萬 | 50 萬欄，1.4GB | 450 × 50 萬，1.4GB | 0.45s / 325MB | 0.70s / 498MB | 1.09s / 799MB |
| 相鄰檔案欄重疊 50%，`keepAll` | 5 | 450 × 10 萬 | 50 萬欄，1.4GB | 450 × 50 萬，1.4GB | 0.46s / 296MB | 0.72s / 483MB | 1.14s / 790MB |
| 列、欄都不重疊（輸出膨脹） | 5 | 1 萬 × 4500 | 5 萬列 × 2.25 萬欄，1.4GB | 5 萬 × 2.25 萬，2.2GB | 0.56s / 141MB | 1.10s / 325MB | 1.47s / 391MB |

- 欄數都是**值欄**，另外每個檔案和輸出都還有 2 個 key 欄；header 有 2 列
- 原生、WASM、TypeScript 三欄是「第一遍 + 第二遍的總時間 / 峰值 RSS」；峰值 RSS 包含 Node 本身約 40MB

整體來說，**WASM 是原生的 1.5～2.7 倍時間，TypeScript 是 2.1～3.0 倍**。TypeScript 在列很多、檔案很多時第一遍甚至比 WASM 快；第二遍則是 WASM 較快。

**列出衝突主鍵的成本**（`bench/conflict-keys.mjs`）

| 情境 | 檔案數 | 每檔 列 × 欄 | 衝突列 / 衝突欄 | 取第一頁 1000 筆 | 原生 取全部 | WASM 取全部 | TS 取全部 |
|---|---|---|---|---|---|---|---|
| 相鄰檔案列重疊 50% | 5 | 200 萬 × 20 | 400 萬 / 20 | 1～6ms | 1.9s | 11.1s | 3.6s |
| 相鄰檔案列重疊 50% | 8 | 200 萬 × 20 | 700 萬 / 20 | 1～6ms | 3.4s | 19.7s | 6.5s |
| 相鄰檔案欄重疊 50% | 5 | 450 × 10 萬 | 450 / 20 萬 | 1～15ms | 0.1s | 0.6s | 0.2s |

- 「取全部」是以每頁 10 萬筆一路取完、不保留結果的時間
- 建立衝突清單是第一遍的一部分，對第一遍時間的影響在量測誤差內；記憶體每個衝突列多 4 bytes
- **WASM 一次取大量資料特別慢**：每個字串、陣列、物件都要經過 WASM ↔ JS 的邊界建立。給 UI 分頁顯示完全沒問題；如果要輸出完整的衝突報告，用原生版或 TS 版會快很多

**怎麼估算記憶體**

- 列很多的檔案：峰值約為 **總輸入列數 × 50 bytes**，跟檔案大小和欄數無關
- 欄很多的檔案：主要取決於 `threads`。每個 worker 要放好幾列資料（一列可能有數百 KB），想壓低記憶體就減少 `threads`
- WASM 的 linear memory 上限是 4GB，照上面的比例大約可以處理 6000 萬列以上（未實測）
- TypeScript 版的峰值比原生多 30%～150%：每個 worker 都有自己的 V8 isolate，第二遍每一批的輸出 buffer 也要等 GC 才會釋放。不過沒有 WASM 那種 4GB 的總量上限

**怎麼估算時間**

- 第一遍是 I/O 加上解析主鍵，原生版約 2～5GB/s，WASM 大約慢 2～2.5 倍
- 第二遍取決於**輸出**大小，兩者差距較小
- WASM 沒有傳 `threads` 時預設只用 4 條執行緒，會明顯變慢

---

## 限制

- **只支援 UTF-8**。從 Excel 匯出的 Big5/CP950 CSV 要先轉碼
- **主鍵用 128-bit hash 比對**，沒有再回頭核對原始字串。兩個不同的 key 撞到同一個 hash 的機率極低（1600 萬列時低於 10⁻²⁴），但不是零
- **同一個檔案內**重複的列主鍵只取第一筆；重複的欄主鍵會合併成同一欄，後面的欄優先。數量會回報在 `duplicateRowKeys` / `duplicateColKeys`
- 最多 64 個檔案，所有檔案的總列數必須少於 2³² − 1
- 所有檔案的 header 列數必須相同（`colKeyRows`）；每個檔案各層 header 的欄數要一致
- 輸出超過 16,384 欄時，**Excel 打不開**
- 執行期間不要修改輸入檔：第二遍會依第一遍記下的 byte offset 回頭讀取

---

## 測試與 benchmark

```bash
# Rust 單元測試（CSV 掃描器）
cargo test --lib

# TypeScript 型別檢查
npm run typecheck

# 正確性測試：隨機產生小型案例（約一半帶 alias），比對原生版、WASM 版、TypeScript 版與 JS 參考實作，
# 合併輸出必須逐 byte 一致，conflictRows / conflictCols 也必須完全相同
# 需要先 build 原生版和 WASM 版
npm test                                      # 預設 300 組
node --no-warnings test/correctness.mjs 1000  # 指定組數

# 產生 benchmark 測資到 data/（約 9GB，已 gitignore）
npm run gen                    # 全部 case
node bench/gen.mjs wide-join   # 只產生指定的 case

# 執行 benchmark：每次都在獨立程序裡跑，用 /usr/bin/time 量峰值記憶體
npm run bench                      # 全部 case，結果另存 out/results.json
node bench/bench.mjs tall-overlap  # 指定 case
BACKENDS=native,ts npm run bench   # 只跑指定的實作（native、wasm、ts）

# 列出衝突主鍵的成本（第一頁、全部）
node bench/conflict-keys.mjs tall-overlap wide-overlap

# 大型輸出一致性：原生、WASM、TypeScript（單／多執行緒）的輸出 SHA-256 必須相同
node --no-warnings bench/verify-large.mjs tall-overlap wide-overlap
```

benchmark 的 case 定義在 `bench/cases.mjs`。`bench/run-one.mjs` 目前寫死載入 `darwin-arm64` 的原生模組，換平台時要改。

---

## 專案結構

```
src/
  lib.rs       napi 綁定：openMergeJob、MergeJob、型別定義
  job.rs       合併邏輯：第一遍索引、衝突計算、欄位配置、第二遍平行輸出
  scan.rs      CSV 掃描：record 切分（含引號處理）、欄位切分、主鍵 hash
ts/            TypeScript 版（對應 src/）
  index.ts          公開 API：openMergeJob、MergeJob
  job-worker.ts     一個 job 的完整邏輯（對應 job.rs）
  index-worker.ts   第一遍：單一檔案的索引
  render-worker.ts  第二遍：把一批輸出列組成 bytes
  csv.ts            CSV 掃描（對應 scan.rs）
  hash.ts           MurmurHash3 x86_128
  tables.ts / protocol.ts / types.ts  共用工具、worker 間的訊息格式、公開型別
test/
  reference.mjs     JS 參考實作（純記憶體、好讀），作為正確性比對的基準
  correctness.mjs   隨機案例比對
bench/
  cases.mjs         benchmark 情境定義
  gen.mjs           產生測資（多程序平行）
  gen-file.mjs      產生單一檔案
  bench.mjs         執行所有情境並輸出表格
  run-one.mjs       單次執行（在獨立程序裡）
  verify-large.mjs  大型輸出一致性檢查
  conflict-keys.mjs 列出衝突主鍵的成本
```

### 運作方式

**第一遍（`openMergeJob`）**：每個檔案一條執行緒

- 用 `memchr` 找出每筆 record 的邊界，正確處理引號內的逗號和換行
- 每列只解析前 `rowKeyCols` 欄並算 hash，記下 `(hash, byte offset)`；其餘欄位直接跳過
- 全部檔案掃完後，用一張只存 4 bytes 編號的 hash table 合併出全域列表，再轉成 CSR 結構（輸出列 → 來源列）
- 過程中順便統計檔案兩兩之間的列重疊數和欄重疊數

**衝突（`conflicts`）**：檔案對 (A, B) 的衝突格數 = 列重疊數 × 欄重疊數，直接相乘

**第二遍（`merge`）**

- 依策略決定輸出的欄位配置
- 把輸出列切成約 4MB 一批，多個 worker 各自 seek 回原始檔案、讀出需要的 record、組好輸出列
- writer 依批次順序寫出；用滑動視窗限制同時存在記憶體裡的批數，所以輸出再大，記憶體用量也不會增加
- cell 的原始文字（含引號）直接複製到輸出，不重新編碼
