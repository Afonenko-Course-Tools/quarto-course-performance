#!/usr/bin/env bash
# Проверка публичных переменных рецепта без сборки и установки пакета.
set -eu
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
(($# <= 1))
# shellcheck source=packaging/arch/PKGBUILD
source "${1:-packaging/arch/PKGBUILD}"
[[ $pkgname == quarto-course-perf && $pkgver =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ $pkgrel =~ ^[0-9]+$ && -n $pkgdesc && $url == https://* ]]
[[ ${#arch[@]} -gt 0 && ${#depends[@]} -gt 0 ]]
[[ ${#source[@]} -eq ${#sha256sums[@]} ]]
# Массивы license и optdepends являются внешним API makepkg и могут быть пустыми.
declare -p license optdepends >/dev/null
printf 'PASS: контракт рецепта %s %s-%s\n' "$pkgname" "$pkgver" "$pkgrel"
