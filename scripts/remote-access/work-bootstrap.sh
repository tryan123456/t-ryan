#!/usr/bin/env bash
#
# 公司 sandbox 每次重建後跑這一次，約 30 秒。不需要 sudo、不需要設定檔、
# 不需要註冊任何金鑰 —— 登入用的是 Cloudflare 當場簽發的短期憑證。
#
# 用法：
#   curl -fsSL <這支腳本的 raw 網址> | bash -s -- ssh.example.com myuser [alias]
#   或   ./work-bootstrap.sh ssh.example.com myuser [alias]
#
# 跑完就可以：ssh home

set -euo pipefail

SSH_HOSTNAME="${1:-${RA_SSH_HOSTNAME:-}}"
SSH_USER="${2:-${RA_SSH_USER:-}}"
SSH_ALIAS="${3:-home}"
DEV_PORT="${DEV_PORT:-5173}"
WEB_HOSTNAME="${WEB_HOSTNAME:-${SSH_HOSTNAME/#ssh./home-dev.}}"

if [[ -z "$SSH_HOSTNAME" || -z "$SSH_USER" ]]; then
  echo "用法：$0 <ssh 主機名稱> <家裡的使用者名稱> [別名]" >&2
  exit 1
fi

say() { printf '\033[34m==>\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m  ✓\033[0m %s\n' "$*"; }

# 參數打錯（尤其是使用者名稱）會一路走到最後才以 Permission denied 收場，
# 所以先把要用的值攤開來給人看。
say "設定"
echo "  主機   : $SSH_HOSTNAME"
echo "  使用者 : $SSH_USER      ← 這是家裡那台的帳號，打錯就登不進去"
echo "  別名   : ssh $SSH_ALIAS"

# ---- 1. cloudflared（放在 ~/.local/bin，不用 sudo）----

BIN="$HOME/.local/bin/cloudflared"
if command -v cloudflared >/dev/null 2>&1; then
  BIN="$(command -v cloudflared)"
  ok "cloudflared 已存在"
else
  say "下載 cloudflared"
  os="$(uname -s)"; arch="$(uname -m)"
  case "$arch" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "不支援的架構 $arch" >&2; exit 1 ;; esac
  base="https://github.com/cloudflare/cloudflared/releases/latest/download"
  mkdir -p "$HOME/.local/bin"
  tmp="$(mktemp -d)"
  if [[ "$os" == "Darwin" ]]; then
    curl -fsSL --retry 3 -o "$tmp/c.tgz" "$base/cloudflared-darwin-$arch.tgz"
    tar -xzf "$tmp/c.tgz" -C "$tmp"
    install -m 0755 "$tmp/cloudflared" "$BIN"
  else
    curl -fsSL --retry 3 -o "$tmp/cloudflared" "$base/cloudflared-linux-$arch"
    install -m 0755 "$tmp/cloudflared" "$BIN"
  fi
  rm -rf "$tmp"
  ok "已安裝到 $BIN"
fi

# ---- 2. ssh config ----

say "寫入 ~/.ssh/config"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
CFG="$HOME/.ssh/config"; touch "$CFG"; chmod 600 "$CFG"

BEGIN="# >>> remote-access ($SSH_ALIAS) >>>"
END="# <<< remote-access ($SSH_ALIAS) <<<"
if grep -qF "$BEGIN" "$CFG"; then
  awk -v b="$BEGIN" -v e="$END" '$0 == b {s=1} !s {print} $0 == e {s=0}' "$CFG" > "$CFG.tmp"
  mv "$CFG.tmp" "$CFG"; chmod 600 "$CFG"
fi

# Match host ... exec 會在每次連線前重新簽一張憑證（過期了才會真的重簽），
# 必須放在 Host 區塊之後，%h 才會是替換後的真實主機名稱。
cat >> "$CFG" <<EOF

$BEGIN
Host $SSH_ALIAS
  HostName $SSH_HOSTNAME
  User $SSH_USER
  ProxyCommand $BIN access ssh --hostname %h
  IdentityFile ~/.cloudflared/$SSH_HOSTNAME-cf_key
  CertificateFile ~/.cloudflared/$SSH_HOSTNAME-cf_key-cert.pub
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 4
  LocalForward $DEV_PORT 127.0.0.1:$DEV_PORT
Match host $SSH_HOSTNAME exec "$BIN access ssh-gen --hostname %h"
$END
EOF
ok "Host $SSH_ALIAS 已設定"

# ---- 3. Access 登入 + 簽憑證 ----

say "Cloudflare Access 登入（瀏覽器會開一個驗證頁）"
echo "  開不了瀏覽器的話，把下面印出來的網址複製到瀏覽器貼上即可。"
"$BIN" access login "https://$SSH_HOSTNAME"
"$BIN" access ssh-gen --hostname "$SSH_HOSTNAME"
ok "短期憑證已簽發：~/.cloudflared/$SSH_HOSTNAME-cf_key-cert.pub"

# ---- 4. 測試 ----

say "測試連線"
if ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new "$SSH_ALIAS" true 2>/dev/null; then
  ok "連上了"
else
  echo "  連不上。家裡那台可能睡著了，或短期憑證還沒設好。除錯：ssh -v $SSH_ALIAS" >&2
fi

cat <<EOF

  ssh $SSH_ALIAS                      # 進家裡的機器
  https://$WEB_HOSTNAME               # 家裡的 dev server（也可用 http://127.0.0.1:${DEV_PORT}）

  這台機器上沒有任何長期金鑰，時間到憑證自己失效，sandbox 被回收也不用善後。
EOF
