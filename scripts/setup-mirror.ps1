# 一键配置国内镜像（npm 源 + GitHub 克隆加速），替代 dev-sidecar 这类常驻代理软件
#
# 用法（PowerShell）：
#   powershell -File scripts/setup-mirror.ps1                # 配置（默认 ghfast 镜像）
#   powershell -File scripts/setup-mirror.ps1 -Mirror ghproxy # 换备用镜像
#   powershell -File scripts/setup-mirror.ps1 -Reset          # 全部还原成官方地址
#
# 为什么不装 dev-sidecar：
#   它要在系统里装自签根证书做 HTTPS 中间人，并把流量转给第三方加速节点和镜像站，
#   你的 Cookie / Token / 代码都要交给别人过一遍。这里只做"换源"，流量仍然直达官方，
#   不装证书、不改系统代理、不常驻进程，对这台低配机器也没有额外开销。
#
# 安全性设计（重点）：
#   1. 镜像只用于「拉取」：正常写 https://github.com/... 仍是直连，不会走镜像
#   2. 想加速时才用 https://gh.fs/ 这个假域名前缀（git 会自动替换成镜像地址）
#   3. 额外配了 pushInsteadOf：万一 remote 是镜像地址，push 时会被强制改回官方地址，
#      代码永远不会经过第三方服务器上行

param(
    [ValidateSet('ghfast', 'ghproxy')]
    [string]$Mirror = 'ghfast',
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

# 镜像前缀表：失效时换一个再跑一遍即可（实测 ghfast 与 gh-proxy 可用）
$mirrors = @{
    ghfast  = 'https://ghfast.top/https://github.com/'
    ghproxy = 'https://gh-proxy.com/https://github.com/'
}
$mirrorUrl = $mirrors[$Mirror]
$official  = 'https://github.com/'
$shortcut  = 'https://gh.fs/'          # 触发镜像的短域名（只在本地生效）
$testRepo  = 'halcyon0207/my-trae_projects.git'  # 用于连通性自检

function Remove-MirrorConfig {
    foreach ($m in $mirrors.Values) {
        git config --global --unset "url.$m.insteadOf"     2>$null
        git config --global --unset "url.$official.pushInsteadOf" 2>$null
    }
    git config --global --unset alias.gcl 2>$null
}

Write-Host '== 1/3 npm 源 ==' -ForegroundColor Cyan
if ($Reset) {
    npm config delete registry
    Write-Host '  → 已还原为官方源 https://registry.npmjs.org/'
} else {
    npm config set registry https://registry.npmmirror.com
    Write-Host "  → $(npm config get registry)"
}

Write-Host '== 2/3 git 镜像 ==' -ForegroundColor Cyan
if ($Reset) {
    Remove-MirrorConfig
    Write-Host '  → 已清除镜像相关配置，恢复直连 GitHub'
} else {
    Remove-MirrorConfig
    git config --global "url.$mirrorUrl.insteadOf" $shortcut
    git config --global "url.$official.pushInsteadOf" $mirrorUrl
    git config --global alias.gcl "!git clone $mirrorUrl"
    Write-Host "  → 镜像：$mirrorUrl"
}

Write-Host '== 3/3 连通性自检 ==' -ForegroundColor Cyan
if ($Reset) {
    Write-Host '完成，已全部还原。' -ForegroundColor Green
    exit 0
}

git ls-remote "https://gh.fs/$testRepo" HEAD 2>&1 | Out-String -OutVariable out | Out-Null
if ($LASTEXITCODE -ne 0 -or -not $out) {
    Write-Host "镜像 $Mirror 连不通，换一个试试：powershell -File scripts/setup-mirror.ps1 -Mirror ghproxy" -ForegroundColor Yellow
    exit 1
}
Write-Host "  → 镜像可用：$($out.Trim())" -ForegroundColor Green

Write-Host ''
Write-Host '完成。日常用法：' -ForegroundColor Green
Write-Host '  加速克隆： git gcl 用户名/仓库名.git       （或 git clone https://gh.fs/用户名/仓库名.git）' -ForegroundColor Gray
Write-Host '  正常推送： git push                        （自动走官方地址，不经镜像）' -ForegroundColor Gray
Write-Host '  安装包：   npm i                           （已走 npmmirror）' -ForegroundColor Gray
