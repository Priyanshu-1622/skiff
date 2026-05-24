import requests
import time
from .config import SKIFF

HN_SEARCH = "https://hn.algolia.com/api/v1/search"
DEVTO_API = "https://dev.to/api/articles"


def get_hackernews_trends(keywords: list) -> list:
    results = []
    for kw in keywords[:3]:
        try:
            r = requests.get(
                HN_SEARCH,
                params={"query": kw, "tags": "story", "hitsPerPage": 3, "numericFilters": "points>10"},
                timeout=10,
            )
            if r.status_code == 200:
                for hit in r.json().get("hits", []):
                    title = hit.get("title", "")
                    points = hit.get("points", 0)
                    url = hit.get("url", "")
                    if title:
                        results.append({"title": title, "points": points, "url": url, "source": "HackerNews"})
            time.sleep(0.5)
        except Exception:
            pass
    results.sort(key=lambda x: x["points"], reverse=True)
    return results[:6]


def get_devto_trends(tags: list) -> list:
    results = []
    for tag in tags[:3]:
        try:
            r = requests.get(
                DEVTO_API,
                params={"tag": tag, "per_page": 3, "top": 7},
                timeout=10,
            )
            if r.status_code == 200:
                for article in r.json():
                    results.append({
                        "title": article.get("title", ""),
                        "reactions": article.get("positive_reactions_count", 0),
                        "url": article.get("url", ""),
                        "tag": tag,
                        "source": "Dev.to",
                    })
            time.sleep(0.3)
        except Exception:
            pass
    results.sort(key=lambda x: x["reactions"], reverse=True)
    return results[:6]


def get_google_trends(keywords: list) -> list:
    try:
        from pytrends.request import TrendReq
        pt = TrendReq(hl="en-US", tz=360, timeout=(10, 25))
        kw_batch = keywords[:5]
        pt.build_payload(kw_batch, timeframe="now 7-d")
        interest = pt.interest_over_time()
        if interest.empty:
            return []
        latest = interest.iloc[-1]
        ranked = sorted(
            [(kw, int(latest.get(kw, 0))) for kw in kw_batch if kw in latest],
            key=lambda x: x[1],
            reverse=True,
        )
        return [{"keyword": kw, "score": score} for kw, score in ranked if score > 0]
    except Exception:
        return []


def get_github_trending(language: str = "typescript") -> list:
    try:
        r = requests.get(
            "https://api.github.com/search/repositories",
            params={
                "q": f"language:{language} stars:>50 pushed:>2025-01-01",
                "sort": "stars",
                "order": "desc",
                "per_page": 5,
            },
            headers={"Accept": "application/vnd.github.v3+json"},
            timeout=10,
        )
        if r.status_code == 200:
            return [
                {
                    "name": repo["full_name"],
                    "description": repo.get("description", ""),
                    "stars": repo.get("stargazers_count", 0),
                    "url": repo["html_url"],
                }
                for repo in r.json().get("items", [])
            ]
    except Exception:
        pass
    return []


def collect_all_trends() -> dict:
    hn_tags = ["self-hosted", "SSH", "DevOps", "homelab", "open source"]
    devto_tags = ["selfhosted", "devops", "opensource", "sysadmin"]

    return {
        "hackernews": get_hackernews_trends(hn_tags),
        "devto": get_devto_trends(devto_tags),
        "google_trends": get_google_trends(SKIFF["trend_keywords"]),
        "github_trending": get_github_trending("typescript"),
    }
