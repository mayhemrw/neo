#!/usr/bin/env bash
# Posts Hugh's new NEO commits and releases to a Discord channel.
#
# Run by .github/workflows/watch-upstream.yml every few hours. Remembers the
# last commit and release it saw in $STATE_DIR (the workflow keeps that folder
# between runs with actions/cache), so each commit is posted once.
#
# Env:
#   DISCORD_WEBHOOK  Discord channel webhook URL. Empty = dry run: prints the
#                    message instead of posting it.
#   GITHUB_TOKEN     Optional; raises the GitHub API rate limit.
#   UPSTREAM         Repo to watch (default hughhowey/neo)
#   UPSTREAM_BRANCH  Branch to watch (default main)
#   FORK_REF         Your branch, as owner:branch, for the "also changed in
#                    Scribe" list (default mayhemrw:main)
#   STATE_DIR        Where the last-seen commit and release live

set -euo pipefail

UPSTREAM="${UPSTREAM:-hughhowey/neo}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
FORK_REF="${FORK_REF:-mayhemrw:main}"
STATE_DIR="${STATE_DIR:-.upstream-state}"
API="https://api.github.com"
MAX_COMMITS=15

api() {
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
    "$API/$1"
}

post() {
  if [ -z "${DISCORD_WEBHOOK:-}" ]; then
    echo "[dry run] would post:"
    echo "$1" | jq .
    return
  fi
  curl -fsS -H "Content-Type: application/json" -d "$1" "$DISCORD_WEBHOOK" > /dev/null
}

mkdir -p "$STATE_DIR"
last_sha=$(cat "$STATE_DIR/sha" 2> /dev/null || true)
last_release=$(cat "$STATE_DIR/release" 2> /dev/null || true)

head_sha=$(api "repos/$UPSTREAM/commits/$UPSTREAM_BRANCH" | jq -r .sha)
release_json=$(api "repos/$UPSTREAM/releases/latest" 2> /dev/null || echo '{}')
release=$(echo "$release_json" | jq -r '.tag_name // empty')

save_state() {
  echo "$head_sha" > "$STATE_DIR/sha"
  echo "$release" > "$STATE_DIR/release"
}

# First run: nothing to compare against yet. Say hello so you know the
# webhook works, and start watching from here.
if [ -z "$last_sha" ]; then
  payload=$(jq -n \
    --arg repo "$UPSTREAM" \
    --arg sha "${head_sha:0:7}" \
    --arg rel "${release:-none yet}" \
    '{embeds: [{
        title: ("Now watching " + $repo),
        url: ("https://github.com/" + $repo + "/commits"),
        description: ("Latest commit `" + $sha + "`, latest release **" + $rel + "**. New commits and releases will show up here."),
        color: 5793266
      }]}')
  post "$payload"
  save_state
  exit 0
fi

# --- New commits -----------------------------------------------------------
if [ "$head_sha" != "$last_sha" ]; then
  if compare=$(api "repos/$UPSTREAM/compare/$last_sha...$head_sha" 2> /dev/null); then
    # Files your fork has changed since it split from Hugh's. Anything Hugh
    # just touched that's also on this list is where a merge can get sticky.
    fork_files=$(api "repos/$UPSTREAM/compare/$UPSTREAM_BRANCH...$FORK_REF" 2> /dev/null \
      | jq '[.files[]?.filename]' || echo '[]')

    payload=$(echo "$compare" | jq \
      --argjson fork "$fork_files" \
      --argjson max "$MAX_COMMITS" \
      --arg repo "$UPSTREAM" '
      def trunc($n): if length > $n then .[0:$n - 1] + "…" else . end;
      (.commits | length) as $n
      | (.total_commits // $n) as $total
      | [.files[]?.filename] as $files
      | [$files[] | select(. as $f | $fork | index($f))] as $overlap
      | (.commits[-$max:] | map(
          "[`" + .sha[0:7] + "`](" + .html_url + ") "
          + (.commit.message | split("\n")[0] | trunc(90))
        )) as $lines
      | {embeds: [{
          title: ("Hugh pushed " + ($total | tostring) + " new commit" + (if $total == 1 then "" else "s" end) + " to NEO"),
          url: .html_url,
          description: (
            (if $total > ($lines | length)
              then "…and " + (($total - ($lines | length)) | tostring) + " earlier\n"
              else "" end)
            + ($lines | join("\n"))
          ) | trunc(4000),
          color: 15105570,
          fields: [
            {
              name: ("Files changed (" + ($files | length | tostring) + ")"),
              value: (if ($files | length) == 0 then "none"
                      else ($files[0:25] | join(", ")) + (if ($files | length) > 25 then ", …" else "" end)
                      end) | trunc(1000),
              inline: false
            },
            {
              name: "Also changed in Scribe (check these when you merge)",
              value: (if ($overlap | length) == 0
                      then "None. Should merge cleanly."
                      else ($overlap | map("`" + . + "`") | join(", ")) end) | trunc(1000),
              inline: false
            }
          ]
        }]}')
    post "$payload"
  else
    # The old commit is gone from Hugh's history (a force-push or rebase).
    payload=$(jq -n --arg repo "$UPSTREAM" --arg sha "${head_sha:0:7}" \
      '{embeds: [{
          title: "Hugh rewrote NEO history",
          url: ("https://github.com/" + $repo + "/commits"),
          description: ("The last commit I saw is gone from his branch. Latest is now `" + $sha + "`. Check his commits by hand this time."),
          color: 15548997
        }]}')
    post "$payload"
  fi
fi

# --- New release -----------------------------------------------------------
if [ -n "$release" ] && [ "$release" != "$last_release" ]; then
  payload=$(echo "$release_json" | jq '
    def trunc($n): if length > $n then .[0:$n - 1] + "…" else . end;
    {embeds: [{
      title: ("Hugh released NEO " + .tag_name),
      url: .html_url,
      description: ((.body // "No release notes.") | trunc(1500)),
      color: 5763719
    }]}')
  post "$payload"
fi

save_state
