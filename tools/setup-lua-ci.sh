#!/usr/bin/env bash
# Закреплённый LuaLS устанавливается только в новый явный каталог CI.
set -euo pipefail
if [[ $# != 1 || $1 != /* || -e $1 || -L $1 ]]; then
  printf 'Требуется новый абсолютный каталог назначения\n' >&2
  exit 2
fi
target=$1
parent=$(dirname -- "$target")
[[ -d $parent ]] || { printf 'Родитель назначения должен существовать\n' >&2; exit 2; }
staging=$(mktemp -d -- "$parent/.luals-stage.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
url=https://github.com/LuaLS/lua-language-server/releases/download/3.19.2/lua-language-server-3.19.2-linux-x64.tar.gz
checksum=93ad326b10f6c00911dd8c450fa098332dbd8f9f45d1052f5636a2d54479b947
curl --fail --location --silent --show-error "$url" --output "$staging/archive.tar.gz"
printf '%s  %s\n' "$checksum" "$staging/archive.tar.gz" | sha256sum --check --status
mkdir -- "$staging/install"
tar -xzf "$staging/archive.tar.gz" -C "$staging/install"
[[ $("$staging/install/bin/lua-language-server" --version) == 3.19.2 ]] || { printf 'Неверная версия LuaLS\n' >&2; exit 1; }
# -n сохраняет появившееся чужое назначение, -T запрещает вложение в каталог.
mv -T -n -- "$staging/install" "$target"
[[ ! -e $staging/install ]] || { printf 'Назначение появилось во время подготовки; сохранено без изменений\n' >&2; exit 1; }
printf 'LuaLS 3.19.2: %s/bin/lua-language-server\n' "$target"
