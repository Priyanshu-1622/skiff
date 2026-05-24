import os
import re


def _get_reddit():
    try:
        import praw
    except ImportError:
        print("[Reddit] praw not installed.")
        return None

    creds = {
        "client_id": os.environ.get("REDDIT_CLIENT_ID"),
        "client_secret": os.environ.get("REDDIT_CLIENT_SECRET"),
        "username": os.environ.get("REDDIT_USERNAME"),
        "password": os.environ.get("REDDIT_PASSWORD"),
        "user_agent": "SkiffMarketingAgent/1.0 (by u/" + (os.environ.get("REDDIT_USERNAME") or "unknown") + ")",
    }
    if not all(creds.values()):
        print("[Reddit] Missing credentials — skipping.")
        return None

    return praw.Reddit(**creds)


def post_update(generated_post: str, subreddit_name: str = "selfhosted") -> bool:
    reddit = _get_reddit()
    if not reddit:
        return False

    # generated_post from content_generator uses TITLE:...\n---\nBODY: format
    title, body = _parse_reddit_post(generated_post)

    try:
        sub = reddit.subreddit(subreddit_name)
        sub.submit(title=title, selftext=body)
        print(f"[Reddit] Posted to r/{subreddit_name}: {title}")
        return True
    except Exception as e:
        print(f"[Reddit] Failed to post: {e}")
        return False


def _parse_reddit_post(text: str) -> tuple:
    if "---" in text:
        parts = text.split("---", 1)
        title_part = parts[0].strip()
        body_part = parts[1].strip() if len(parts) > 1 else ""
        # Remove "TITLE:" prefix if present
        title = re.sub(r"^TITLE:\s*", "", title_part, flags=re.IGNORECASE).strip()
        body = re.sub(r"^BODY:\s*", "", body_part, flags=re.IGNORECASE).strip()
        return title, body
    # Fallback: first line is title, rest is body
    lines = text.strip().split("\n", 1)
    return lines[0].strip(), lines[1].strip() if len(lines) > 1 else ""
