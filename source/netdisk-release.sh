#!/usr/bin/env bash
# 百度网盘推送（需求方规则 2026-11-19）：GitHub release 发布完成后，
# 把 v<四位号> 的五件套推到百度网盘 /Folio/<四位号>/，并建永久分享链接。
#   ①Folio-Portable.exe（本地构建产物，与 release 资产同源）
#   ②③GitHub release 的两个安装包（Folio_<四位号>_x64-setup.exe / _zh-CN.msi）
#   ④⑤GitHub tag 归档的两个源代码包（zip / tar.gz）
# 幂等：网盘已存在的同名同大小文件会跳过，可安全重跑。
# 用法：./netdisk-release.sh [版本号]   缺省读 .build-version
set -euo pipefail
cd "$(dirname "$0")"

VER="${1:-$(cat .build-version)}"
: "${BAIDU_NETDISK_ACCESS_TOKEN:*** BAIDU_NETDISK_ACCESS_TOKEN（百度网盘 OAuth token，约每月到期需重新授权）}"

REPO=liumeice/Folio
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
EXTRA=()   # 调试老版本时可用 NETDISK_NO_SHARE=1 只验证上传幂等、不新建分享
[ "${NETDISK_NO_SHARE:-0}" = "1" ] && EXTRA=(--no-share)

gh_get() {  # GitHub 直连失败时走 7078 代理回落（配方同推仓流程）
  local url="$1" out="$2" err
  err=$(mktemp)
  curl -fsSL --retry 2 --max-time 550 -o "$out" "$url" 2>"$err" \
    || curl -fsSL --retry 2 --max-time 550 -x http://127.0.0.1:7078 -o "$out" "$url" 2>>"$err" \
    || { echo "!! 下载失败: $url"; sed 's/^/   /' "$err"; rm -f "$err"; exit 1; }
  rm -f "$err"
  echo "  got $(basename "$out") ($(stat -c%s "$out") bytes)"
}

echo "== 从 GitHub v${VER} 拉四件套 =="
gh_get "https://github.com/${REPO}/releases/download/v${VER}/Folio_${VER}_x64-setup.exe" "$STAGE/Folio_${VER}_x64-setup.exe"
gh_get "https://github.com/${REPO}/releases/download/v${VER}/Folio_${VER}_zh-CN.msi" "$STAGE/Folio_${VER}_zh-CN.msi"
gh_get "https://github.com/${REPO}/archive/refs/tags/v${VER}.zip" "$STAGE/Folio_v${VER}_source.zip"
gh_get "https://github.com/${REPO}/archive/refs/tags/v${VER}.tar.gz" "$STAGE/Folio_v${VER}_source.tar.gz"
cp -f target/release/Folio-Portable.exe "$STAGE/"

# 原生 Windows python 认不了 msys 的 /tmp 路径，转成 Windows 形式传参
STAGE_WIN="$(cygpath -w "$STAGE")"
MCP_PY="${NETDISK_MCP_PY:-D:\\AIProject\\mcp-servers\\baidu-netdisk-mcp\\src\\baidu-netdisk\\.venv\\Scripts\\python.exe}"

echo "== 推送百度网盘 /Folio/${VER}/ =="
"$MCP_PY" -I scripts/netdisk_push.py "${EXTRA[@]}" "$VER" \
  "${STAGE_WIN}\\Folio-Portable.exe" \
  "${STAGE_WIN}\\Folio_${VER}_x64-setup.exe" \
  "${STAGE_WIN}\\Folio_${VER}_zh-CN.msi" \
  "${STAGE_WIN}\\Folio_v${VER}_source.zip" \
  "${STAGE_WIN}\\Folio_v${VER}_source.tar.gz"
