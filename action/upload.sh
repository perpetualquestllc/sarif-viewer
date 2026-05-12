#!/usr/bin/env bash
# Upload one or more SARIF files to a sarif-viewer instance.
# Used by action.yml. Reads INPUT_* and GH_* env vars set by the composite action.
#
# Depends on: bash, curl, jq. All three are pre-installed on the standard
# GitHub-hosted runner images (ubuntu, macos, windows).
set -euo pipefail

: "${INPUT_VIEWER_URL:?viewer-url is required}"
: "${INPUT_TOKEN:?token is required}"

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is required but not found on PATH."
  exit 1
fi

VIEWER_URL="${INPUT_VIEWER_URL%/}"
TOKEN="$INPUT_TOKEN"
LABEL="${INPUT_LABEL:-}"
FAIL_ON="${INPUT_FAIL_ON:-}"
CONTINUE_ON_ERROR="${INPUT_CONTINUE_ON_ERROR:-false}"

declare -a files=()

# Build file list: prefer sarif-files (multi), fallback to sarif-file (single).
expand_pattern() {
  local pat="$1"
  # shellcheck disable=SC2206
  local hits=( $(compgen -G "$pat" 2>/dev/null || true) )
  if (( ${#hits[@]} == 0 )); then
    [[ -f "$pat" ]] && hits=("$pat")
  fi
  for h in "${hits[@]:-}"; do
    [[ -n "$h" && -f "$h" ]] && files+=("$h")
  done
}

if [[ -n "${INPUT_SARIF_FILES:-}" ]]; then
  while IFS= read -r entry; do
    entry="${entry%$'\r'}"
    [[ -z "$entry" ]] && continue
    expand_pattern "$entry"
  done < <(printf '%s\n' "${INPUT_SARIF_FILES//,/$'\n'}")
elif [[ -n "${INPUT_SARIF_FILE:-}" ]]; then
  expand_pattern "$INPUT_SARIF_FILE"
else
  echo "::error::Neither sarif-file nor sarif-files was provided."
  exit 1
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "::error::No SARIF files matched the provided pattern."
  exit 1
fi

# URL-encode using jq.
urlenc() {
  printf '%s' "$1" | jq -sRr '@uri'
}

# Build query string from GitHub context.
qs=""
append_qs() {
  local k="$1" v="${2:-}"
  [[ -z "$v" ]] && return 0
  qs+="${qs:+&}${k}=$(urlenc "$v")"
}
append_qs repo "${GH_REPOSITORY:-}"
append_qs commit "${GH_SHA:-}"
append_qs ref "${GH_REF:-}"
append_qs branch "${GH_REF_NAME:-}"
append_qs workflow "${GH_WORKFLOW:-}"
append_qs job "${GH_JOB:-}"
append_qs run_id "${GH_RUN_ID:-}"
if [[ -n "${GH_SERVER_URL:-}" && -n "${GH_REPOSITORY:-}" && -n "${GH_RUN_ID:-}" ]]; then
  append_qs run_url "${GH_SERVER_URL}/${GH_REPOSITORY}/actions/runs/${GH_RUN_ID}"
fi
append_qs actor "${GH_ACTOR:-}"
append_qs pr "${GH_PR_NUMBER:-}"
append_qs label "$LABEL"

ids=()
urls=()
worst_level=0

level_rank() {
  case "${1:-}" in
    error) echo 3 ;;
    warning) echo 2 ;;
    note) echo 1 ;;
    *) echo 0 ;;
  esac
}

for f in "${files[@]}"; do
  echo "::group::Uploading $f"
  http_out=$(mktemp)
  set +e
  status=$(curl --silent --show-error --output "$http_out" --write-out '%{http_code}' \
    --request POST \
    --header "Authorization: Bearer $TOKEN" \
    --header "Content-Type: application/json" \
    --data-binary "@$f" \
    "$VIEWER_URL/api/reports?$qs")
  rc=$?
  set -e
  body=$(cat "$http_out")
  rm -f "$http_out"

  if [[ $rc -ne 0 || "$status" != "201" ]]; then
    echo "::error::Upload failed (curl rc=$rc, http=$status): $body"
    if [[ "$CONTINUE_ON_ERROR" == "true" ]]; then
      echo "::endgroup::"
      continue
    fi
    exit 1
  fi

  id=$(jq -r '.id // empty' <<< "$body")
  errc=$(jq -r '.meta.summary.error // 0' <<< "$body")
  warnc=$(jq -r '.meta.summary.warning // 0' <<< "$body")
  notec=$(jq -r '.meta.summary.note // 0' <<< "$body")
  url="$VIEWER_URL/r/$id"
  ids+=("$id")
  urls+=("$url")

  echo "Uploaded $(basename "$f") → $url ($errc errors, $warnc warnings, $notec notes)"

  if (( errc > 0 )); then
    rank=$(level_rank error); (( rank > worst_level )) && worst_level=$rank
  elif (( warnc > 0 )); then
    rank=$(level_rank warning); (( rank > worst_level )) && worst_level=$rank
  elif (( notec > 0 )); then
    rank=$(level_rank note); (( rank > worst_level )) && worst_level=$rank
  fi

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### SARIF uploaded: \`$(basename "$f")\`"
      echo
      echo "- Report: [$url]($url)"
      echo "- Errors: $errc · Warnings: $warnc · Notes: $notec"
      echo
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  echo "::endgroup::"
done

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  IFS=, ; echo "report-ids=${ids[*]}" >> "$GITHUB_OUTPUT"
  IFS=, ; echo "report-urls=${urls[*]}" >> "$GITHUB_OUTPUT"
  unset IFS
fi

# Optional gating on severity.
if [[ -n "$FAIL_ON" ]]; then
  threshold=$(level_rank "$FAIL_ON")
  if (( worst_level >= threshold )); then
    echo "::error::Reports contained results at or above '$FAIL_ON'."
    exit 1
  fi
fi
