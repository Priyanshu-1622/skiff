"""
Called by GitHub Actions on every push to main/master.
Env vars expected: COMMIT_MESSAGE, COMMIT_SHA, COMMIT_URL, CHANGED_FILES (comma-separated)
"""
import os
import sys

from marketing.content_generator import generate_push_post
from marketing.discord_poster import post_push_update
from marketing.reddit_poster import post_update as reddit_post
from marketing.twitter_poster import post_tweet
from marketing.config import SKIFF

COMMIT_MESSAGE = os.environ.get("COMMIT_MESSAGE", "General update")
COMMIT_SHA = os.environ.get("COMMIT_SHA", "unknown")[:7]
COMMIT_URL = os.environ.get("COMMIT_URL", SKIFF["github_url"])
CHANGED_FILES = [f.strip() for f in os.environ.get("CHANGED_FILES", "").split(",") if f.strip()]

# Skip bot / CI / merge commits
SKIP_KEYWORDS = ["[skip-marketing]", "merge pull request", "auto-", "bump version", "ci:"]
if any(kw.lower() in COMMIT_MESSAGE.lower() for kw in SKIP_KEYWORDS):
    print(f"[Agent] Skipping marketing post for: {COMMIT_MESSAGE}")
    sys.exit(0)

print(f"[Agent] Processing push: {COMMIT_MESSAGE} ({COMMIT_SHA})")

# Generate platform-specific posts
discord_post = generate_push_post(COMMIT_MESSAGE, CHANGED_FILES, "discord")
twitter_post = generate_push_post(COMMIT_MESSAGE, CHANGED_FILES, "twitter")
reddit_post_text = generate_push_post(COMMIT_MESSAGE, CHANGED_FILES, "reddit")

print("\n--- Discord ---")
print(discord_post)
print("\n--- Twitter ---")
print(twitter_post)
print("\n--- Reddit ---")
print(reddit_post_text)

# Post to platforms
results = {
    "discord": post_push_update(COMMIT_MESSAGE, COMMIT_SHA, COMMIT_URL, discord_post),
    "twitter": post_tweet(twitter_post),
    "reddit": reddit_post(reddit_post_text, subreddit_name="selfhosted"),
}

print(f"\n[Agent] Results: {results}")
failed = [p for p, ok in results.items() if not ok]
if failed:
    print(f"[Agent] Some platforms failed: {failed} (check credentials in GitHub Secrets)")
