#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
gh_bin="${GH_BIN:-gh}"
repo='yfdskr/codex-provider-session-guide'
tag='v0.6.0'
release_dir="$project_root/artifacts/publication-20261029/release"

command -v "$gh_bin" >/dev/null || { echo '需要 GitHub CLI：先安装 gh，再登录 yfdskr。' >&2; exit 1; }
if ! "$gh_bin" auth status >/dev/null 2>&1; then
  echo '尚未登录 GitHub。请先运行 gh auth login --hostname github.com --web --git-protocol https --scopes workflow，并选择 yfdskr。' >&2
  exit 1
fi
login="$("$gh_bin" api user --jq .login)"
[ "$login" = 'yfdskr' ] || { echo '当前 GitHub 用户不是 yfdskr，已停止。' >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo '请在已核对的 main 分支发布。' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo '工作区还有未提交修改，请先核对并提交。' >&2; exit 1; }
for file in codex-provider-manager-0.6.0.vsix verification-0.6.0.json RELEASE_NOTES.md SHA256SUMS; do
  [ -f "$release_dir/$file" ] || { echo "缺少交付文件：$file" >&2; exit 1; }
done
(cd "$release_dir" && sha256sum -c SHA256SUMS)
python3 - "$project_root" "$release_dir" <<'PY'
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]);release=Path(sys.argv[2])
pkg=json.loads((root/'extension/package.json').read_text())
report=json.loads((root/'docs/releases/v0.6.0.json').read_text())
asset=json.loads((release/'verification-0.6.0.json').read_text())
assert pkg['version']==report['version']==asset['version']=='0.6.0', '版本不一致'
assert report==asset, '附件报告不是已提交的报告'
assert report['package']['sha256']==hashlib.sha256((release/report['package']['file']).read_bytes()).hexdigest(), '安装包与报告不一致'
PY

if "$gh_bin" repo view "$repo" --json nameWithOwner >/dev/null 2>&1; then
  visibility="$("$gh_bin" api "repos/$repo" --jq .visibility)"
  [ "$visibility" = public ] || { echo '同名仓库不是公开仓库；不自动改变已有仓库的可见性。' >&2; exit 1; }
else
  "$gh_bin" repo create "$repo" --public --description 'VS Code Codex 账号与 API 管理、平滑切换、对话目录、监控和备份；包含通用操作指南。'
fi
if git remote get-url origin >/dev/null 2>&1; then
  remote="$(git remote get-url origin)"
  case "$remote" in
    "https://github.com/$repo"|"https://github.com/$repo.git"|"git@github.com:$repo.git") ;;
    *) echo 'origin 指向其他仓库，已停止；不自动改写。' >&2; exit 1 ;;
  esac
else
  git remote add origin "https://github.com/$repo.git"
fi

# Authenticate this push through gh without changing global Git credentials.
# The helper command itself contains no token and nothing sensitive is logged.
git -c credential.helper= -c "credential.helper=!\"$gh_bin\" auth git-credential" push -u origin main
if git show-ref --verify --quiet "refs/tags/$tag"; then
  [ "$(git rev-parse "$tag^{commit}")" = "$(git rev-parse HEAD)" ] || { echo '已有本地标签指向其他提交，不覆盖。' >&2; exit 1; }
else
  git -c user.name=yfdskr -c user.email=yfdskr@users.noreply.github.com tag -a "$tag" -m 'Codex Provider Manager 0.6.0 prerelease'
fi
git -c credential.helper= -c "credential.helper=!\"$gh_bin\" auth git-credential" push origin "$tag"
if "$gh_bin" release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  echo '该 Release 已存在，保留附件不覆盖；请核对其提交和文件。' >&2
  exit 1
fi
"$gh_bin" release create "$tag" --repo "$repo" --verify-tag --prerelease --latest=false \
  --title 'Codex Provider Manager 0.6.0（预发布）' \
  --notes-file "$release_dir/RELEASE_NOTES.md" \
  "$release_dir/codex-provider-manager-0.6.0.vsix" \
  "$release_dir/SHA256SUMS" \
  "$release_dir/verification-0.6.0.json" \
  "$release_dir/RELEASE_NOTES.md"
"$gh_bin" repo view "$repo" --json url --jq .url
"$gh_bin" release view "$tag" --repo "$repo" --json url,isPrerelease,assets
