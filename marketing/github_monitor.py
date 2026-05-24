import os
import requests
from datetime import datetime, timezone

GITHUB_API = "https://api.github.com"


def _headers():
    token = os.environ.get("GITHUB_TOKEN", "")
    return {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"} if token else {}


def get_repo_stats(repo: str) -> dict:
    r = requests.get(f"{GITHUB_API}/repos/{repo}", headers=_headers(), timeout=10)
    if r.status_code != 200:
        return {}
    data = r.json()
    return {
        "stars": data.get("stargazers_count", 0),
        "forks": data.get("forks_count", 0),
        "watchers": data.get("subscribers_count", 0),
        "open_issues": data.get("open_issues_count", 0),
        "description": data.get("description", ""),
        "topics": data.get("topics", []),
        "created_at": data.get("created_at", ""),
        "pushed_at": data.get("pushed_at", ""),
    }


def get_recent_commits(repo: str, count: int = 5) -> list:
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/commits",
        headers=_headers(),
        params={"per_page": count},
        timeout=10,
    )
    if r.status_code != 200:
        return []
    return [
        {
            "message": c["commit"]["message"].split("\n")[0],
            "author": c["commit"]["author"]["name"],
            "date": c["commit"]["author"]["date"],
            "sha": c["sha"][:7],
            "url": c["html_url"],
        }
        for c in r.json()
    ]


def get_open_issues(repo: str, count: int = 5) -> list:
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/issues",
        headers=_headers(),
        params={"state": "open", "per_page": count},
        timeout=10,
    )
    if r.status_code != 200:
        return []
    return [
        {
            "title": i["title"],
            "number": i["number"],
            "labels": [l["name"] for l in i.get("labels", [])],
            "url": i["html_url"],
            "created_at": i["created_at"],
        }
        for i in r.json()
        if "pull_request" not in i
    ]


def get_recent_releases(repo: str, count: int = 3) -> list:
    r = requests.get(
        f"{GITHUB_API}/repos/{repo}/releases",
        headers=_headers(),
        params={"per_page": count},
        timeout=10,
    )
    if r.status_code != 200:
        return []
    return [
        {
            "name": rel.get("name") or rel.get("tag_name", ""),
            "tag": rel.get("tag_name", ""),
            "body": (rel.get("body") or "")[:300],
            "published_at": rel.get("published_at", ""),
            "url": rel.get("html_url", ""),
        }
        for rel in r.json()
    ]


def get_full_stats(repo: str) -> dict:
    stats = get_repo_stats(repo)
    stats["recent_commits"] = get_recent_commits(repo)
    stats["open_issues_list"] = get_open_issues(repo)
    stats["recent_releases"] = get_recent_releases(repo)
    return stats
