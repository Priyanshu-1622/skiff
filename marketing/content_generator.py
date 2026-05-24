import os
from .config import SKIFF

SYSTEM_PROMPT = f"""You are a marketing expert for {SKIFF['name']}, an open-source self-hosted SSH connection manager.

About the project:
- Description: {SKIFF['description']}
- Website: {SKIFF['website']}
- GitHub: {SKIFF['github_url']}
- Stack: {', '.join(SKIFF['stack'])}
- Target audience: {SKIFF['target_audience']}
- Key selling point: {SKIFF['usp']}

Style guidelines:
- Write like a developer, not a marketer. Be genuine and technical when needed.
- Avoid buzzwords and corporate speak.
- The community values open source, privacy, and self-hosting.
- Always include the GitHub link or website URL.
- Be excited but not spammy."""


def _gemini_model():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        return genai.GenerativeModel(
            model_name="gemini-2.5-flash",
            system_instruction=SYSTEM_PROMPT,
        )
    except ImportError:
        return None


def _chat(prompt: str, max_tokens: int = 600, temperature: float = 0.75) -> str:
    model = _gemini_model()
    if not model:
        return None
    try:
        import google.generativeai as genai
        resp = model.generate_content(
            prompt,
            generation_config=genai.GenerationConfig(
                max_output_tokens=max_tokens,
                temperature=temperature,
            ),
        )
        return resp.text.strip()
    except Exception as e:
        print(f"[Gemini error] {e}")
        return None


# --- Push update posts ---

def generate_push_post(commit_message: str, changed_files: list, platform: str) -> str:
    rules = {
        "twitter": (
            "Write exactly ONE tweet. Max 240 chars. 2-3 hashtags from: #selfhosted #DevOps #SSH #homelab #opensource. "
            "Include the GitHub URL. Punchy and genuine."
        ),
        "reddit": (
            "Write a Reddit post with two parts separated by '---':\n"
            "TITLE: (max 200 chars, no clickbait)\n---\nBODY: (2-4 sentences, what changed and why it matters. "
            "Include GitHub link at the end.)"
        ),
        "discord": (
            "Write 1-2 sentences for a Discord announcement channel. "
            "Can use **bold** and emojis sparingly. Include GitHub link."
        ),
    }

    prompt = (
        f"A new commit was just pushed to Skiff.\n\n"
        f"Commit message: {commit_message}\n"
        f"Files changed: {', '.join(changed_files[:8]) if changed_files else 'various files'}\n\n"
        f"Generate a {platform} post announcing this update.\n"
        f"Rules: {rules.get(platform, 'Keep it short and informative.')}"
    )

    result = _chat(prompt, max_tokens=400)
    return result if result else _fallback_push_post(commit_message, platform)


def _fallback_push_post(commit_message: str, platform: str) -> str:
    short_msg = commit_message[:120]
    templates = {
        "twitter": (
            f"🔧 Skiff update: {short_msg}\n\n"
            f"Self-hosted SSH manager — own your credentials, no cloud required.\n"
            f"{SKIFF['github_url']}\n\n#selfhosted #SSH #opensource"
        ),
        "reddit": (
            f"TITLE: Skiff update — {short_msg}\n---\n"
            f"Just pushed an update to Skiff, my open-source self-hosted SSH connection manager.\n\n"
            f"**What changed:** {commit_message}\n\n"
            f"Feedback welcome! {SKIFF['github_url']}"
        ),
        "discord": (
            f"**Skiff update pushed!** 🚀\n"
            f"{commit_message}\n"
            f"{SKIFF['github_url']}"
        ),
    }
    return templates.get(platform, f"New Skiff update: {commit_message}")


# --- Daily ideas report ---

def generate_daily_ideas(github_stats: dict, trends: dict) -> str:
    trend_summary = _format_trends(trends)
    recent_commits = ", ".join(
        c["message"][:60] for c in github_stats.get("recent_commits", [])[:3]
    ) or "No recent commits"

    prompt = f"""Generate a daily marketing action report for Skiff based on this data:

GitHub Stats:
- ⭐ Stars: {github_stats.get('stars', 0)}
- 🍴 Forks: {github_stats.get('forks', 0)}
- 🐛 Open Issues: {github_stats.get('open_issues', 0)}
- Recent commits: {recent_commits}

What's trending in the self-hosted/DevOps space today:
{trend_summary}

Please provide the following in your report:
1. **3 Content Ideas** — specify format (reel, YouTube Short, tweet thread, blog post, Reddit post) and a clear angle/hook. Make each idea specific to Skiff's features.
2. **Best Subreddit to Post In Today** — based on trends, which subreddit and what angle?
3. **1 Twitter Thread Outline** — 5-tweet structure with the first tweet written out fully.
4. **Reel/Short Video Idea** — title, 30-second script outline, and why it would perform well now.
5. **One Growth Tip** — actionable, based on what's trending.

Be specific. Reference Skiff's actual features (encrypted vault, xterm.js terminal, Docker deploy, SSH import)."""

    result = _chat(prompt, max_tokens=1400, temperature=0.82)
    return result if result else _fallback_daily_ideas(github_stats)


def _format_trends(trends: dict) -> str:
    lines = []
    hn = trends.get("hackernews", [])
    if hn:
        top = hn[:3]
        lines.append("HackerNews: " + " | ".join(f'"{h["title"]}" ({h["points"]} pts)' for h in top))
    devto = trends.get("devto", [])
    if devto:
        top = devto[:3]
        lines.append("Dev.to: " + " | ".join(f'"{a["title"]}"' for a in top))
    gt = trends.get("google_trends", [])
    if gt:
        lines.append("Google Trends: " + ", ".join(f'{g["keyword"]} ({g["score"]})' for g in gt[:5]))
    return "\n".join(lines) if lines else "Trend data unavailable — use general DevOps/self-hosting themes."


def _fallback_daily_ideas(github_stats: dict) -> str:
    return f"""📊 Daily Skiff Marketing Ideas

**Content Ideas:**
1. 🎬 **Reel**: "SSH manager in 60 seconds" — screen-record the Docker install, first login, and adding a server. Works as YouTube Short or Instagram Reel.
2. 🐦 **Tweet Thread**: "I built a self-hosted SSH manager because I was tired of paying for tools that store my credentials in the cloud" — personal story, 5 tweets.
3. 📝 **Reddit Post** in r/selfhosted: "Show HN: Skiff — open-source SSH manager, single binary, AES-256 vault" with a live demo GIF.

**Best Subreddit Today:** r/selfhosted — post a demo GIF showing the xterm.js in-browser terminal.

**Twitter Thread Outline:**
Tweet 1: "I was paying $X/month for an SSH manager that stored my credentials in someone else's cloud. So I built Skiff — open source, self-hosted, one Docker command."
Tweet 2-5: Cover the features, security model, and how to get started.

**Reel Idea:** "Setting up a self-hosted SSH manager in under 2 minutes" — show the Docker run command, browser login, and connecting to a remote server live.

**Growth Tip:** Create a simple comparison table (Skiff vs paid alternatives) and share it in r/devops and r/sysadmin.

Stars: ⭐ {github_stats.get('stars', 0)} | Forks: 🍴 {github_stats.get('forks', 0)}"""
