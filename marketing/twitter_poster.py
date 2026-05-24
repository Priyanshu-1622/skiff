import os


def _get_client():
    try:
        import tweepy
    except ImportError:
        print("[Twitter] tweepy not installed.")
        return None

    keys = {
        "consumer_key": os.environ.get("TWITTER_API_KEY"),
        "consumer_secret": os.environ.get("TWITTER_API_SECRET"),
        "access_token": os.environ.get("TWITTER_ACCESS_TOKEN"),
        "access_token_secret": os.environ.get("TWITTER_ACCESS_SECRET"),
    }
    if not all(keys.values()):
        print("[Twitter] Missing credentials — skipping.")
        return None

    try:
        client = tweepy.Client(**keys, wait_on_rate_limit=True)
        return client
    except Exception as e:
        print(f"[Twitter] Auth failed: {e}")
        return None


def post_tweet(text: str) -> bool:
    client = _get_client()
    if not client:
        return False

    # Twitter API v2 free tier: 1,500 tweets/month
    tweet_text = text[:280]
    try:
        resp = client.create_tweet(text=tweet_text)
        tweet_id = resp.data["id"]
        print(f"[Twitter] Tweeted: https://twitter.com/i/web/status/{tweet_id}")
        return True
    except Exception as e:
        print(f"[Twitter] Failed to tweet: {e}")
        return False
