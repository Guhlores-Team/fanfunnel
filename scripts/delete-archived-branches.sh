#!/usr/bin/env bash
# Delete the branches retired in the 2026-10 cleanup, but only ones whose
# current tip is preserved in the archive branch (archive/branches-2026-10).
# Dry run unless --apply is passed. Run from a machine with push rights.
#
#   scripts/delete-archived-branches.sh            # show what would happen
#   scripts/delete-archived-branches.sh --apply    # delete them
#
# Restore any branch later (commit hashes are listed in ARCHIVE.md on the archive branch):
#   git push origin <commit>:refs/heads/<branch>
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
REMOTE=origin
ARCHIVE=archive/branches-2026-10
KEEP="main dashboard-redesign $ARCHIVE"

git fetch --quiet "$REMOTE" "+refs/heads/$ARCHIVE:refs/remotes/$REMOTE/$ARCHIVE"
archive_parents=$(git rev-list --parents -n 1 "refs/remotes/$REMOTE/$ARCHIVE" | cut -d' ' -f2-)

to_delete=()
while read -r sha ref; do
  branch=${ref#refs/heads/}
  case " $KEEP " in *" $branch "*) continue ;; esac
  if [[ " $archive_parents " == *" $sha "* ]]; then
    to_delete+=("$branch")
    echo "archived   $branch (${sha:0:7})"
  else
    echo "KEEP       $branch (${sha:0:7}) is not in $ARCHIVE; leaving it alone"
  fi
done < <(git ls-remote --heads "$REMOTE")

if [ "${#to_delete[@]}" -eq 0 ]; then
  echo "Nothing to delete."; exit 0
fi
if [ "$APPLY" -eq 0 ]; then
  echo "(dry run: ${#to_delete[@]} branches would be deleted; re-run with --apply)"; exit 0
fi
git push "$REMOTE" --delete "${to_delete[@]}"
echo "Deleted ${#to_delete[@]} branches."
