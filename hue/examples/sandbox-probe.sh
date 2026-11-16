#!/bin/sh
# 沙箱能力对照实验：同一组"一个子进程能碰到什么"的探针，分别在四种环境里跑。
# 证据文档：docs/research/sandbox-evidence.md。全部在 /tmp/hue-sandbox-probe 里做，不碰真实项目，脚本不删除任何东西。
# 每次运行会在 project/ 里留下 in-typed.txt、in-real.txt（同名覆盖），想清理请自己看过后再删。
#
#   sh examples/sandbox-probe.sh            # 跑全部（没有 docker 就跳过第 4 项）
#
# 每一项输出两行：能不能读到环境变量里的"密钥"，能不能读到项目目录之外的文件；
# 第 3 项另外测"能不能写项目内 / 项目外"，并对比规则里写符号链接路径和真实路径的差别。
set -u
D=/tmp/hue-sandbox-probe
mkdir -p "$D/project" "$D/outside"
R=$(cd "$D" && pwd -P)                       # macOS: /tmp 是 /private/tmp 的符号链接，R 是真实路径
echo "PROJECT FILE" > "$D/project/a.txt"
echo "SECRET OUTSIDE" > "$D/outside/secret.txt"
export DEMO_API_KEY=sk-demo-not-a-real-key   # 假密钥，只用来看"有没有泄给子进程"
echo "typed path : $D"
echo "real path  : $R"
echo

echo "### 1. 普通子进程（继承身份和环境变量）"
( cd "$R/project" && sh -c 'echo "  env key      : [${DEMO_API_KEY:-<empty>}]"; echo "  read outside : $(cat ../outside/secret.txt 2>&1)"' )
echo

echo "### 2. Hue 的 local 模式（环境变量白名单 PATH/HOME/LANG，不隔离文件）"
( cd "$R/project" && env -i PATH="$PATH" HOME="$HOME" LANG=C sh -c 'echo "  env key      : [${DEMO_API_KEY:-<empty>}]"; echo "  read outside : $(cat ../outside/secret.txt 2>&1)"' )
echo

echo "### 3. macOS Seatbelt（sandbox-exec）：只允许写项目目录"
if command -v sandbox-exec >/dev/null 2>&1; then
  seatbelt() { # $1 = 写进规则的路径, $2 = 本次尝试的标记（文件名用，避免互相覆盖）
    printf '(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "%s/project"))\n(allow file-write* (literal "/dev/null"))\n' "$1" > "$D/profile-$2.sb"
    ( cd "$R/project" && sandbox-exec -f "$D/profile-$2.sb" sh -c "
      echo ok > in-$2.txt 2>/dev/null && echo '  write inside  : ok' || echo '  write inside  : DENIED'
      echo x > ../outside/out-$2.txt 2>/dev/null && echo '  write outside : SUCCEEDED' || echo '  write outside : denied'" )
  }
  echo " 规则里写符号链接路径 ($D)"; seatbelt "$D" typed
  echo " 规则里写真实路径 ($R)";     seatbelt "$R" real
else
  echo "  (没有 sandbox-exec，跳过)"
fi
echo

echo "### 4. Docker 容器（只挂载项目目录）"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CID=$(docker run -d --rm --init -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$R/project":/work -w /work node:22 sleep 60)
  docker exec "$CID" sh -c 'echo "  env key      : [${DEMO_API_KEY:-<empty>}]"; echo "  files in /work: $(ls /work)"; echo "  /Users exists: $([ -d /Users ] && echo yes || echo no)"; echo "  read outside : $(cat /work/../outside/secret.txt 2>&1 | head -1)"'
  echo "  docker exec x5 (秒):"; for i in 1 2 3 4 5; do /usr/bin/time -p docker exec "$CID" true 2>&1 | grep real; done | tr '\n' ' '; echo
  echo "  idle memory  : $(docker stats --no-stream --format '{{.MemUsage}}' "$CID")"
  docker stop -t 1 "$CID" >/dev/null 2>&1
else
  echo "  (没有可用的 docker，跳过)"
fi
