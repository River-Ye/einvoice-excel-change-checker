#!/usr/bin/env bash

set -euo pipefail
shopt -s nocasematch

blocked=0
guard_tmp="$(mktemp -d "${TMPDIR:-/tmp}/einvoice-data-guard.XXXXXX")"
trap 'rm -rf -- "$guard_tmp"' EXIT

check_name() {
  case "$1" in
    *.xls|*.xlsx|*.xlsm|*.xlsb|*.ods|*.numbers|*.doc|*.docx|*.docm|*.pages|*.ppt|*.pptx|*.pptm|*.key|*.rtf|*.pdf|*.csv|*.tsv|*.zip|*.7z|*.rar|*.tar|*.tgz|*.gz|*.bz2|*.xz|*.zst)
      blocked=1
      ;;
  esac
}

check_file_signature() {
  [[ -f "$1" ]] || return
  local signature
  signature="$(od -An -tx1 -N8 "$1" | tr -d '[:space:]')"
  case "$signature" in
    504b0304*|504b0506*|504b0708*|d0cf11e0a1b11ae1*|25504446*|377abcaf271c*|526172211a07*|1f8b08*|425a68*|fd377a585a00*|28b52ffd*)
      blocked=1
      ;;
  esac
}

check_blob_signature() {
  git cat-file blob "$1" > "$guard_tmp/blob"
  check_file_signature "$guard_tmp/blob"
}

while IFS= read -r -d '' file; do
  check_name "$file"
  check_file_signature "./$file"
done < <(git ls-files -z)

while IFS= read -r -d '' file; do
  [[ -n "$file" ]] && check_name "$file"
done < <(git log --all --format= --name-only -z)

while IFS= read -r -d '' entry; do
  metadata="${entry%%$'\t'*}"
  read -r _ object_id _ <<< "$metadata"
  check_blob_signature "$object_id"
done < <(git ls-files -s -z)

while read -r object_id _; do
  [[ "$(git cat-file -t "$object_id")" == blob ]] && check_blob_signature "$object_id"
done < <(git rev-list --objects --all)

if [[ -d dist ]]; then
  while IFS= read -r -d '' file; do
    check_name "$file"
    check_file_signature "$file"
  done < <(find dist -type f -print0)
fi

if ((blocked)); then
  echo 'Sensitive or customer-data-like file detected; refusing to continue.' >&2
  exit 1
fi

echo 'Sensitive data guard passed.'
