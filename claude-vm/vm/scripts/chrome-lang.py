#!/usr/bin/env python3
# chrome-lang.py — 让 Chrome 发出的 Accept-Language 与所选地区一致，并真实测量它
#
# 为什么需要它：`--lang=zh-TW` 只改 Chrome 的 UI 语言，不会重写**已存在** Profile 的
# `intl.accept_languages`。实测 1.0.24 里系统已是 zh_TW.UTF-8、--lang 也已是 zh-TW，
# 但 Profile 里仍然是 `en-US,en` —— 登录 claude.ai 那一刻浏览器说的是美国，系统与浏览器打架。
#
# 三种用法：
#   --set     把 Preferences 的 accept_languages / selected_languages 改成期望值（原子写、幂等）
#   --verify  真实测量：复制真实 Profile 到临时 user-data-dir，headless Chrome 访问本地回显
#             服务，读回它实际发出的 Accept-Language；Chrome 不可用时降级为静态读 Preferences
#   --shell   同 --verify，但输出 4 行纯值，方便 bash 用 mapfile 读取
#   --show    只输出当前 Profile 里的静态值
#
# 零外部依赖，只用标准库。语言映射跟着 entrypoint 写入 runtime-env 的 LANG 走。

import html as htmlmod
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading

PROFILE_DIR = '/root/.config/google-chrome/Default'
PREFS = PROFILE_DIR + '/Preferences'
CHROME = 'google-chrome-stable'

# locale 前缀 -> (BCP47, 写进 Preferences 的纯语言标签, Chrome 生成后的期望请求头)
# 坑（实测踩到）：intl.accept_languages 是「语言标签列表」，q 权重由 Chrome 自己生成。
# 若写 `zh-TW,zh;q=0.9,...`，Chrome 会把 `zh;q=0.9` 当成一个语言条目再叠一层 q，
# 实测发出 `zh;q=0.9;q=0.8` 这种畸形头 —— 比原来的 en-US 更像伪造。
# 原 Profile 的值就是 `en-US,en`，不带任何权重。
LANGS = {
    'zh_TW': ('zh-TW', 'zh-TW,zh,en-US,en', 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'),
    'ja_JP': ('ja-JP', 'ja-JP,ja,en-US,en', 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'),
    'de_DE': ('de-DE', 'de-DE,de,en-US,en', 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'),
    'en_GB': ('en-GB', 'en-GB,en,en-US',    'en-GB,en;q=0.9,en-US;q=0.8'),
    'en_US': ('en-US', 'en-US,en',          'en-US,en;q=0.9'),
}


def expected():
    lang = os.environ.get('LANG') or os.environ.get('LC_ALL') or ''
    key = lang.split('.')[0][:5]
    return LANGS.get(key, LANGS['en_US'])


def load_prefs():
    try:
        with open(PREFS, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def static_header():
    return (load_prefs().get('intl') or {}).get('accept_languages') or ''


def header_ok(header, bcp47):
    """真实请求头是否合格：首选语言对，且没有重复叠加的 q 权重。"""
    if not header or not header.lower().startswith(bcp47.lower()):
        return False, '首选语言不是 %s' % bcp47
    for seg in header.split(','):
        if seg.count(';q=') > 1:
            return False, '请求头出现重复 q 权重（Preferences 被写成带权重的字符串）'
    return True, ''


def do_set():
    bcp47, pref, want = expected()
    d = load_prefs()
    old = (d.get('intl') or {}).get('accept_languages') or ''
    intl = d.setdefault('intl', {})
    intl['accept_languages'] = pref
    intl['selected_languages'] = pref
    # 避免复制出来的 Profile 因上次异常退出而弹「恢复页面」，影响 headless 测量
    prof = d.setdefault('profile', {})
    prof['exit_type'] = 'Normal'
    prof['exited_cleanly'] = True
    os.makedirs(PROFILE_DIR, exist_ok=True)
    tmp = PREFS + '.claude-vm.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, separators=(',', ':'))
    os.chmod(tmp, 0o600)
    os.replace(tmp, PREFS)
    # Chrome 正在运行时会在退出时用内存里的值覆盖磁盘；如实回报，让调用方提示重启浏览器
    running = subprocess.run(['pgrep', '-x', 'chrome'],
                             capture_output=True).returncode == 0
    return {'ok': True, 'bcp47': bcp47, 'pref': pref, 'expected_header': want,
            'changed': old != pref, 'previous': old,
            'chrome_running': running}


def do_verify():
    bcp47, pref, want = expected()
    static = static_header()
    measured = ''
    detail = ''
    srv = None
    tmp = None
    try:
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != '/':
                    self.send_response(204)
                    self.end_headers()
                    return
                v = self.headers.get('Accept-Language', '')
                body = ('<!doctype html><html><body><pre id="al">'
                        + htmlmod.escape(v) + '</pre></body></html>').encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        srv = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        tmp = tempfile.mkdtemp(prefix='claude-vm-chrome-')
        default = os.path.join(tmp, 'Default')
        os.makedirs(default, exist_ok=True)
        # 用真实 Profile 的副本：测出来的头就是登录时真正会发出的头
        if os.path.isfile(PREFS):
            shutil.copyfile(PREFS, os.path.join(default, 'Preferences'))
        url = 'http://127.0.0.1:%d/' % srv.server_port
        cmd = [CHROME, '--headless=new', '--no-sandbox', '--disable-gpu',
               '--disable-dev-shm-usage', '--no-first-run',
               '--no-default-browser-check', '--disable-background-networking',
               '--user-data-dir=' + tmp, '--lang=' + bcp47,
               '--dump-dom', url]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        m = re.search(r'<pre id="al">(.*?)</pre>', r.stdout, re.S)
        if m:
            measured = htmlmod.unescape(m.group(1)).strip()
        else:
            detail = 'headless 未返回回显页 (rc=%s)' % r.returncode
    except Exception as e:
        detail = 'headless 测量不可用：%s' % type(e).__name__
    finally:
        try:
            if srv:
                srv.shutdown()
                srv.server_close()
        except Exception:
            pass
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)

    mode = 'measured' if measured else 'static'
    header = measured or static
    ok, why = header_ok(header, bcp47)
    if not detail:
        detail = 'headless 实测' if mode == 'measured' else '静态读 Profile'
    if why:
        detail = why
    return {'ok': bool(header), 'mode': mode, 'header': header,
            'expected': want, 'pref': pref, 'bcp47': bcp47,
            'match': ok, 'static': static, 'detail': detail}


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else '--verify'
    if arg == '--set':
        out = do_set()
    elif arg == '--show':
        print(static_header())
        return
    else:
        out = do_verify()
    if arg == '--shell':
        print(out.get('mode', 'error'))
        print(out.get('header', ''))
        print('true' if out.get('match') else 'false')
        print(str(out.get('detail', '')).replace('\n', ' '))
    else:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
