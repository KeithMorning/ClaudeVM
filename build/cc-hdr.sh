UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
P=http://192.168.240.1:7897
curl -s --compressed --max-time 20 -x "$P" \
  -H "User-Agent: $UA" \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8' \
  -H 'Accept-Language: en-US,en;q=0.9' \
  -H 'Accept-Encoding: gzip, deflate, br' \
  -H 'sec-ch-ua: "Chromium";v="156", "Not_A Brand";v="24"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "Linux"' \
  -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-User: ?1' -H 'Sec-Fetch-Dest: document' \
  -H 'Upgrade-Insecure-Requests: 1' \
  -H 'Referer: https://checkcc.org/' \
  "https://api.checkcc.org/check?region=cn&lang=en-US&t=$(date +%s)000"
