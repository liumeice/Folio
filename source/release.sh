#!/usr/bin/env bash
# 版本化打包：v<主.次.修复>.<编译次数>（例：v0.2.0.43）
#   基线（主.次.修复）= src-tauri/tauri.conf.json 的 version（手动维护；Tauri schema 只收三段 semver）
#   第四段发号：统一由 tauri build 的 beforeBuildCommand（scripts/bump-build.cjs）完成——
#     任何入口（本脚本 / 直接 npx tauri build / 其他 agent 实例）共用同一条号段（.build 游标 +
#     目录锁），单调递增、不撞号、不倒退。本脚本不再自行发号，只负责：失败回滚游标、
#     给安装包复制带第四段的副本、打印 PE 版本。
# 四段号的落点：① PE FileVersion/ProductVersion（src-tauri/build.rs 读 .build-version 原地改资源）
#   ② 应用内标题栏 chip（vite define 注入 src/lib/version.ts）③ 安装包文件名（成功后下方
#   就地改名为四位号；MSI 内部 ProductVersion 字段仍三段，属 Windows Installer 规范约束，文件名不受影响）
# 用法：./release.sh    [透传给 tauri build 的参数，如 --bundles nsis]
set -euo pipefail
cd "$(dirname "$0")"

PREV=$(cat .build 2>/dev/null || echo 0)
echo "== 发号交给 beforeBuildCommand（当前游标 ${PREV}），开始打包 =="
if ! npx tauri build "$@"; then
  # 失败退回本次号（仅当游标确实是本次推进的；被并行实例推进过就不动——号段只增不减）
  CUR=$(cat .build 2>/dev/null || echo -1)
  if [ "$CUR" = "$((PREV + 1))" ]; then
    echo "$PREV" > .build
    echo "!! 打包失败——已回收本次号（游标退回 ${PREV}）"
  else
    echo "!! 打包失败——游标已被其他实例推进（${CUR}），不回收"
  fi
  exit 1
fi
VER=$(cat .build-version)

# 需求方定夺（2026-11-16）：bundle 产物直接以四位版本号命名——把 tauri 规范名
# `Folio_0.2.0_x64-setup.exe` **就地改名**为 `Folio_<四位>_…`（不再留双份；
# 下次构建 tauri 仍按规范名产出，本步每次都会重放，幂等）。
# 需求方定夺（2026-11-19）：MSI 文件名后缀用 zh-CN（取代 en-US）；主程序以
# Folio-Portable.exe 为名交付（安装包内部仍是 folio-app.exe，不影响升级安装）。
# 改名前先清场（2026-11-19 事故修复）：上一轮遗留的 `Folio_<旧四位号>_zh-CN.msi` 同样匹配
# 改名 glob，会把本轮刚改好的新包覆盖回旧内容（98 的 MSI 就是这么被 97 冒充的）。
# 本轮唯一可信的产物是 tauri 规范名文件（由本轮版本号前两段推出），先把其余 Folio_* 全删
# ——只删四位号旧包，不碰规范名——再逐个改名，顺序无关、幂等。
BASE="${VER%.*}"
CANON_NSIS="Folio_${BASE}_x64-setup.exe"
CANON_MSI="Folio_${BASE}_x64_en-US.msi"
find target/release/bundle/nsis -type f -name 'Folio_*' ! -name "$CANON_NSIS" -delete 2>/dev/null || true
find target/release/bundle/msi  -type f -name 'Folio_*' ! -name "$CANON_MSI"  -delete 2>/dev/null || true
if [ -e "target/release/bundle/nsis/$CANON_NSIS" ]; then
  mv -f "target/release/bundle/nsis/$CANON_NSIS" "target/release/bundle/nsis/Folio_${VER}_x64-setup.exe"
fi
if [ -e "target/release/bundle/msi/$CANON_MSI" ]; then
  mv -f "target/release/bundle/msi/$CANON_MSI" "target/release/bundle/msi/Folio_${VER}_zh-CN.msi"
fi
if [ -e target/release/folio-app.exe ]; then
  mv -f target/release/folio-app.exe target/release/Folio-Portable.exe
fi

echo "== 完成：v${VER} =="
powershell -NoProfile -Command "(Get-Item 'target/release/Folio-Portable.exe').VersionInfo | Format-List FileVersion,FileVersionRaw" 2>/dev/null | grep -E "FileVersion" || true
ls -1 target/release/bundle/nsis/ target/release/bundle/msi/ 2>/dev/null || true
