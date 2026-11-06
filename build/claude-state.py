import json
p = "/root/.claude.json"
try:
    d = json.load(open(p))
    print("keys:", sorted(d.keys())[:30])
    for k in ["oauthAccount", "account", "userID", "hasCompletedOnboarding"]:
        if k in d:
            print(k, "=", str(d[k])[:200])
except Exception as e:
    print("read err:", e)
