FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# 国内 apt 镜像（加速；如需官方源可删掉这一行）
RUN sed -i -E 's@https?://(archive|security)\.ubuntu\.com@http://mirrors.ustc.edu.cn@g' /etc/apt/sources.list

# 基础桌面 + VNC + noVNC + 工具
#
# 关于字体：这里**故意不装** fonts-noto-cjk。
#   · 体积：光那一个包就有 200MB+，占了安装包很大一块；
#   · 观感：之前终端用 Noto Sans Mono CJK 当等宽字体，会给每个字符按全角算格子，
#           英文被撑成「一字符一格」的服务器控制台样子，根本没法读。
#   现在统一用 Fira Code（拉丁等宽，无连字陷阱）+ 系统自带 DejaVu 做界面字体。
RUN apt-get update && apt-get install -y --no-install-recommends \
    locales tzdata \
    openbox tint2 feh xterm pcmanfm x11-xserver-utils xauth \
    tigervnc-standalone-server tigervnc-common tigervnc-tools \
    novnc websockify xz-utils \
    fonts-firacode fonts-noto-color-emoji fonts-dejavu-core \
    git curl wget aria2 ca-certificates gnupg sudo dbus-x11 \
    openssh-client netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# 区域语言环境（en_US 必装；其余供地区预设使用）
RUN sed -i -E 's/^# *((en_US|en_GB|ja_JP|de_DE)\.UTF-8)/\1/' /etc/locale.gen \
    && locale-gen

# WSL 运行配置（导入为 WSL 发行版时自动挂载 Windows 盘符，供工作区使用）
RUN printf '[automount]\nenabled = true\nroot = /mnt/\noptions = "metadata,umask=22,fmask=11"\n\n[interop]\nenabled = true\nappendWindowsPath = false\n' > /etc/wsl.conf

# Node.js 20（npmmirror 国内镜像，避免 nodesource 慢）
RUN aria2c -x8 -s8 -q -d /tmp -o node.tar.xz https://npmmirror.com/mirrors/node/v20.18.1/node-v20.18.1-linux-x64.tar.xz \
    && mkdir -p /usr/local/lib/nodejs \
    && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
    && ln -sf /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/node /usr/local/bin/node \
    && ln -sf /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/npm /usr/local/bin/npm \
    && ln -sf /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/npx /usr/local/bin/npx \
    && rm -f /tmp/node.tar.xz \
    && node -v && npm -v

# Google Chrome（真实 UA，用于容器内 claude.ai 登录）
RUN aria2c -x16 -s16 -k1M -q -d /tmp -o chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI（官方包，走 npmmirror 镜像）
# 装完立刻清干净：npm 更新失败会留下 @anthropic-ai/.claude-code-XXXXXXXX 暂存目录，
# node 头文件和 npm 缓存同样只在构建时有用。
# 注意：包里的 bin/claude.exe 就是 ~245MB 的原生二进制本体（后缀虽叫 .exe），
#       千万别按后缀删它，否则入口就断了。
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /usr/local/lib/nodejs/*/lib/node_modules/@anthropic-ai/.claude-code-* \
    && rm -rf /usr/local/lib/nodejs/*/include \
    && npm cache clean --force \
    && rm -rf /root/.npm /root/.cache \
    && rm -rf /usr/share/doc/* \
    && ls -l /usr/local/lib/nodejs/*/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe

# 脚本与桌面资源（主题 / 启动器 / 串流页面 / 欢迎页）
COPY scripts/ /opt/scripts/
COPY config/ /opt/config/
COPY config/themes/Claude /usr/share/themes/Claude
RUN chmod +x /opt/scripts/*.sh \
    && cp /opt/config/apps/*.desktop /usr/share/applications/ 2>/dev/null || true

# 默认区域（运行时可被 -e / wsl env 覆盖）
ENV TZ=America/New_York
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV PATH=/usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin:$PATH

EXPOSE 6080 5901 7890
ENTRYPOINT ["/opt/scripts/entrypoint.sh"]
