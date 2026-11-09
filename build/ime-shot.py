#!/usr/bin/env python3
# X11 root 窗口截屏（GdkPixbuf），输出 PNG
import sys
import gi
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk

out = sys.argv[1]
root = Gdk.get_default_root_window()
w, h = root.get_width(), root.get_height()
pb = Gdk.pixbuf_get_from_window(root, 0, 0, w, h)
if pb is None:
    print('screenshot failed')
    sys.exit(1)
pb.savev(out, 'png', [], [])
print('saved %s %dx%d' % (out, w, h))
