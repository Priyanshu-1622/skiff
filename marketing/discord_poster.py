import os
import requests
from datetime import datetime, timezone


def _webhook_url() -> str:
    return os.environ.get("DISCORD_WEBHOOK_URL", "")


def post_update(content: str, title: str = None, color: int = 0x5865F2) -> bool:
    url = _webhook_url()
    if not url:
        print("[Discord] DISCORD_WEBHOOK_URL not set — skipping.")
        return False

    payload = {"embeds": [{"description": content, "color": color}]}
    if title:
        payload["embeds"][0]["title"] = title

    r = requests.post(url, json=payload, timeout=10)
    if r.status_code in (200, 204):
        print("[Discord] Posted successfully.")
        return True
    else:
        print(f"[Discord] Failed: {r.status_code} {r.text}")
        return False


def post_push_update(commit_message: str, commit_sha: str, commit_url: str, generated_post: str) -> bool:
    content = (
        f"{generated_post}\n\n"
        f"[`{commit_sha}`]({commit_url})"
    )
    return post_update(content, title="🚀 Skiff — New Commit", color=0x57F287)


def post_daily_report(report: str, stats: dict) -> bool:
    stars = stats.get("stars", 0)
    forks = stats.get("forks", 0)
    issues = stats.get("open_issues", 0)
    today = datetime.now(timezone.utc).strftime("%b %d, %Y")

    header = f"**📊 Skiff Marketing Report — {today}**\n⭐ {stars} stars · 🍴 {forks} forks · 🐛 {issues} issues\n\n"

    # Discord has a 4096-char embed limit
    body = report[:3800]
    return post_update(header + body, color=0xFEE75C)
