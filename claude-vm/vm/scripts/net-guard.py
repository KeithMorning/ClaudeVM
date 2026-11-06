#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
net-guard.py — 虚拟环境的网络层 fail-closed 守卫（路由级熔断）

为什么不用 iptables / ip：
    这个 rootfs 里既没有 iptables / nft，也没有 iproute2（连 `ip`、`route` 都没有）。
    但内核 capability 是全的（CapEff=000001ffffffffff，含 CAP_NET_ADMIN），
    Python3 又有 AF_NETLINK / NETLINK_ROUTE —— 于是直接跟内核对话改路由表，
    零外部依赖，不用重打 720MB 的 rootfs。

熔断原理（关键，别改成"检测到再断"）：
    WSL2 的路由表实测是
        default via 192.168.240.1 dev eth0
        192.168.240.0/24 dev eth0 scope link      <-- on-link，宿主代理就在这个网段
    删掉 default 后，所有非 on-link 目标内核直接返回 ENETUNREACH；
    而 on-link 那条仍在，宿主代理 192.168.240.1:7897 依然可达。
    也就是说**从一开始就只有代理这一条路**，代理不通时网络天然是断的，
    不存在"健康检查失败 -> 再去断网"这个时间窗，也不会降级直连。
    这才是真正的 fail-closed；靠定时器去补一条 DROP 规则都有泄漏窗口。

    代理若是公网 IP（不在 on-link 网段），则先补一条 /32 主机路由再删 default。

    IPv6 必须一起关：只封 IPv4 是最常见的泄漏口，流量会静静从 v6 直连出去。
    这里既写 sysctl，也删 v6 默认路由，双保险。

用法：
    net-guard.py status
    net-guard.py lock   <proxy-url>
    net-guard.py unlock

状态文件：/run/claude-vm/net-guard.orig（保存原始路由，供 unlock 精确还原）
"""
import json
import os
import socket
import struct
import sys

# ---- netlink 常量（避免依赖任何外部头文件）----
NETLINK_ROUTE = 0
RTM_NEWROUTE, RTM_DELROUTE, RTM_GETROUTE = 24, 25, 26
NLM_F_REQUEST, NLM_F_ACK = 0x01, 0x04
NLM_F_MULTI, NLM_F_CREATE, NLM_F_EXCL = 0x02, 0x400, 0x200
NLM_F_DUMP = 0x100 | 0x200
NLMSG_ERROR, NLMSG_DONE = 2, 3
RT_TABLE_MAIN = 254
RTN_UNICAST = 1
RT_SCOPE_UNIVERSE = 0
RTA_DST, RTA_OIF, RTA_GATEWAY, RTA_PRIORITY = 1, 4, 5, 6

STATE_DIR = '/run/claude-vm'
ORIG_FILE = os.path.join(STATE_DIR, 'net-guard.orig')
IPV6_PROCS = ('all', 'default', 'eth0')


# ------------------------------------------------------------
# netlink 原语
# ------------------------------------------------------------
def nlmsg(msg_type, flags, payload, seq=1):
    # pid 填 0：bind((0,0)) 由内核分配 portid，实测 WSL 上这样才稳定收到回包
    return struct.pack('=IHHII', 16 + len(payload), msg_type, flags, seq, 0) + payload


def rtmsg(family, dst_len, table=RT_TABLE_MAIN, protocol=3,
          scope=RT_SCOPE_UNIVERSE, rtype=RTN_UNICAST, flags=0):
    return struct.pack('=BBBBBBBBI', family, dst_len, 0, 0, table,
                       protocol, scope, rtype, flags)


def attr(atype, data):
    if isinstance(data, str):
        data = data.encode()
    length = 4 + len(data)
    return struct.pack('=HH', length, atype) + data + b'\x00' * ((-length) % 4)


def parse_attrs(body, off=12):
    out = {}
    while off + 4 <= len(body):
        alen, atype = struct.unpack_from('=HH', body, off)
        if alen < 4 or off + alen > len(body):
            break
        out.setdefault(atype, []).append(body[off + 4:off + alen])
        off += (alen + 3) & ~3
    return out


def nl_call(msg):
    """发一条 netlink 请求，返回 [('error', errno) | ('msg', (type, flags, body))]"""
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_ROUTE)
    s.bind((0, 0))
    s.settimeout(3)
    replies = []
    try:
        s.send(msg)
        while True:
            try:
                chunk = s.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            off, multi, stop = 0, False, False
            while off + 16 <= len(chunk):
                ln, typ, flg, seq, pid = struct.unpack_from('=IHHII', chunk, off)
                if ln < 16 or off + ln > len(chunk):
                    break
                body = chunk[off + 16:off + ln]
                off += ln
                if flg & NLM_F_MULTI:
                    multi = True
                if typ == NLMSG_ERROR:
                    errno = struct.unpack_from('=i', body, 0)[0] if len(body) >= 4 else -1
                    # errno = 0 是内核对 NLM_F_ACK 的正常确认
                    replies.append(('error', -errno if errno < 0 else 0))
                    if not multi:
                        stop = True
                elif typ == NLMSG_DONE:
                    stop = True
                else:
                    replies.append(('msg', (typ, flg, body)))
            if stop or not multi:
                break
    finally:
        s.close()
    return replies


def check_ack(replies, ignore_exist=False):
    """返回错误字符串，成功返回 None"""
    errs = [e for k, e in replies if k == 'error' and e != 0]
    if ignore_exist:
        errs = [e for e in errs if e != 17]  # EEXIST：目标路由已存在，幂等场景不算错
    if errs:
        return os.strerror(errs[0]) + f' (errno={errs[0]})'
    if not any(k == 'error' for k, _ in replies):
        return '内核无响应（CAP_NET_ADMIN 不足或 netlink 被拦截）'
    return None


def dump_routes(family=socket.AF_INET):
    msg = nlmsg(RTM_GETROUTE, NLM_F_REQUEST | NLM_F_DUMP, rtmsg(family, 0))
    routes = []
    for kind, val in nl_call(msg):
        if kind != 'msg':
            continue
        typ, flg, body = val
        if typ != RTM_NEWROUTE or len(body) < 12:
            continue
        fam, dst_len, src_len, tos, table, proto, scope, rtype, rflags = \
            struct.unpack_from('=BBBBBBBBI', body, 0)
        a = parse_attrs(body)
        gw = None
        if RTA_GATEWAY in a and len(a[RTA_GATEWAY][0]) >= 4:
            try:
                gw = socket.inet_ntop(fam, a[RTA_GATEWAY][0][:16 if fam == socket.AF_INET6 else 4])
            except (OSError, ValueError):
                gw = None
        dst = None
        if RTA_DST in a and len(a[RTA_DST][0]) >= 4:
            try:
                dst = socket.inet_ntop(fam, a[RTA_DST][0][:16 if fam == socket.AF_INET6 else 4])
            except (OSError, ValueError):
                dst = None
        oif = struct.unpack_from('=I', a[RTA_OIF][0], 0)[0] if RTA_OIF in a else None
        routes.append(dict(family=fam, dst_len=dst_len, dst=dst, gw=gw,
                           table=table, protocol=proto, scope=scope,
                           rtype=rtype, flags=rflags, oif=oif, attrs=a))
    return routes


def defaults(family=socket.AF_INET):
    return [r for r in dump_routes(family)
            if r['dst_len'] == 0 and r['table'] == RT_TABLE_MAIN and r['rtype'] == RTN_UNICAST]


# ------------------------------------------------------------
# 路由增删
# ------------------------------------------------------------
def delete_default(family=socket.AF_INET):
    """删掉主表里所有默认路由。复用 dump 出来的完整属性，避免匹配不上。"""
    errs = []
    for r in defaults(family):
        payload = struct.pack('=BBBBBBBBI', family, r['dst_len'], 0, 0,
                              r['table'], r['protocol'], r['scope'], r['rtype'], r['flags'])
        for at in (RTA_GATEWAY, RTA_OIF, RTA_PRIORITY):
            if at in r['attrs']:
                payload += attr(at, r['attrs'][at][0])
        rep = nl_call(nlmsg(RTM_DELROUTE, NLM_F_REQUEST | NLM_F_ACK, payload))
        e = check_ack(rep)
        if e:
            errs.append(e)
    return errs


def add_default(family, gw, oif, protocol=3, scope=RT_SCOPE_UNIVERSE, table=RT_TABLE_MAIN):
    payload = rtmsg(family, 0, table=table, protocol=protocol, scope=scope)
    payload += attr(RTA_GATEWAY, socket.inet_pton(family, gw))
    if oif:
        payload += attr(RTA_OIF, struct.pack('=I', oif))
    msg = nlmsg(RTM_NEWROUTE, NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, payload)
    return check_ack(nl_call(msg), ignore_exist=True)


def add_host_route(ip, gw, oif):
    family = socket.AF_INET6 if ':' in ip else socket.AF_INET
    bits = 128 if family == socket.AF_INET6 else 32
    payload = rtmsg(family, bits)
    payload += attr(RTA_DST, socket.inet_pton(family, ip))
    payload += attr(RTA_GATEWAY, socket.inet_pton(family, gw))
    if oif:
        payload += attr(RTA_OIF, struct.pack('=I', oif))
    msg = nlmsg(RTM_NEWROUTE, NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, payload)
    return check_ack(nl_call(msg), ignore_exist=True)


def ip_in_network(ip, network, bits):
    try:
        fam = socket.AF_INET6 if ':' in ip else socket.AF_INET
        a = socket.inet_pton(fam, ip)
        b = socket.inet_pton(fam, network)
        n = bits // 8
        if a[:n] != b[:n]:
            return False
        rem = bits % 8
        return rem == 0 or (a[n] >> (8 - rem)) == (b[n] >> (8 - rem))
    except (OSError, ValueError):
        return False


def is_onlink(ip, routes):
    for r in routes:
        if r['dst_len'] > 0 and not r['gw'] and r['dst']:
            if ip_in_network(ip, r['dst'], r['dst_len']):
                return True
    return False


def set_ipv6_disabled(value):
    ok = True
    for name in IPV6_PROCS:
        p = f'/proc/sys/net/ipv6/conf/{name}/disable_ipv6'
        try:
            with open(p, 'w') as f:
                f.write('1\n' if value else '0\n')
        except OSError:
            ok = False
    return ok


def ipv6_disabled():
    try:
        with open('/proc/sys/net/ipv6/conf/all/disable_ipv6') as f:
            return f.read().strip() == '1'
    except OSError:
        return False


# ------------------------------------------------------------
# 命令
# ------------------------------------------------------------
def parse_proxy_host(url):
    """从 http://host:port / socks5://host:port 中取出 host；支持 IPv6 字面量。"""
    s = (url or '').strip()
    if '://' in s:
        s = s.split('://', 1)[1]
    s = s.rstrip('/')
    if '@' in s:
        s = s.rsplit('@', 1)[1]
    if s.startswith('['):
        return s[1:s.index(']')]
    return s.rsplit(':', 1)[0] if ':' in s else s


def resolve_ip(host):
    """封锁前解析域名；IP 字面量直接返回。"""
    for fam in (socket.AF_INET, socket.AF_INET6):
        try:
            return socket.inet_pton(fam, host) and host
        except OSError:
            pass
    try:
        return socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    except OSError as e:
        raise RuntimeError(f'代理域名 {host} 解析失败：{e}')


def cmd_status():
    v4 = defaults(socket.AF_INET)
    v6 = defaults(socket.AF_INET6)
    onlink = [dict(dst=r['dst'], bits=r['dst_len'])
              for r in dump_routes(socket.AF_INET)
              if r['dst_len'] > 0 and not r['gw'] and r['dst']]
    return dict(
        locked=len(v4) == 0,
        default_v4=v4[0]['gw'] if v4 else None,
        default_v4_oif=v4[0]['oif'] if v4 else None,
        default_v6=v6[0]['gw'] if v6 else None,
        ipv6_disabled=ipv6_disabled(),
        onlink=onlink,
    )


def cmd_lock(proxy_url):
    host = parse_proxy_host(proxy_url)
    if not host:
        return dict(ok=False, error='代理地址为空')
    try:
        proxy_ip = resolve_ip(host)
    except RuntimeError as e:
        return dict(ok=False, error=str(e))

    v4 = defaults(socket.AF_INET)
    v6 = defaults(socket.AF_INET6)
    if not v4:
        # 已经锁过了：只做 re-assert（IPv6 / 主机路由），不重复删
        st = cmd_status()
        set_ipv6_disabled(True)
        if v6:
            delete_default(socket.AF_INET6)
        return dict(ok=True, already=True, **st)
    gw, oif = v4[0]['gw'], v4[0]['oif']
    if not gw:
        return dict(ok=False, error='默认路由没有网关，无法安全熔断（不确定代理怎么走）')

    routes = dump_routes(socket.AF_INET)
    onlink = is_onlink(proxy_ip, routes)
    saved = dict(
        v4=dict(gw=gw, oif=oif, protocol=v4[0]['protocol'], scope=v4[0]['scope'],
                table=v4[0]['table']),
        v6=[dict(gw=r['gw'], oif=r['oif'], protocol=r['protocol'],
                 scope=r['scope'], table=r['table']) for r in v6 if r['gw']],
        proxy_ip=proxy_ip, onlink=onlink,
        ipv6_disabled_before=ipv6_disabled(),
    )

    # 顺序有讲究：先保证代理可达，再断默认，最后封 v6。
    if not onlink:
        err = add_host_route(proxy_ip, gw, oif)
        if err:
            return dict(ok=False, error=f'补代理主机路由失败：{err}')

    errs = delete_default(socket.AF_INET)
    if errs:
        # 熔断失败必须如实失败，绝不能假装成功继续启动
        if not onlink:
            _ = None  # /32 留着无害，且删掉反而更危险
        return dict(ok=False, error=f'删除默认路由失败：{"; ".join(errs)}')

    if v6:
        e6 = delete_default(socket.AF_INET6)
        if e6:
            saved['v6_error'] = '; '.join(e6)
    set_ipv6_disabled(True)

    os.makedirs(STATE_DIR, exist_ok=True)
    with open(ORIG_FILE, 'w') as f:
        json.dump(saved, f)
    # 注意：cmd_status() 自己就带一个 onlink 键，不能再用 onlink= 传一次，
    # 否则 dict() 抛 "multiple values" —— 路由其实已经改完了，却对外报成失败。
    st = cmd_status()
    st.update(ok=True, already=False, proxy_ip=proxy_ip, proxy_onlink=onlink)
    return st


def cmd_unlock():
    try:
        with open(ORIG_FILE) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return dict(ok=False, error='没有找到原始路由记录，无法还原（可在 Windows 执行 wsl --shutdown 重建网络；新版启动已不依赖默认路由）')
    errs = []
    v4 = saved.get('v4') or {}
    if v4.get('gw'):
        e = add_default(socket.AF_INET, v4['gw'], v4.get('oif'),
                        v4.get('protocol', 3), v4.get('scope', 0), v4.get('table', RT_TABLE_MAIN))
        if e:
            errs.append('v4: ' + e)
    for r in saved.get('v6', []):
        if r.get('gw'):
            e = add_default(socket.AF_INET6, r['gw'], r.get('oif'),
                            r.get('protocol', 3), r.get('scope', 0), r.get('table', RT_TABLE_MAIN))
            if e:
                errs.append('v6: ' + e)
    if not saved.get('ipv6_disabled_before', False):
        set_ipv6_disabled(False)
    try:
        os.remove(ORIG_FILE)
    except OSError:
        pass
    return dict(ok=not errs, error='; '.join(errs) or None, **cmd_status())


def main():
    cmd = (sys.argv[1] if len(sys.argv) > 1 else 'status').lower()
    try:
        if cmd == 'status':
            out = cmd_status()
        elif cmd == 'lock':
            if len(sys.argv) < 3:
                out = dict(ok=False, error='用法：net-guard.py lock <proxy-url>')
            else:
                out = cmd_lock(sys.argv[2])
        elif cmd == 'unlock':
            out = cmd_unlock()
        else:
            out = dict(ok=False, error=f'未知命令 {cmd}')
    except Exception as e:  # noqa: BLE001 —— 熔断脚本出错必须给结构化结果，不能让 shell 拿到半截输出
        out = dict(ok=False, error=f'{type(e).__name__}: {e}')
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get('ok', cmd == 'status') else 1


if __name__ == '__main__':
    sys.exit(main())
