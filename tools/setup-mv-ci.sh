#!/usr/bin/env bash
# Ubuntu 24.04 GNU mv 9.4 не поддерживает update=none-fail.
# Локальный/Arch PATH принимается по capability; системный пакет не заменяется.
set -euo pipefail
target=${1:?Укажите отдельный каталог для CI mv}
script_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if bash "$script_root/check-mv-capability.sh" mv >&2; then
  exit 0
fi
if test -e "$target"; then
  bash "$script_root/check-mv-capability.sh" "$target/bin/mv" >&2
else
  build_root=$(mktemp -d "${TMPDIR:-/tmp}/course-coreutils.XXXXXXXX")
  trap 'rm -rf -- "$build_root"' EXIT
  curl --fail --location --silent --show-error \
    https://ftp.gnu.org/gnu/coreutils/coreutils-9.7.tar.xz \
    --output "$build_root/source.tar.xz"
  printf '%s  %s\n' e8bb26ad0293f9b5a1fc43fb42ba970e312c66ce92c1b0b16713d7500db251bf "$build_root/source.tar.xz" | sha256sum --check --status
  tar -xJf "$build_root/source.tar.xz" --directory "$build_root"
  (
    cd "$build_root/coreutils-9.7"
    ./configure --disable-nls --without-selinux --without-libsmack >&2
    make -j2 >&2
  )
  mkdir -p -- "$target/bin"
  install -m755 -- "$build_root/coreutils-9.7/src/mv" "$target/bin/mv"
  bash "$script_root/check-mv-capability.sh" "$target/bin/mv" >&2
fi
printf '%s\n' "$target/bin"
