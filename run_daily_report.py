"""
Called by GitHub Actions on a daily schedule.
Monitors GitHub stats + trends, generates a marketing report with content ideas,
and posts it to Discord.
"""
from marketing.github_monitor import get_full_stats
from marketing.trend_monitor import collect_all_trends
from marketing.content_generator import generate_daily_ideas
from marketing.reporter import build_report, save_report
from marketing.discord_poster import post_daily_report
from marketing.config import SKIFF

print("[Agent] Starting daily marketing report...")

# 1. Collect data
print("[Agent] Fetching GitHub stats...")
github_stats = get_full_stats(SKIFF["github_repo"])
print(f"[Agent] Stars: {github_stats.get('stars')} | Forks: {github_stats.get('forks')} | Issues: {github_stats.get('open_issues')}")

print("[Agent] Collecting trend data...")
trends = collect_all_trends()
print(f"[Agent] Found {len(trends.get('hackernews', []))} HN items, {len(trends.get('devto', []))} Dev.to items")

# 2. Generate AI ideas
print("[Agent] Generating content ideas with AI...")
ai_ideas = generate_daily_ideas(github_stats, trends)

# 3. Build full report
report = build_report(github_stats, trends, ai_ideas)
save_report(report, "marketing_report.md")

# 4. Send to Discord
print("[Agent] Sending report to Discord...")
post_daily_report(ai_ideas, github_stats)

print("[Agent] Daily report complete.")
