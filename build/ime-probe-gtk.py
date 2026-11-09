#!/usr/bin/env python3
# GTK3 IMContext 探针：把 fcitx5 交给应用的 preedit / commit 原样写进日志。
# 不放 GtkEntry（它自带 IMContext 会抢焦点），只用一个自建 Gtk.IMMulticontext。
import time
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

LOG = '/tmp/ime-preedit.log'


def w(msg):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write('%.3f %s\n' % (time.time(), msg))


win = Gtk.Window(title='IME-PROBE')
win.set_default_size(420, 120)
win.set_events(Gdk.EventMask.KEY_PRESS_MASK | Gdk.EventMask.KEY_RELEASE_MASK)
area = Gtk.DrawingArea()
win.add(area)
win.show_all()
win.present()

im = Gtk.IMMulticontext()


def on_preedit_changed(ctx):
    s, attrs, cur = ctx.get_preedit_string()
    w('PREEDIT-CHANGED str=%r cursor=%d' % (s, cur))


im.connect('preedit-changed', on_preedit_changed)
im.connect('preedit-start', lambda c: w('PREEDIT-START'))
im.connect('preedit-end', lambda c: w('PREEDIT-END'))
im.connect('commit', lambda c, s: w('COMMIT %r' % s))


im.set_client_window(win.get_window())
im.focus_in()
delegate = im.get_delegate() if hasattr(im, 'get_delegate') else None
w('IM-READY delegate=%s' % (type(delegate).__name__ if delegate else 'none'))


def on_key(widget, event):
    handled = im.filter_keypress(event)
    w('KEY keyval=%s state=%s im_handled=%s' % (event.keyval, event.state, handled))
    return handled


win.connect('key-press-event', on_key)
win.connect('destroy', Gtk.main_quit)
w('START pid=%d' % __import__('os').getpid())
Gtk.main()
