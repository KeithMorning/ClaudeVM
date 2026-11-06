// 地区预设：TZ / 语言 / Chrome 语言 / 备注
// 选一个与你的代理出口地区一致的预设，check-cc 的信号一致性才过关
module.exports = {
  'us-east': { tz: 'America/New_York',     lang: 'en_US.UTF-8', chromeLang: 'en-US', note: '美国东部' },
  'us-west': { tz: 'America/Los_Angeles',  lang: 'en_US.UTF-8', chromeLang: 'en-US', note: '美国西部' },
  'uk':      { tz: 'Europe/London',        lang: 'en_GB.UTF-8', chromeLang: 'en-GB', note: '英国' },
  'jp':      { tz: 'Asia/Tokyo',           lang: 'ja_JP.UTF-8', chromeLang: 'ja-JP', note: '日本' },
  'de':      { tz: 'Europe/Berlin',        lang: 'de_DE.UTF-8', chromeLang: 'de-DE', note: '德国' },
  'sg':      { tz: 'Asia/Singapore',       lang: 'en_SG.UTF-8', chromeLang: 'en-SG', note: '新加坡' },
};
